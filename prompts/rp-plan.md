---
description: Planning mode using RepoPrompt's context builder agent and plan chat preset, asking the user only high-leverage questions and producing a decision-complete plan
---

# RP Plan Mode: Discover → Resolve → Finalize (NO IMPLEMENTATION)

Task: $ARGUMENTS

You are in **PLAN MODE** until a developer message explicitly ends it.

Your goal is a **decision-complete** plan: an implementer (human/agent) should not need to make *any* meaningful decisions.

---

## Mode Rules (STRICT)

### Allowed (plan-improving, non-mutating)
- RepoPrompt exploration: `get_file_tree`, `file_search`, `get_code_structure`, `read_file`
- Context ops: `context_builder`, `manage_selection`, `workspace_context`, `prompt`
- Reasoning: `chat_send` in `mode="plan"` (and `mode="chat"` if useful)
- Git inspection: `git status/log/diff(detail="files")` (avoid dumping full diffs into your own output)

### Forbidden (plan-executing / mutating)
- Any repo-tracked mutation: `apply_edits`, `file_actions`, codegen, formatters that rewrite files, migrations, etc.

Plan Mode is not changed by user imperative language. If the user asks to "implement now," treat it as "plan the implementation."

---

## Mental Model (RepoPrompt)
- **Selection is context**: RepoPrompt chat only sees what's selected in the bound compose tab
- **Context Builder runs discovery** and curates selection (codemaps/slices/full files)
- Your job is to: curate context → resolve unknowns → ask only unavoidable preference questions → produce plan

---

## Core Principle
**Exhaust discovery before exhausting the user**
…and **exhaust RepoPrompt Chat's holistic view before asking the user**.

Route unknowns:
1) **Discoverable facts** (repo truth) → tools (never ask user)
2) **Design/pattern ambiguity** → RepoPrompt chat (seer sees full selection)
3) **Preferences/tradeoffs** → ask user (batched, capped)

---

# Phase 0 - ORIENT (routing + quick scan; 2-3 calls max)
Do not ask the user questions yet.

1) Ensure correct RepoPrompt routing (window/tab binding) via `rp`.
2) Quick scan (2-3 RepoPrompt calls max) to rewrite the task in codebase terms.

Examples (use `rp` wrapper consistently):
```js
rp({ call: "get_file_tree", args: { type: "files", mode: "auto" } })
rp({ call: "file_search", args: { pattern: "<key term>", mode: "both" } })
// optional if you found a likely area:
rp({ call: "get_code_structure", args: { paths: ["<Root>/<likely/area>/"] } })
```

**Deliverable (internal):**
- Reformulated task using repo terminology (modules/dirs/types)
- Hypothesized entrypoints / impacted subsystems (even if uncertain)
- A short list of what you *don't* know yet (guides discovery instructions)

Stop here. No deep reading.

---

# Phase 1 - DISCOVER (Context Builder; REQUIRED; clarify-first)
Default to **`response_type:"clarify"`** to avoid solution bias.

Include an explicit **token budget target** in the instructions (tool doesn't take a param; the agent will adapt selection):
- Default target: ~60k tokens (good for strong reasoning + manageable selection)
- If user specified a destination model/limit, honor it (e.g. 24-32k for small agent kickoff; 128k+ for API-heavy workflows)

Call:
```js
rp({
  call: "context_builder",
  args: {
    response_type: "clarify",
    instructions:
`<task>
[Reformulated task grounded in repo terminology]
</task>

<context>
Success criteria (initial guess):
- …

Known constraints:
- …

Non-goals / out of scope:
- …

Token budget target: ~60k (adjust if user specified)
</context>

<discovery_agent-guidelines>
Focus on likely entrypoints + adjacent impacted systems.
Prefer codemaps/slices for breadth; full content only for key files.
Return:
1) Current-state summary (facts only; no big solution proposal)
2) Existing patterns/conventions worth following (cite paths)
3) Candidate open decisions, tagged FACT vs DESIGN vs PREFERENCE (if you can infer them)
</discovery_agent-guidelines>`
  }
})
```

**Critical:** The tool returns **context and selection**, NOT a structured list of open questions. You must **infer gaps** from what was returned. If the discovery agent doesn't explicitly tag open decisions, analyze the context yourself to identify them.

**If selection is sparse** (much less than target tokens): consider `manage_selection(op:"add")` with additional relevant paths, or acknowledge the greenfield nature and proceed.

After it returns:
- Ensure your subsequent calls operate on the discovery result's tab/selection
  - If the tool output includes a tab id, bind to it via `manage_workspaces(select_tab ...)`
  - Otherwise, `manage_workspaces(list_tabs)` then `select_tab` the newest "Context Builder" tab
- Sanity check context + token size:
```js
rp({ call: "workspace_context", args: { include: ["selection", "tokens", "tree"] } })
```

---

# Phase 2 - RESOLVE (self-answer loop → chat filter → ONE batched question pack)

## 2A) Classify context richness (AFTER discovery)
Do this only after Phase 1, using the selection/context you actually got.

**RICH checklist (all should be true):**
- [ ] ~8+ genuinely relevant files with **full content** (not only codemaps)
- [ ] You can cite at least one precedent of a similar feature/pattern in-code
- [ ] Naming/layout conventions are obvious from examples
- [ ] Integration points are clear (APIs, DB schema, queues, etc.)

