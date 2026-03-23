# handover

A Pi extension that generates a rich handover / rehydration message, then forks the current session from its first user message (i.e., creates a child session that has no prior messages replicated from the parent) and pre-fills the new child session's editor with the handover draft.

Quick workflow for resetting the context window, while establishing fork lineage (so tools like `session_lineage` / `session_ask` can find ancestors, and so Pi's `/resume` picker visually displays the fork lineage across handovers), and continuing with a high-signal 'what we did + where to go next' message.

Borrowing heavily from [pasky/pi-amplike](https://github.com/pasky/pi-amplike) and [damianpdr/pi-handoff](https://github.com/damianpdr/pi-handoff) (both inspired by Amp's /handoff feature), and [mitsuhiko's handoff prompt](https://github.com/mitsuhiko/agent-stuff/blob/main/commands/handoff.md), `handover` adds a few other constraints and features:

- **Agent-generated draft (not `complete()`)**: generates the handover draft by sending a normal user message to the current session's agent (`pi.sendUserMessage(...)`), then extracting the assistant reply. This avoids a separate direct LLM call and uses the model you're already running.
- **Fork-from-first workflow (lineage-preserving)**: uses `ctx.fork(firstUserEntryId)` rather than creating an unrelated new session, so the fork lineage is preserved.
- **Race-hardened draft extraction**: waits for a quiescent session (`ctx.isIdle()` + `!ctx.hasPendingMessages()`), embeds a per-run nonce in the generation prompt, and extracts the assistant message following that nonce-marked user entry.
- **Structured continuation prompt**: uses a more opinionated handover prompt that separates verified status, decisions, surprises, rejected paths, observed facts vs inferences, mandatory reading, and concrete next steps, with guardrails against exhaustive file-list restatements
- **Compaction-history addendum**: if present in the session history, prior compaction summaries from the current session JSONL are included in an addendum.
- **Files touched list**: deterministically computes a files-touched block from the same branch-history logic as [`files-touched`](../files-touched.ts), including explicit read/write/edit/move/delete markers across native Pi tools, `rp`, and `rp_exec`, presents that to the handover-generating model for recall aid, and appends it to the child-session draft.
- **User-editable overrides**: supports `config.json` (auto-submit countdown) and `prompt.md` (style guide) without editing TypeScript.
- **Rewind integration (explicit + gated)**: when the `rewind` extension is installed, `handover` emits a `rewind:fork-preference` event requesting a conversation-only fork ("keep current files") for the fork it triggers.
- **Designed to pair with `session-ask`**: because `/handover` creates a real fork (parentSession chain), the [`session-ask/`](../session-ask/) extension can (optionally, via its own config) inject a minimal "Fork lineage" hint into the system prompt after a fork, including the parent session path—so the agent can quickly call `session_ask`/`session_lineage` to consult parent history as needed.

## Features

- `/handover [purpose]`
  - purpose is optional (defaults to "continue from current milestone/state")
  - generates a handover draft using the **current session model** (no separate model selection)
  - gives the drafting model a files-touched list derived from the same logic as [`files-touched`](../files-touched.ts)
  - forks from the **first user message** and switches into the child session
  - pastes the handover draft into the child session editor with the same files-touched list appended verbatim
  - optional auto-submit countdown (cancelled by typing or `Esc`; `Enter` submits normally)

- Optional integration with `rewind`
  - if the `rewind` extension is installed, `handover` requests a **conversation-only fork** ("keep current files")
  - if `rewind` is not installed, `handover` still works normally

## Installation

1. Copy this extension folder to:

   - `~/.pi/agent/extensions/handover/`

2. Run `/reload` in Pi (or restart Pi)

## Usage

### Slash command

```text
/handover
/handover begin by focusing on the second failing test
```

Notes:
- If you omit the purpose, `handover` uses a default "continue from current milestone/state" purpose and does **not** prompt
- The handover **generation prompt** is sent as a normal user message in the *parent* session before forking (so it will appear in that session's history)
- The generated draft is inserted into the **child session editor**
- Auto-submit:
  - cancelled by typing anything or hitting `Esc`
  - `Enter` submits immediately

## Configuration

### Auto-submit countdown (`config.json`)

Create `config.json` next to `index.ts` (see `config.json.example`):

```json
{ "autoSubmitSeconds": 10 }
```

- `autoSubmitSeconds: 0` disables auto-submit entirely

### Prompt/style override (`prompt.md`)

By default, the extension uses an embedded style guide.

To customize without editing TypeScript, create:

- `~/.pi/agent/extensions/handover/prompt.md`

You can start from:

- `~/.pi/agent/extensions/handover/prompt.md.example`

## How it works

1. Waits for the session to go quiescent, then snapshots the current branch history
2. Builds a files-touched list from session tool-call/tool-result history using the same collector as `/files-touched`, including explicit `R/W/E/M/D` markers and best-effort bash-derived move/delete detection, then cleans up aliases for handover presentation
3. Builds an instruction prompt ("generate a single rich handover / rehydration message…") + style guide + that files-touched block, explicitly telling the model not to emit its own exhaustive file list or title
4. If compactions occured: adds a small **prior-compactions addendum** (verbatim compaction summaries from the session JSONL), capped for safety
5. Sends that prompt as a normal user message (`pi.sendUserMessage(...)`) so the current session model produces the draft
6. Waits until the assistant response is actually present in the session entries (avoids queue/idle race conditions)
7. Finds the first user message entry ID and calls `ctx.fork(firstUserEntryId)`
8. Normalizes the draft, prefixes a stable title, appends the same files-touched block, and starts the countdown (if enabled)
