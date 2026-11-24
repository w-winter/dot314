# agy-grounded-compaction

Runs [grounded-compaction](../../extensions/grounded-compaction/README.md) for Antigravity CLI (`agy`) as a `PreInvocation` hook. After Antigravity writes a native compaction checkpoint, this hook summarizes the pre-compaction transcript externally through `pi` using your Pi compaction prompt and model presets, appends deduplicated verbatim user messages, and injects the result into the next model call without spending Antigravity quota.

## Requirements and setup

Requires Node 24+ (for direct `.ts` execution) and the `pi` CLI. When a configured preset uses a `pi-claude/*` model, `extensions/pi-claude-bridge/bundle/index.js` must exist in this repository because the hook passes it via `-e` alongside `--no-extensions`.

Register the hook in `~/.gemini/config/hooks.json`:

```json
{
  "grounded-compaction": {
    "PreInvocation": [
      {
        "type": "command",
        "command": "node /absolute/path/to/scripts/agy-grounded-compaction/hook.ts",
        "timeout": 300
      }
    ]
  }
}
```

The `timeout` is in seconds, and 300 gives Opus or Codex enough room on long transcripts.

For `pi` binary resolution, the script checks the same directory as `process.execPath` before falling back to `PATH`. Set `PI_BIN` if Antigravity starts under a different Node install than the one with your current `pi` binary (common when mixing nvm with Homebrew or launching from the Antigravity desktop app).

## Configuration

Every compaction reads `extensions/grounded-compaction/config.json` and `extensions/grounded-compaction/compaction-prompt.md` from this repository (see the [grounded-compaction README](../../extensions/grounded-compaction/README.md) for creating them from the `.example` templates).

| Key | Effect in `agy-grounded-compaction` |
|---|---|
| `defaultPreset` | Primary preset name under `presets` (`model` and optional `thinkingLevel`). |
| `largeContextPreset` | Preset used when estimated prompt tokens plus 64,000 tokens of headroom exceed the default model's window from `pi --list-models`. |
| `toolResultChars` | `null` sends full tool outputs to `pi`; a positive integer truncates each tool result. |
| `verbatimUserMessageTokens` | Token budget (at 3.5 chars/token, selected newest-first) for verbatim pre-compaction user prompts appended after the summary. `null` disables retention. |
| `includeFilesTouched` | Accepts `"off"`, `"writer"`, `"writerAndReader"`, or an object with `inCompactionSummary`. Controls whether a cumulative file-operations ledger goes to `pi` only or is also appended for the resumed model. |

The hook ignores Pi-only settings such as `enforceCompactionMandatoryReading` and `enforceBranchMandatoryReading`.

## How it works

On every `PreInvocation`, the hook scans `transcript.jsonl` for the latest active `CHECKPOINT` record. When no checkpoint exists, or when the latest checkpoint key (`<stepIndex>@<createdAt>`) is already recorded in `state.json`, it returns `{}` in roughly 75 ms. When a pending `/compact` user input appears after the latest checkpoint in the transcript, it also skips the first invocation (`invocationNum === 0`) so it does not summarize right before native compaction resets context.

When a new checkpoint appears, the hook reads `transcript_full.jsonl`, reconstructs the active branch, and resolves parent lineage if the session was forked. It serializes the span after the previous grounded checkpoint, passes that prior summary for incremental updates, and includes any text after `/compact` under `## User compaction note`. After `pi -p` returns the summary, the hook collects verbatim pre-compaction user prompts and drops any that Antigravity already kept untruncated in its native `# User Requests` section. It then splits the payload into `<= 38,000`-byte `systemMessage` steps to stay under Antigravity's 48 KiB per-step truncation limit.

Each conversation stores its state (`state.json`) and JSONL logs (`hook.log`) under `<appDataDir>/brain/<conversationId>/.system_generated/grounded-compaction/`, where `<appDataDir>` is `~/.gemini/antigravity-cli` for the CLI. If `pi` fails, the hook logs the error, marks the checkpoint `failed` in `state.json` so later turns do not retry-loop, and injects a short notice telling the model to continue with Antigravity's native checkpoint.

## Antigravity limitations

Antigravity's hook API and session storage impose several constraints on what this hook can do:

- **Additive re-injection.** Antigravity has no `PreCompact` hook event, and `injectSteps` can only append steps. Native compaction still runs and stays in the model's context, so the injected grounded summary instructs the resumed model to treat it as authoritative wherever it conflicts with Antigravity's native summary.
- **Forked sessions (`/fork`) drop history and parentage on disk.** Antigravity clones live backend state into a fork without copying `transcript_full.jsonl` or `state.json` and exposes no parent session ID to hooks. When a fork compacts, the hook tries to identify its parent by matching pre-fork entries from Antigravity's `# User Requests` section against sibling transcripts in `brain/`. Matching fails when zero or multiple sibling sessions fit, which happens if more than 10 post-fork turns push pre-fork prompts past Antigravity's `# User Requests` cap or if the parent was rewound past the fork point. When matching fails, the hook fails closed. It tells `pi` that the pre-fork prefix is missing and marks the injected header as authoritative only for post-fork steps.
- **Rewind (`/rewind`) silently reverts workspace files.** Antigravity's `/rewind` reverts workspace files back to the earlier step without prompting or offering a conversation-only mode, which overwrites uncommitted work and leaves committed changes rolled back in the working tree. In `transcript_full.jsonl`, `/rewind` writes no marker and instead appends new records reusing earlier `step_index` values. The hook detects an in-place rewind when a `step_index` repeats and prunes the abandoned steps. If a forked session runs post-fork turns and then rewinds to a pre-fork `step_index` that never appeared in the fork's own log, the hook misses that rewind.
- **`/compact` parsing and timing quirks.** Mentioning `/compact` anywhere mid-sentence causes Antigravity's TUI to attach it as a second input item and append `/compact` to the serialized `<USER_REQUEST>` text (only a leading `/compact` triggers compaction). With `/compact <message>`, native compaction and the model's immediate reply finish inside the same turn after `PreInvocation`, so the grounded summary arrives on the next turn. Behavior during automatic mid-turn compaction at the context threshold has not been verified live.
- **Shared Pi prompt wording.** Because `compaction-prompt.md` is shared with Pi, `pi` may mention Pi tools such as `session_ask` under `## Retrieval cues`. The injected header overrides those cues with the exact `transcript_full.jsonl` paths on disk and the `scripts/agy-session-ask/cli.ts` command for querying them without loading the raw log.

## Tests

Run the unit tests and strict typecheck from the repository root:

```bash
node --test scripts/agy-grounded-compaction/hook.test.ts
./node_modules/.bin/tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --skipLibCheck scripts/agy-grounded-compaction/hook.ts scripts/agy-grounded-compaction/hook.test.ts
```