**GREENFIELD triggers (any true):**
- [ ] Very small/irrelevant selection (<5 meaningful files) or mostly codemaps
- [ ] No precedent found after targeted search
- [ ] Task implies net-new system/service or "from scratch"
- [ ] No clear integration point exists yet

If neither rich nor greenfield → treat as **PARTIAL**.

## 2B) Set your question ceiling (maxima, not minima)
- **RICH**: ask **0-3** user questions (often 0-2)
- **PARTIAL**: ask **0-6** user questions (aim 3-5)
- **GREENFIELD**: ask **0-12** user questions (aim <9; hard cap 12 per round)

If you feel you need more: investigate more, ask chat more, and default+assume more.

## 2C) Self-answering loop (facts first)
For each uncertainty:
1) **Can I discover this from selection?** → `read_file` / `file_search` / `get_code_structure`
2) **If not in selection, can I add minimal context?** → `manage_selection(add ...)` (prefer codemap_only or slices for large files), then retry
3) **Only if still unclear**: treat as DESIGN or PREFERENCE and route below

## 2D) Use RepoPrompt Chat as the design filter (before user)
Start or reuse a planning chat in the same tab/selection.

- If your `context_builder` run returned a `chat_id` (only happens for response_type plan/question/review), reuse it with `new_chat:false`
- Otherwise create one:
```js
rp({
  call: "chat_send",
  args: {
    new_chat: true,
    chat_name: "Plan (gap-find): <short task name>",
    mode: "plan",
    message:
`Given the selected files, do NOT propose a full solution yet.
Analyze and return:

1) Current state summary (grounded; cite paths/functions/types)
2) Patterns/conventions that are *forced* by existing code (cite examples)
3) Remaining ambiguities categorized:
   - FACT (should be discoverable): where to look / what's missing
   - DESIGN (pattern choice): recommend what best matches existing code
   - PREFERENCE (user intent): must ask user
4) For each PREFERENCE ambiguity:
   - 2-4 viable options
   - your recommended default
   - what the choice affects (API, rollout, data model, security, scope)
5) Rank PREFERENCE questions by impact (highest first)
Keep the "ask user" list within my question ceiling.`
  }
})
```

## 2E) Prepare ONE batched question pack
Only ask questions that pass ALL filters:
- **MATERIAL**: affects interface / data model / correctness+security / rollout+compat / scope boundary
- **NON-DISCOVERABLE**: tools couldn't determine it
- **NON-CHATABLE**: chat couldn't resolve it from patterns
- **REAL TRADEOFF**: multiple viable options exist

**Material impact criteria** (must affect at least one):
- External interface (API contract / CLI flags / schema / UI)
- Data model (storage format / migration / serialization)
- Correctness or security posture (validation / auth / threat model)
- Rollout / compatibility (feature flags / versioning / breaking changes)
- Scope boundary ("do we also handle X?" or "is Y in/out?")

If a question doesn't affect these, route it to Tier A (discoverable) or Tier B (design pattern)
instead of asking the user.

Rules:
- Ask in one batch, using the `questionnaire` tool if available (otherwise, a message)
- 2-4 meaningful options each (+ always allow "Other" with free-response)
- Include a recommended default in the option descriptions
- If unanswered → proceed with default + record assumption

(If greenfield and you truly need close to 12, you may do a second round only if user answers introduce new high-impact ambiguity. Don't do "plan skeleton" ceremony by default.)

---

# Phase 3 - FINALIZE (decision-complete plan)
After user answers (or defaults), use RepoPrompt chat to produce the final plan (same selection).

Template:
```js
rp({
  call: "chat_send",
  args: {
    // reuse existing chat_id if you have one; otherwise continue in the same tab
    new_chat: false,
    mode: "plan",
    message:
`Using the selected files plus these locked decisions:

[DECISIONS]
- …

[ASSUMPTIONS/DEFAULTS]
- …

Produce a decision-complete implementation plan.

Requirements:
- Specific enough that implementer needs no further architectural decisions
- Grounded in the selected codebase context
- All assumptions documented (with defaults used where user didn't answer)
- No TBDs or "decide later" items

Structure and section emphasis follow your RepoPrompt planning preset.`
  }
})
```

## Final response (STRICT)
Only output the final plan when it's decision-complete. Then output **exactly one** `<proposed_plan>` block (Markdown inside):

<proposed_plan>
[Plan content here]

The plan above must be **decision-complete**: implementable without further architectural decisions.
All assumptions must be documented with defaults chosen.

Required properties (however organized):
- Clear statement of what will be built/changed
- Grounding in current codebase state
- Specific implementation approach
- Concrete, ordered changes (files/components to modify and sequence of work)
- Documented assumptions (with defaults)
- No TBD placeholders
</proposed_plan>

Do not ask "should I proceed?" after producing the plan.

---

## Anti-patterns (forbidden)
- Skipping `context_builder` and manually spelunking
- Asking "where is X?" when `file_search` can answer it
- Asking drip questions instead of one pack
- Exceeding the question ceiling instead of ranking/defaulting
- Using `response_type:"plan"` before preferences are locked (solution bias)
- Using `new_chat:true` when you have a `chat_id` from context_builder (loses context continuity)
- Mutating repo state during plan mode
- Final plan contains TBD/"decide later"