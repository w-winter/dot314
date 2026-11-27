# Scripts

| Symbol | Meaning |
|--------|-------------------------|
| ● | original |
| ◐ | forked & modified |
| ○ | republished unmodified |

- ● [`agy-grounded-compaction/`](agy-grounded-compaction/) ([README](./agy-grounded-compaction/README.md))
  - Antigravity CLI (`agy`) `PreInvocation` hook that detects each new native `CHECKPOINT` in `transcript.jsonl`, runs [`grounded-compaction`](../extensions/grounded-compaction/README.md) through `pi -p`, and injects the summary plus deduplicated verbatim pre-compaction user messages into the next model call without spending Antigravity quota
  - Reads `extensions/grounded-compaction/config.json` and `compaction-prompt.md` on each compaction, routes large spans to `largeContextPreset`, reconstructs the active branch across `/rewind`, resolves fork parent lineage via `# User Requests` (failing closed when ambiguous), and splits output into `<= 38,000`-byte `systemMessage` steps under Antigravity's 48 KiB cap
  - Stores per-session state and JSONL logs under `<appDataDir>/brain/<conversationId>/.system_generated/grounded-compaction/` (where `<appDataDir>` is `~/.gemini/antigravity-cli` for the CLI)
  - Requires Node 24+ and the `pi` CLI

- ● [`agy-session-ask/`](agy-session-ask/) ([README](./agy-session-ask/README.md))
  - Command-line companion to [`session-ask`](../extensions/session-ask/README.md) for Antigravity CLI transcripts, providing `lineage` (stitched parent-fork chains) and `ask` (focused answers with `[step N]` citations)
  - Reuses `agy-grounded-compaction`'s rewind pruning and lineage resolver alongside `extensions/session-ask/config.json` and `agents/session-ask-analyst.md` (with `--model` and `--thinking` overrides)
  - Sends rendered transcripts up to 32,000 characters inline to `pi -p --no-tools`, and queries larger transcripts read-only through `pi -p --tools read,grep` in a temporary directory

- ● [`pi-package-prepack.mjs`](pi-package-prepack.mjs)
  - Build-time `prepack` helper invoked by standalone npm packages under [`packages/`](../packages/) according to each package's `dot314Prepack` field in `package.json`
  - Cleans declared output paths inside the package directory, copies the source files listed in `dot314Prepack.copy`, and aborts publishing if any non-example `.json` file appears under `extensions/` unless explicitly listed in `dot314Prepack.allowJson`
