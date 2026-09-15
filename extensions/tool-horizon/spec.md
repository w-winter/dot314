# Tool Horizon specification

## Purpose

Tool Horizon is a non-destructive, payload-grounded context filter. It preserves the human conversation and session tree while hiding stale tool calls and matching results from outgoing model requests before a user-selected horizon.

The session tree is the browsing surface. The raw model payload is the actionable universe for boundary validation, savings estimates, fingerprint resolution, pruning, and checkpoint construction.

## Vocabulary

- **Horizon** is the user-facing point where retained tool history begins.
- **Boundary** is the internal raw-payload split implementing the horizon.
- **Checkpoint** is the deterministic file-provenance record representing activity hidden before the boundary.

Public UI uses horizon terminology. Source, persisted schema, and algorithmic documentation use boundary terminology.

## Canonical namespace

Tool Horizon has one active namespace:

```text
Directory:                 extensions/tool-horizon/
Command:                   /tool-horizon [here|pick|all]
State custom type:         tool-horizon-state
Checkpoint state type:    tool-horizon-checkpoint-state
Checkpoint message type:  tool-horizon-checkpoint
Status key:                tool-horizon
Runtime symbol:            pi.extensions.tool-horizon.runtime.v1
Write-failure symbol:      pi.extensions.tool-horizon.write-failures.v1
Debug environment:         TOOL_HORIZON_DEBUG
```

The persisted schema uses `boundaryMode`, `boundaryFingerprint`, and `boundarySignature`. Tool Horizon reads only this canonical namespace and schema.

## Hard cutover

Tool Horizon does not read or bridge `diligent-context-state`, `diligent-context-checkpoint-state`, `context-checkpoint`, `pi.extensions.diligent-context.runtime.v1`, `DILIGENT_CONTEXT_DEBUG`, `warnBeforeOffThresholdPercent`, or `turnOffAfterCompaction`. Records outside the canonical Tool Horizon namespace fail closed or remain ordinary non-Tool-Horizon messages.

## Command decisions

### No arguments

`/tool-horizon` is non-mutating. It opens the control menu with an interactive UI and reports state plus canonical usage without one.

### `here`

`/tool-horizon here` sets an `after-entry` boundary at the current canonical payload tail. If no stable tail exists, it persists a `pending` boundary. The first eligible context captures a safe prospective boundary, and `agent_settled` commits it after revalidating the message, index, fingerprint, and structural safety against the settled branch.

### `pick`

`/tool-horizon pick` aligns current-branch context entries to the cached raw payload, then opens the chronological session-tree picker. The returned session entry maps directly to a raw payload index and commits a `from-entry` boundary.

### `all`

`/tool-horizon all` persists the disabled state and restores the complete tool history. The raw payload cache remains available so `here` and `pick` work immediately afterward. A projected context-usage warning may require confirmation.

## State model

```ts
type BoundaryMode = "from-entry" | "after-entry" | "pending";

type ToolHorizonState =
  | {
      enabled: false;
      boundaryMode: null;
      boundaryFingerprint: null;
    }
  | {
      enabled: true;
      boundaryMode: "pending";
      boundaryFingerprint: null;
    }
  | {
      enabled: true;
      boundaryMode: "from-entry" | "after-entry";
      boundaryFingerprint: BoundaryFingerprint;
    };
```

A fingerprint contains role, leading comparable text, tool names, tool count, and a payload-index hint. Payload indices and tool-call IDs can move when Pi reshapes history, so the fingerprint re-identifies the selected message structurally. Failure to resolve it leaves the outgoing payload unpruned.

`loadToolHorizonStateFromEntries` reduces explicit Tool Horizon state and configured compaction transitions in chronological branch order. A later explicit state always supersedes an earlier compaction transition.

## Payload alignment

`buildContextMessageEntries` calls Pi's public `buildContextEntries` and `sessionEntryToContextMessages` exports for an explicit parent-linked leaf, then retains each source entry ID through a strict adapter. Zero-message projections are omitted, one-message projections retain the source ID, and projections of more than one message fail with `ContextProjectionCardinalityError` because one source ID cannot identify multiple payload positions.

`collectCompactedAwayMessages` remains a Tool Horizon branch-derived operation because Pi exposes no equivalent. It uses the same explicit leaf projection to identify the active compaction, then recovers the hidden prefix from the selected branch. `alignContextMessageEntriesExactly` maps active entries to the cached raw payload. Picker opening requires exact consumption of both actionable sequences; mismatches refuse the picker rather than inferring a mapping.

Turn-end reconciliation shares the prefix matcher but retains its separate completion contract. It may skip unmatched custom messages while requiring the remaining non-custom suffix to contain exactly the completed assistant message.

## Boundary safety

A boundary is selectable only when:

1. its tree entry maps to the current raw payload;
2. it is not Tool Horizon's derived checkpoint message;
3. the structural safe-index pass proves that no suffix tool result answers a call issued before the boundary; and
4. a newly computed boundary fingerprint resolves back to the same raw index.

Safety is independent of the transient protection applied to the newest thinking-bearing assistant. This prevents a currently protected tool result from becoming removable after protection advances on a later turn.

Tool-call-only assistant entries are hidden by Pi's tree selector. Their weight still contributes to the next mapped safe row's savings because estimates run against the complete raw payload.

## Pruning

`applyPruningAtBoundary` gathers tool-call IDs issued before the resolved boundary. It removes those call blocks and their matching tool-result messages while retaining narrative content.

