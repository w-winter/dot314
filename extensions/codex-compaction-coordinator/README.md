# codex-compaction-coordinator

Coordinates native compaction and cross-provider history portability for models whose provider is `openai-codex` and API is `openai-codex-responses` (called **Codex models** below).

The coordinator depends on two integrations:

- A compatible checkpoint extension creates and replays encrypted OpenAI Responses V2 checkpoints through Pi's normal compaction pipeline. [howaboua's `@howaboua/pi-codex-conversion`](https://www.npmjs.com/package/@howaboua/pi-codex-conversion) is the implementation I use and test with this coordinator.
- [`grounded-compaction`](../grounded-compaction/README.md) is required to create portable plaintext summaries when another provider needs visible history covered by a native checkpoint.

Any extension that produces and replays compatible durable Responses V2 checkpoints can fill the checkpoint role.

Aside: the other compaction-related extension in this repo, [`model-aware-compaction`](../model-aware-compaction/README.md), isn't a coordinator dependency. That extension independently changes when Pi begins compaction for whichever extension, or Pi's native logic, owns the compaction lifecycle at runtime.

## Behavior

For Codex models, grounded-compaction leaves compaction to Pi's normal pipeline. When the compatible checkpoint extension creates a native checkpoint, the coordinator can prepare the visible history covered by that checkpoint for other providers.

On the first request after switching to another provider, the coordinator creates any missing portable summaries for the current history. Grounded-compaction uses its configured `defaultPreset` to summarize the visible session history in chronological chunks. When `includeFilesTouched.inCompactionSummary` is enabled, each portable summary includes grounded-compaction's cumulative files-touched manifest through that checkpoint. Messages after the checkpoint remain in the visible tail and are excluded from the manifest.

Grounded-compaction's `toolResultChars` setting controls tool-result text before the coordinator divides the transcript into chunks. `null` keeps the full text; a positive integer caps each result. The setting is read when summarization starts. Completed portable summaries are reused after a setting change.

Interrupted summarization resumes from the last completed chunk. If a changed `toolResultChars` setting alters an unfinished checkpoint's input text, that checkpoint restarts from the preceding complete summary. The non-Codex request receives one complete cumulative summary followed by the exact visible messages after the latest checkpoint.

Completed model-generated portable summaries appear in the transcript as expandable portable compaction cards. Only complete summaries are shown.

Later requests reuse the saved summary without another summarizer call. A saved summary can also be reused after resuming a session or using `/tree` when the selected branch has the same checkpoint and summarized visible history. A later native checkpoint summarizes only newly covered visible history. Later portable summaries continue from the latest plaintext summary created by Pi or grounded-compaction when one exists.

Switching back to a Codex model uses the checkpoint extension's native replay instead of the plaintext summary.

## Portability modes

Portability defaults to `lazy`. Use these commands for the current session:

- `/codex-portability lazy` creates portable summaries only when a non-Codex request needs them.
- `/codex-portability prewarm` starts catching up existing checkpoints immediately and precomputes future checkpoints in the background as soon as they are persisted.
- `/codex-portability status` reports the mode, how many checkpoints have complete summaries, current work, summaries waiting to be saved, and the latest error.

The selected mode is session-wide and remains active when navigating with `/tree`. Portable summaries remain branch-specific and are reused only when their checkpoint and summarized visible history match the selected branch.

Prewarming runs in the background without delaying active Codex requests. A non-Codex switch joins work already in progress and waits only for unfinished work. Switching to `lazy` stops new background calls, while completed results are saved automatically.

Prewarming while a Codex model is active requires grounded-compaction's `defaultPreset` to name a configured non-Codex preset. The `current` preset can't proactively summarize with the active Codex model.

## Costs and failure policy

Creating a portable summary may require one or more grounded-compaction model calls on the first non-Codex request or after a later checkpoint. In `prewarm` mode those calls can occur before another provider needs the summary. Usage and cost are recorded with the portable summary rather than added to the active assistant turn. Reusing a complete summary doesn't call the summarizer.

Branches without current V2 checkpoints pass through unchanged. If a non-Codex model needs history covered by a native checkpoint but grounded-compaction is unavailable or summarization can't complete, the coordinator blocks the request rather than sending incomplete history. A background prewarm failure doesn't block the active Codex request; status reports the failure, and a later non-Codex request is blocked if the summary remains unavailable. After cancellation, a later attempt resumes from completed work.

Portable summaries can include only messages and summaries visible in the session history. Information stored solely inside an opaque OpenAI checkpoint remains available to compatible Codex models but can't be recovered into plaintext for another provider.

## Context-hook ordering

The coordinator and checkpoint extension may load in either order because the coordinator discovers persisted checkpoints directly. During cross-provider portability, the coordinator rebuilds outgoing context from the active branch and replaces changes made by earlier context hooks. Load extensions that add messages through Pi's context hook after the coordinator when those messages must appear in cross-provider requests.

## Installation

Enable the coordinator from the dot314 git bundle:

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": [
        "extensions/codex-compaction-coordinator/index.ts"
      ]
    }
  ]
}
```
