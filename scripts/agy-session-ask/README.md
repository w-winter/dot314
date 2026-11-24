# agy-session-ask

Queries Antigravity CLI (`agy`) session transcripts and parent-fork lineage from the command line, backed by `pi -p` and reusing your [session-ask](../../extensions/session-ask/README.md) model and analyst configuration.

## Requirements

Requires Node 24+ and the `pi` CLI. When the selected model starts with `pi-claude/`, `extensions/pi-claude-bridge/bundle/index.js` must exist in this repository. Set `PI_BIN` to override `pi` binary resolution.

## Usage

Inspect session lineage (including any stitched pre-fork ancestors). By default, `--cid` looks under `~/.gemini/antigravity-cli/brain` (override with `--brain-root <dir>`):

```bash
node scripts/agy-session-ask/cli.ts lineage --cid <conversationId>
node scripts/agy-session-ask/cli.ts lineage --path /path/to/transcript_full.jsonl --json
```

Ask a question about a session (defaulting to the full active branch across stitched ancestors):

```bash
node scripts/agy-session-ask/cli.ts ask --cid <conversationId> "What timeout value did we pick and why?"
node scripts/agy-session-ask/cli.ts ask --cid <conversationId> --no-ancestors "What failed after the fork?"
node scripts/agy-session-ask/cli.ts ask --cid <conversationId> --model openai-codex/gpt-6-luna --thinking high "Quote the exact error from step 109."
```

## Configuration and behavior

Model defaults, `toolResultMaxChars`, and the analyst prompt come from `extensions/session-ask/config.json` and `agents/session-ask-analyst.md` (with `--model` and `--thinking` CLI overrides).

Active-branch reconstruction reuses `scripts/agy-grounded-compaction/transcript.ts` and `scripts/agy-grounded-compaction/lineage.ts`, so abandoned `/rewind` turns are pruned and parent-fork links saved in `state.json` (or uniquely matched via `# User Requests`) are stitched automatically. If a forked session has an unresolvable parent, the CLI reports the missing pre-fork step range in its metadata.

Rendered transcripts up to 32,000 characters go inline to `pi -p --no-tools` for a single-turn answer. Larger transcripts are written to a temporary directory as `transcript.txt` and `session.meta.json`, where `pi -p --tools read,grep` searches the rendered log read-only before the temporary directory is removed.

## Antigravity skill

Register [SKILL.md](./SKILL.md) in `~/.gemini/config/skills.json` using an absolute `path` (`~/` is not expanded there). This merges additively with `~/.gemini/config/skills` while keeping the skill invisible to Pi, Codex, and Claude Code:

```json
{
  "entries": [
    {
      "path": "/absolute/path/to/scripts",
      "include_only": ["agy-session-ask"]
    }
  ]
}
```

## Tests

Run the unit tests and strict typecheck from the repository root:

```bash
node --test scripts/agy-session-ask/cli.test.ts
./node_modules/.bin/tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --skipLibCheck scripts/agy-session-ask/cli.ts scripts/agy-session-ask/cli.test.ts
```