The newest assistant message containing a `thinking` block, including one marked `redacted: true`, remains byte-for-byte intact with its matching tool results. When tool calls are removed from any older assistant message, its signed thinking blocks are removed too, because the altered historical message can no longer carry valid signatures.

Already-empty assistant messages survive when pruning did not empty them. An assistant message emptied by pruning is removed.

## Picker architecture

`boundary-model.ts` owns deterministic, terminal-independent behavior:

- current-branch filtering
- row classification and exact raw-index mapping
- savings computation and formatting
- current-boundary markers
- row decoration
- status-line copy
- preview extraction, highlighting, and viewport clamping
- compatibility arithmetic shared with the TUI adapter

`boundary-picker.ts` owns terminal integration:

- `TreeSelectorComponent` construction
- validated access to private tree-list fields
- custom help text
- blocked copy, label, timestamp, fold, and branch-navigation actions
- focus, flashes, preview scroll state, and cleanup
- row-render patching and fail-closed compatibility behavior

The picker shows the current branch with `no-tools` as its initial filter. It uses red `−N context tokens` estimates and the status phrase `Tool horizon begins at this entry`. Savings are point-in-time projections against the current raw payload; they can change when protection advances from the newest thinking-bearing assistant response.

## Checkpoint transaction

Checkpoint state is the durable source of provenance. Historical checkpoint messages are removed from canonical payload caches. The active checkpoint is rendered deterministically and appended only to the outgoing model context.

Path extraction retains each tool's path basis before normalization: native file-tool and Codex filesystem-tool paths are session-cwd-relative, while RepoPrompt paths are workspace-root-relative. `exec_command` paths use its effective working directory before entering the shared normalizer. Correlated absolute and workspace-relative spellings establish a named root mapping, after which bucket precedence operates on canonical `root:relative-path` identities.

A boundary commit appends:

1. `tool-horizon-checkpoint-state`, containing a present checkpoint or explicit absence tombstone;
2. `tool-horizon-state`, containing the boundary that activates that decision.

Runtime state and caches are installed only after both writes succeed. Reconstruction accepts only the checkpoint decision directly preceding the latest Tool Horizon state. A malformed or missing pair disables pruning.

Present checkpoint records require `boundaryMode` and a non-empty `boundarySignature`. The signature serializes the resolved boundary mode and fingerprint, binding provenance to exactly one boundary.

## Provenance

Checkpoint provenance is derived in one pass from the soon-hidden raw prefix plus messages already hidden by compaction. One-pass detection allows equivalent named-root, working-directory-relative, absolute POSIX, and Windows paths to collapse to one identity before precedence is applied.

Codex `exec_command` provenance uses the shared high-confidence literal shell parser. A normal result with a live process session may expose the command before the process finishes; input sent later through the persistent session is not part of that command record. Codex `apply_patch` provenance intersects structural patch headers with structured completed-effect details, including completed actions reported by a partial failure.

Each file appears in its most consequential bucket. A file read and later modified appears only under `modified`; `read` therefore means read and left unmodified.

The provider-facing XML remains generic:

```xml
<checkpoint v="1" scope="before-boundary" fmt="known-root:relative-path, else cwd-relative, else absolute">
  <use>Use the current request and retained conversation to identify only the listed paths needed for remaining work; inspect their current state before relying on prior observations. Do not inspect paths merely because they appear here.</use>
  <files>
    <read state="unmodified">...</read>
    <modified>...</modified>
    <created>...</created>
    <deleted>...</deleted>
    <moved>...</moved>
  </files>
</checkpoint>
```

## Compaction lifecycle

`restoreAllAfterCompaction` defaults to `true`. Compaction reconstructs every payload-derived cache, suppresses pruning and checkpoint output immediately, and persists the disabled state once the agent is idle. Branch-state reduction also treats compaction as a restore-all transition, so navigating to the compaction or a descendant reconstructs consistently.

A later `here` or `pick` state reactivates the horizon. Setting `restoreAllAfterCompaction` to `false` preserves the active boundary across compaction.

Cancellable `session_before_fork`, `session_before_tree`, and `session_before_switch` events clear payload/UI caches while preserving a deferred restore-all transition. A successful `session_start` or `session_tree` reconstructs the newly selected branch and supersedes the deferred transition.

## Write safety

Boundary changes require `ctx.isIdle()`. Pending `here` materialization captures during context construction but persists only at `agent_settled`.

Every append records the leaf beforehand. If persistence throws after advancing the leaf, a process-global `WeakMap` quarantines that `SessionManager`, aborts the operation, and shuts Pi down before descendant writes can occur. The Tool Horizon runtime and write-failure symbols are isolated from other extensions.

## Configuration

```json
{
  "checkpointUseGuidance": "Review relevant listed paths before relying on hidden tool activity.",
  "warnBeforeRestoreAllThresholdPercent": 70,
  "restoreAllAfterCompaction": true
}
```

`checkpointUseGuidance` replaces the built-in `<use>` text after an extension reload. Empty and non-string values use the built-in guidance.

## Verification contract

The focused suite covers:

- exact branch-to-payload alignment and compaction projection
- pruning and thinking-block invariants
- protection-independent boundary safety
- fingerprint round trips and duplicate tie-breaking
- picker classification, decoration, savings, status copy, and preview behavior
- deep-tree traversal and narrow-terminal layout
- provenance normalization, precedence, and compaction recovery
- checkpoint/state adjacency and explicit absence
- compaction restore-all lifecycle
- canonical names, config keys, state rejection, and token formatting

Canonical validation commands are:

```bash
bun test extensions/tool-horizon/test
bun build extensions/tool-horizon/index.ts --target=node --outdir=/tmp/tool-horizon-build
```
