---
name: prose-review
description: Review prose written for others (e.g., user-facing documentation, prompts for other LLMs, reports, plans, inline comments, docstrings) for local jargon leakage, orphaned references, missing grounding, and audience or genre mismatch. Always run on prose you produce or materially edit, except for routine conversational messages (e.g., progress updates, confirmations, concise replies) and unchanged quoted text.
---

# Prose Review

Review prose written to be read by someone else for language that doesn't belong in text its intended reader will encounter, and for missing grounding that a cold reader would need. Fix problems directly.

The main in-scope forms are:

- **User-facing documentation**: READMEs, guides, reference docs, help text

- **Prompts for other LLMs**: skills, system prompts, agent instructions, handoffs, task briefs

- **Inline comments**: the `//` and `#` prose a maintainer reads next to the code

- **Docstrings**: function, class, and module documentation, including generated API docs

- **Other-facing messages**: issue or PR comments, status notes, release notes, messages, emails, and similar prose when the operator names them

The same failure modes run through all of them.

## First: name the reader

Before reviewing each file or standalone artifact, state in one line who reads it, what they are trying to do, what they can and cannot see, and what genre it is (user README, contributor or architecture doc, operator runbook, agent prompt, handoff, task brief, inline comment, docstring, message, email, issue comment). Every judgment below is relative to that reader and purpose, not to a generic "new reader." Implementation detail is correct in a contributor-facing architecture doc or an inline comment and wrong in a user README; "what changed" is correct in a changelog and wrong in reference docs. Do not strip detail that this file's actual reader needs.

The acid test for every artifact: could the intended reader use this text correctly for their purpose with only the text and any explicitly named, reachable dependencies, without access to the session, private plans, or other local material that informed the recent edits?

For prompts, handoffs, and task briefs: could a cold-start agent act correctly from this text and any explicitly named, reachable files, without access to the context window you currently have and without having to guess? For comments and docstrings: could a maintainer who can read the surrounding code, but who wasn't present when it was written, understand what this text is telling them?

Call this **operational closure**: every dependency needed to understand or act is either contained in the artifact or identified through a path or access method the recipient can actually use.

Then ask the second question, which decoding alone never answers: is this language **situationally appropriate** for that reader -- the right register, the right level of detail, the right thing to be saying at this point in the document? A sentence can be fully comprehensible to a README-reading human and still be badly designed for them.

## What to catch

### Leakage: wrong content is present

- **Implementation-plan language**: internal field names, spec edge-case notes, architecture references, phrases like "reserve the timestamp column" or "compact display buckets" that reflect how something was built rather than what a user or other agent sees

- **Changelog/diff language**: "does not change X", "deliberately preserves Y", "without affecting Z", "is intentionally out of scope" -- comparisons against a prior version the reader has no baseline for. In comments and docstrings this shows up as narrating the edit ("now also handles X", "moved from Y", "renamed for clarity") instead of describing the code as it currently stands. **Genre exception**: when the file under review is a changelog, release note, migration guide, task retrospective, planning doc, PR description, or a handoff or task brief whose purpose is to transmit current state and remaining work, this language may be the point of the document. Preserve necessary temporal deltas, and don't "fix" them into timeless prose. The test is never whether the text refers to a prior state; it is whether this reader opened this file expecting it to

- **Internal jargon**: type names, config key internals, data-flow descriptions that only matter to contributors

- **Agent/session artifacts**: review constraints, schema-version strategy, compatibility decisions leaked from planning conversations

- **Orphaned deixis**: "this", "that", "the above", "as discussed", "the same approach", "the earlier plan", "continue from here" -- context-dependent references whose referent lives in the authoring session or a private plan, not in the document; restate the referent or delete the reference. In comments this also covers pointers the reader cannot open: ticket numbers, plan filenames, review threads, "per the discussion"

### Omission: needed content is absent

- **Terms used as if defined**: project-specific terms, acronyms, and metric names that are load-bearing for the reader but defined nowhere the reader can see; the fix is a local definition or glossary entry, not deletion

- **Unreachable dependencies**: instructions that require files, systems, credentials, or steps the reader has no path to discover or perform from where they stand

- **Under-grounded prompts, handoffs, and task briefs**: missing task goal, inputs or paths, definitions, decision-relevant constraints or rationale, expected output, success criteria, or stop conditions; required dependencies that are neither included nor named in a reachable way. Anything that forces a cold-start recipient to guess or confabulate

- **Under-grounded comments and docstrings**: a comment that restates what the code plainly does while omitting the non-obvious constraint, invariant, or reason the code is shaped that way; a docstring that assumes caller context the caller cannot see (units, ownership, error behavior, what the caller must guarantee)

Omission failures are as common as leakage and harder to see, because the text reads fine to anyone who already has the context. Hunt for them by simulating the named reader, not by scanning for bad phrases. The appropriate fix for omission is often addition rather than removal.

### Misfit: content is present and comprehensible, but wrong for this reader here

- **Register mismatch**: engineering-internal voice in text a non-engineer reads; clipped note-taking style where a user needs a sentence; ceremony and hedging where a maintainer wants one line

- **Granularity mismatch**: exhaustive precision where the reader needs the shape of the thing, or a vague gesture where they need the exact flag, path, or value

- **Relevance mismatch**: accurate, defined, and decodable, but not what this reader needs at this point -- rationale nobody asked for, caveats that matter to three people, edge cases placed ahead of the common path

- **Order mismatch**: material arranged in the author's discovery order rather than the reader's need or dependency order, so the reader must carry unexplained terms until they pay off later

