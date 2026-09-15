# Tool Horizon

Tool Horizon keeps the complete human conversation in model context while hiding older tool calls and matching tool results before a horizon you choose. It changes only the outgoing model request; Pi's session history remains available through `/tree` and `/fork`.

The horizon is selected from Pi's chronological session tree and resolved against the current model context. The picker estimate and actual context reduction are calculated from the same messages.

When hidden tool activity touched files, Tool Horizon adds a compact deterministic checkpoint listing files that were read, modified, created, deleted, or moved. This preserves useful provenance without carrying the full tool transcript.

File provenance includes supported tools nested inside pi-codex-conversion's Code and Notebook `exec` calls and literal `rp-cli`/`rpce-cli` shell invocations. Missing file evidence produces a warning, and checkpoints include the known operations. See [Files Touched coverage](../../packages/pi-files-touched/README.md#what-it-tracks) for supported commands and limits.

## Installation

Install dot314 and enable `tool-horizon` with `pi config`:

```bash
pi install git:github.com/w-winter/dot314
```

Then run `/reload` or restart Pi.

This project is derived from [crstdr/diligent-pi](https://github.com/crstdr/diligent-pi/tree/main/extensions/diligent-context). The original MIT license and attribution are preserved in [`LICENSE`](LICENSE).

## Differences from upstream

Tool Horizon retains `diligent-context`'s core idea of pruning older tool calls and results while preserving the human conversation, but it changes the interaction model and lifecycle:

- The namespace is `tool-horizon` throughout: `/tool-horizon [here|pick|all]`, `horizon: x/x` footer status, dedicated session-entry types, and `TOOL_HORIZON_DEBUG`.
- The picker uses Pi's session tree for the current branch in native tree order and initially focuses the newest selectable entry. It adds a scrolling preview, search and tool-result filtering, right-aligned savings, unavailable-row explanations, and rejection when the payload or branch changes while the picker is open.
- Tree entries are aligned exactly with the outgoing model payload. Cache reconstruction follows Pi's public context projection, handles compaction and context-transforming extensions, and refreshes after session starts, tree navigation, forks, switches, and completed turns.
- Horizon state and its file-provenance decision are persisted as adjacent branch-local entries. The provider sees a deterministic checkpoint at the horizon rather than upstream's visible generic checkpoint messages, and contemplation checkpoints are not carried over.
- File provenance uses dot314's shared tracking for file operations from Pi, RepoPrompt, and [pi-codex-conversion](https://github.com/IgorWarzocha/pi-codex-conversion), including nested Code/Notebook calls, literal `rp-cli` or `rpce-cli` commands, path-root inference, moves, partial failures, and work hidden by compaction.
- Compaction restores all tool history by default, even when it occurs during an active run. Set `restoreAllAfterCompaction` to `false` to retain the horizon.
- State writes are tied to the current session leaf and fail closed; an unresolved horizon leaves the payload unchanged, and a failed write that advances the leaf quarantines further writes and shuts Pi down.

## Commands

```text
/tool-horizon
/tool-horizon here
/tool-horizon pick
/tool-horizon all
```

### `/tool-horizon`

Opens a non-mutating control menu:

1. **Set horizon here**
2. **Choose horizon from session tree**
3. **Restore all tool history** when a horizon is active
4. **Cancel**

Without an interactive UI, the command reports the current state and command usage.

### `/tool-horizon here`

Sets the horizon after the current model context. Existing tool calls and results become prunable; future tool activity remains visible.

When no stable live payload exists, Tool Horizon records a pending horizon. The footer displays `horizon: pending`, and the horizon materializes on the next eligible model call after the agent settles.

### `/tool-horizon pick`

Opens the current branch in Pi's native session-tree order and initially focuses the newest selectable entry. Choose the entry where retained tool history should begin.

The focused entry appears in a scrolling preview beneath the tree. Bash commands and `read` results receive syntax highlighting; other entries use Pi's Markdown renderer.

### `/tool-horizon all`

Restores all tool calls and results to model context and stops adding provenance checkpoints. If the restored history would raise projected context usage above the configured threshold, Tool Horizon asks for confirmation first.

## Picker

Selectable rows show estimated savings right-aligned in red:

```text
−12.4k context tokens
```

The focused-row status reads:

```text
Tool horizon begins at this entry · −12.4k context tokens
```

A `−0 context tokens` row is still a valid horizon. Savings are a point-in-time estimate and can change after the protected newest thinking-bearing assistant response advances. Rows that cannot safely begin the horizon are dimmed and explain why when selected. A row is unavailable when it is absent from the current model payload, cannot be re-identified stably, would split a tool call from its result, or is Tool Horizon's own checkpoint message.

Tool results are hidden by the initial `no-tools` filter because a horizon cannot begin inside a tool exchange. Use `Ctrl+T` to show them for inspection.

### Keys

| Key | Action |
|-----|--------|
| `Enter` | Set the horizon at the focused row |
| `↑` / `↓` | Move between rows |
| `←` / `→` | Page through tree rows |
| `Shift+↑` / `Shift+↓` | Scroll the preview by one line |
| `Shift+PageUp` / `Shift+PageDown` | Page the preview |
| Filter/search keys | Narrow the tree |
| `Esc` | Close without changing the horizon |

Copying, labels, timestamps, folding, and branch navigation are unavailable in this picker. It displays only the current branch.

## Footer

An active horizon uses these status forms:

```text
horizon: pending
horizon: restoring
horizon: ?
horizon: 12/40
```

The footer is cleared when all tool history is visible.

## Configuration

Edit `extensions/tool-horizon/config.json`:

```json
{
  "checkpointUseGuidance": "Review relevant listed paths before relying on hidden tool activity.",
  "warnBeforeRestoreAllThresholdPercent": 70,
  "restoreAllAfterCompaction": true
}
```

- `checkpointUseGuidance` sets the instruction included with each file-provenance checkpoint. Omit it to use the built-in guidance, which is:
  - > Use the current request and retained conversation to identify only the listed paths needed for remaining work; inspect their current state before relying on prior observations. Do not inspect paths merely because they appear here
- `warnBeforeRestoreAllThresholdPercent` is an integer from `0` to `100`. Tool Horizon warns before restoring all history when projected context use reaches this percentage.
- `restoreAllAfterCompaction` defaults to `true`. Pi compaction restores all tool history and stops adding provenance checkpoints; run `/tool-horizon here` or `/tool-horizon pick` to establish a new horizon. Set it to `false` to retain the current horizon across compaction.

Reload the extension after editing the configuration.

## Safety properties

Tool Horizon never removes user messages, assistant prose, or session records. It removes assistant `toolCall` blocks before the horizon and the matching `toolResult` messages. When that changes an older assistant response, Tool Horizon also removes its signed `thinking` blocks, including blocks marked `redacted: true`.

The newest assistant message containing an Anthropic `thinking` block, including one marked `redacted: true`, remains byte-for-byte unchanged together with its matching tool results. If a persisted horizon cannot be resolved against the current model context, Tool Horizon leaves the payload unpruned rather than guessing.

Horizon changes require an idle agent. A picker selection is rejected if the payload, session, or branch leaf changes while the picker is open.

## Persistence

Tool Horizon stores horizon settings and provenance checkpoint decisions as branch-local session entries. The canonical custom types are `tool-horizon-state` and `tool-horizon-checkpoint-state`; the model-facing checkpoint type is `tool-horizon-checkpoint`. Stored state uses `boundaryMode` and `boundaryFingerprint`, while present checkpoint records use `boundaryMode` and `boundarySignature`. Navigating with `/tree` restores the latest horizon on the selected branch.

Tool Horizon does not import `diligent-context` session entries, config keys, debug settings, or runtime data. Those records are unsupported and leave all tool history visible.

With `restoreAllAfterCompaction` enabled, compaction restores all tool history. A later `/tool-horizon here` or `/tool-horizon pick` command activates pruning again.

## Debugging

Set `TOOL_HORIZON_DEBUG=1` before starting Pi to emit payload alignment, boundary resolution, pruning, thinking-invariant, and tool-ID stability diagnostics.

## Development

```bash
bun test extensions/tool-horizon/test
bun build extensions/tool-horizon/index.ts --target=node --outdir=/tmp/tool-horizon-build
```

The extension is organized as:

```text
extensions/tool-horizon/
├── index.ts             runtime lifecycle, commands, caches, and context filtering
├── core.ts              payload alignment, boundary safety, pruning, and fingerprints
├── boundary-model.ts    pure picker model, row decoration, status, and previews
├── boundary-picker.ts   session-tree TUI adapter
├── provenance.ts        deterministic checkpoint derivation and serialization
├── test/                focused unit and lifecycle tests
├── config.json
├── README.md
└── spec.md              architectural rationale and decision record
```
