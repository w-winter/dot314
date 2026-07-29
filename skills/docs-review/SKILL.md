---
name: docs-review
description: Review and clean up (non-changelog) docs and prompts for local jargon leakage and missing grounding
---

# Docs Review

Review user-facing and/or agent-facing documentation for language that doesn't belong in text a new reader would encounter, and for missing grounding that a cold reader would need. Fix problems directly.

## First, per file: name the reader

Before reviewing each file, state in one line who reads it, what they can and cannot see, and what genre it is (user README, contributor/architecture doc, operator runbook, agent prompt, handoff, task brief). Every judgment below is relative to that reader, not to a generic "new reader." Implementation detail is correct in a contributor-facing architecture doc and wrong in a user README; "what changed" is correct in a changelog and wrong in reference docs. Do not strip detail that this file's actual reader needs.

The acid test for every file: could the intended reader use this text correctly with only the text, without access to the session, plans, or other local docs that informed the recent edits to it? For prompts, handoffs, and task briefs: could a cold-start agent act correctly from this text alone (i.e. without access to the context window you currently have), without having to guess?

## What to catch

### Leakage: wrong content is present

- **Implementation-plan language**: internal field names, spec edge-case notes, architecture references, phrases like "reserve the timestamp column" or "compact display buckets" that reflect how something was built rather than what a user or other agent sees
- **Changelog/diff language**: "does not change X", "deliberately preserves Y", "without affecting Z", "is intentionally out of scope" -- comparisons against a prior version the reader has no baseline for
- **Internal jargon**: type names, config key internals, data-flow descriptions that only matter to contributors
- **Agent/session artifacts**: review constraints, schema-version strategy, compatibility decisions leaked from planning conversations
- **Orphaned deixis**: "this", "that", "the above", "as discussed", "the same approach", "the earlier plan", "continue from here" -- context-dependent references whose referent lives in the authoring session or a private plan, not in the document; restate the referent or delete the reference

### Omission: needed content is absent

- **Terms used as if defined**: project-specific terms, acronyms, and metric names that are load-bearing for the reader but defined nowhere the reader can see; the fix is a local definition or glossary entry, not deletion
- **Unreachable dependencies**: instructions that require files, systems, credentials, or steps the reader has no path to discover or perform from where they stand
- **Under-grounded prompts/handoffs/task briefs**: missing task goal, missing inputs or paths, missing expected output or success criteria, missing stop conditions -- anything that forces a cold-start recipient to guess or confabulate

Omission failures are as common as leakage and harder to see, because the text reads fine to anyone who already has the context. Hunt for them by simulating the named reader, not by scanning for bad phrases. The appropriate fix for omission is often addition rather than removal.

As well as anything else that falls in this general category of "pragmatic perspective-taking" blunders that lead to poor "recipient design" (pragmatics) choices in writing, which are usually a side effect of something akin to the "curse of knowledge" (Colin Camerer, George Loewenstein, and Martin Weber) -- the tendency of language models to erroneously assume that other minds (whether human or AI) have access to the very same tokens that are in their current context window and/or ephemeral planning docs, and thus leak highly local jargon into user-facing *or agent-facing* docs and prompts that would not make any sense to those audiences and would likely lead to confusion and/or confabulation. This is a very serious and recurring problem that needs post-hoc review and fixing, and you are focused now on helping with this in every form that you can identify within the operator's specified scope of review.

## What good docs look like

Describe the current state as if it has always been this way. Each sentence should help the named reader use or understand the software today. Implementation rationale belongs in PRs, changelogs, or code comments, not in text that faces users and/or other agents.

Good prompts and handoffs are self-contained: they restate the task, name the inputs and expected outputs, define any term the recipient cannot know, and give stop conditions -- front-loaded, in the recipient's reading order, not the authoring session's chronological order.

As a secondary lens, consider whether the documentation mixes Diátaxis categories inappropriately -- e.g., reference-style field descriptions embedded in a tutorial flow, or explanation ("why") mixed into a how-to. Light touch here; don't restructure, just note when the mixing hurts clarity.

## Scope

$ARGUMENTS

If the user/operator named specific file paths above, review those files. Otherwise, find doc files touched by the current staged diff:

```bash
git diff --staged --name-only | grep -iE '\.(md|txt|rst)$|readme|doc'
```

If no doc files are staged, say so and stop.

Note the staged-diff fallback only sees the current repo. Prompts and skills often live elsewhere (e.g. `~/.agents/skills/*/SKILL.md`, `~/.pi/agent/prompts/*.md`) or are gitignored; those must be named explicitly by the operator to enter scope.

## Process

1. Read each in-scope doc file and state its reader, what they can/cannot see, and its genre (one line)
2. Identify lines that fail the criteria above, both leakage and omission, relative to that reader
3. Apply edits directly when the failure is unambiguous: rewrite leaked language into clean other-facing language; add the missing definition or grounding where content is absent
4. When a detail might be legitimate for this file's actual reader (e.g. implementation detail in a contributor doc), flag it in your summary with a one-line rationale instead of silently stripping it
5. After editing, briefly list what you changed and why (one line per fix), separating edits from flags