- **Answer-display mismatch**: text demonstrates that the author possesses all the relevant concepts but does not construct a usable path from the recipient's starting point. The expected terms are present, but hierarchy, prerequisites, emphasis, or a clear through-line are missing

Misfit is the failure mode that survives a careful leakage-and-omission pass, because every individual sentence is true, defined, and readable. Catch it by asking what the reader came to this file to do, and whether this paragraph helps them do it right now.

Also catch any other pragmatic perspective-taking error that produces poor recipient design. One common pattern resembles the "curse of knowledge" described by Colin Camerer, George Loewenstein, and Martin Weber: language models behave as though human or AI recipients share the current context window or ephemeral planning artifacts, then leak local jargon or omit grounding. Treat this as a serious recurring failure across user-facing and agent-facing prose.

Curse of knowledge is one lens, not the whole job. Recipient design (Sacks, Schegloff, and Jefferson; closely related to Bell's "audience design") covers the whole task of shaping an utterance for its actual recipient: not merely what they know, but what they came for, how much detail serves them, what register fits the situation, what they need first, and what they must be able to do afterward. Text can pass every shared-knowledge check and still answer a question the reader never asked, in a voice written for somebody else. Hold both lenses at once: "can this reader decode this?" and "is this the right thing to say to this reader, here?"

## What good prose looks like

In durable current-state documentation, describe the software as it stands rather than narrating the edit that produced it. In handoffs, changelogs, migration guides, task briefs, and similar transition artifacts, preserve temporal deltas when the recipient needs them to continue safely.

Each sentence should help the named reader use or understand the software today. Authoring-process trivia belongs in PRs, changelogs, issues, plans, or retrospectives. Decision-relevant rationale, constraints, and invariants belong wherever the recipient needs them to use, operate, or modify the system safely, including agent prompts, handoffs, contributor docs, comments, and docstrings.

Good prompts and handoffs are operationally closed: they restate the task, name the inputs and expected outputs, define any term the recipient cannot know, include decision-relevant constraints, give success and stop conditions, and identify every required external dependency through a readable path or usable access method. Present this material in the recipient's reading and execution order, not the authoring session's chronological order.

Good comments and docstrings explain what the code means to someone who can read the code but wasn't there when it was written: intent, invariants, and non-obvious why. They describe the code as it stands rather than the edit that produced it, and they gloss their own terms instead of pointing at tickets, plans, or conversations the reader cannot open.

Good explanations build an intelligible path from the reader's starting point to the model they need. Conceptual coverage is not a substitute for sequencing, emphasis, and omission.

As a secondary lens, consider whether the documentation mixes Diátaxis categories inappropriately -- e.g., reference-style field descriptions embedded in a tutorial flow, or explanation ("why") mixed into a how-to. Light touch here; don't restructure, just note when the mixing hurts clarity.

## Scope

$ARGUMENTS

**Default to the narrowest scope the operator named.** If they pointed at a change -- specific diff hunks, a staged diff, a named patch, "the comments I just added" -- review only the prose inside that change: the doc lines it touches, and the comments and docstrings inside its hunks. Do not drift into untouched prose elsewhere in the same file.

Review whole files only when the operator asks for files rather than a change ("review README.md", "review this whole skill", "audit every prompt in this directory").

If the operator supplies standalone prose directly, such as a message, email, handoff, or subagent prompt, treat the supplied text as the whole artifact unless they explicitly narrow the scope.

Read beyond the scope for *context*, never for edits. You usually need the surrounding file to tell whether a term is defined elsewhere, whether a reference has a local referent, or who the reader actually is. When you find a real problem outside the named scope, flag it in the summary with its location and leave it alone.

If the operator named paths but no change, review those files whole. If they named nothing at all, fall back to the current staged diff:

```bash
git diff --staged --name-only
```

Review the doc files in that list, plus the comments and docstrings inside the staged hunks of the source files. If nothing is staged, say so and stop.

Note the staged-diff fallback only sees the current repo. Prompts and skills often live elsewhere (e.g. `~/.agents/skills/*/SKILL.md`, `~/.pi/agent/prompts/*.md`) or are gitignored; those must be named explicitly by the operator to enter scope.

## Process

1. Resolve scope: a change (hunks only), whole files, or a supplied standalone artifact. State which in one line before you start.

2. For each artifact in scope, state its reader, their purpose, what they can and cannot see, and its genre. One line per file is enough for a hunk-scoped review; don't repeat it per hunk.

3. Review from two positions:

   - **Source-aware pass**: use the available session and project context to identify local jargon, private-plan residue, authoring-process artifacts, and other information that leaked across the audience boundary.

   - **Recipient-positioned pass**: use only the artifact and dependencies explicitly reachable by the named reader. Do not let source-only knowledge rescue an unclear referent, missing definition, absent constraint, or unreachable dependency. Explicitly identify assumptions the recipient would have to invent. If the harness can start a fresh-context reviewer, use it for this pass and give it only what the intended recipient will receive.

4. Identify lines that fail the criteria above, including leakage, omission, and misfit relative to that reader.

5. Apply edits directly when the failure is unambiguous: rewrite leaked language into clean other-facing language; add missing definitions, dependencies, rationale, or grounding where content is absent; reorder material when the current order reflects the author's discovery process rather than the recipient's needs.

6. When a detail might be legitimate for this file's actual reader (e.g. implementation detail in a contributor doc, decision rationale in a handoff, or an invariant in an inline comment), flag it in your summary with a one-line rationale instead of silently stripping it.

7. After editing, briefly list what you changed and why (one line per fix), separating edits from flags. Include unresolved recipient assumptions and any out-of-scope findings among the flags.