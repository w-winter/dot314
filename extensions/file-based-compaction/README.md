# pi-agentic-compaction

A [pi](https://github.com/badlogic/pi-mono) extension that provides conversation compaction using a virtual filesystem approach.

Original source: [laulauland/dotfiles](https://github.com/laulauland/dotfiles/tree/main/shared/.pi/agent/extensions/file-based-compaction)

This version adds:

* a more robust, deterministic summarizer prompt by:
  * adding explicit prompt-injection safeguards (treat `/conversation.json` as untrusted input)
  * adding concurrency safeguards (shell is read-only; avoid cross-tool-call state; emit dependent commands one-at-a-time)
  * improving “first user request”/main-goal extraction (ignore slash commands like `/compact`)
  * preventing no-op edits from being counted as modifications (e.g. `Applied: 0` / “No changes applied”)
  * clarifying grep portability (`grep -E` with `|`, avoid `\|`)
  * removing duplicated prompt instructions
  * deduplicating “Files Modified” entries when the same file appears as both absolute and repo-relative paths (prefer repo-relative)

* user influence over the compaction summary via `/compact <note>` (passed through as Pi compaction `customInstructions`)

* deterministic file tracking improvements:
  * tracks tool-result–verified modifications via native `write/edit` and RepoPrompt wrapper calls (`rp apply_edits/file_actions`)
  * keeps `rp_exec`-derived paths as best-effort candidates (separate section)
  * filters likely temporary artifacts out of the default “Files Modified” list
  * tracks deletes/moves separately (best effort)

* configurability via `config.json`:
  * model selection (including extension-registered providers via `ctx.modelRegistry`) and optional per-model `thinkingLevel`
  * performance parameters: `toolResultMaxChars`, `toolCallPreviewChars`, `toolCallConcurrency`
  * debug artifacts via `debugCompactions`

* speed gains via concurrent summarizer tool calls (`toolCallConcurrency`); if `debugCompactions` is enabled, check the saved compaction artifacts for any tool results with `isError=true`

* zsh compatibility (portable shell guidance; zsh tool alias)

## Installation

### Local development / copied extension

If you copy this extension into `~/.pi/agent/extensions/file-based-compaction/`, Pi will load `index.ts` directly but **won't automatically install npm dependencies**.

From that folder, run:

```bash
npm install
```

(Or at minimum: `npm install just-bash`)

## How it works

When pi triggers compaction (either manually via `/compact` or automatically when approaching context limits), this extension:

1. Converts the conversation to JSON and mounts it at `/conversation.json` in a virtual filesystem
2. Spawns a summarizer agent with a sandboxed shell tool (bash/zsh-compatible) to explore the conversation
3. The summarizer follows a structured exploration strategy:
   - Count messages and check the beginning (initial request)
   - Check the end (last 10-15 messages) for final state
   - Find all file modifications (both from native write/edit tools and from the repoprompt-mcp or repoprompt-cli extensions' tools)
   - Search for user feedback about bugs/issues
4. Returns the summary to pi

### Comparison with pi's built-in compaction

**pi's default compaction** (in `core/compaction/compaction.ts`):

1. Serializes the entire conversation to text
2. Wraps it in `<conversation>` tags
3. Sends it all to an LLM with a summarization prompt
4. LLM processes everything in one pass

This works well for shorter conversations, but for long sessions (50k+ tokens), you pay for all those input tokens and the model may struggle with "lost in the middle" effects.

**This extension's approach**:

1. Mounts the conversation as `/conversation.json` in a virtual filesystem
2. Spawns a summarizer agent with bash/jq tools
3. The agent **explores** the conversation by querying specific parts
4. Only the queried portions enter the summarizer's context

Example queries the summarizer might run:

```bash
# How many messages?
jq 'length' /conversation.json

# What was the first user request (ignoring slash commands like /compact)?
jq -r '.[] | select(.role=="user") | .content[]? | select(.type=="text") | .text' /conversation.json | grep -Ev '^/' | head -n 1

# What files were modified? (best-effort; prefer the extension-provided deterministic list)
jq -r '.. | objects | select(.type?=="toolCall") | select(.name?=="write" or .name?=="edit") | .arguments.path? // empty' /conversation.json | sort -u

# Any errors or bugs mentioned? (portable: use -E for alternation)
grep -Ei "error|bug|fix" /conversation.json | head -20

# What happened at the end?
jq '.[-15:]' /conversation.json
```

The summarizer's context stays small (just its system prompt + tool results), while still being able to extract key information from conversations of any length. This is similar to how a human would skim a long document—you don't read every word, you jump to relevant sections.

**Trade-offs**:
- Exploration is **cheaper** for very long conversations (only loads what's queried)
- Exploration may **miss context** that a full-pass approach would catch
- Exploration requires **multiple LLM calls** (one per tool use), but with a small, fast model this is still fast
- Built-in compaction is **simpler** and has no external dependencies

## Usage

This extension runs whenever Pi compacts a session.

You can optionally pass a note after the `/compact` command to bias the summarizer toward specific concerns (Pi passes this through as compaction `customInstructions`). Example:

- `/compact Please account for foo and bar and baz`

If you run `/compact` without any trailing text, behavior is unchanged.

When enabled, this extension overrides Pi’s built-in compaction by returning a custom compaction result from the `session_before_compact` hook.

## Configuration

Create a `config.json` next to `index.ts` (see `config.json.example`). Example:

```json
{
  "compactionModels": [
    { "provider": "openai-codex", "id": "gpt-5.1-codex-mini" },
    { "provider": "cerebras", "id": "zai-glm-4.7" },
    { "provider": "github-copilot", "id": "claude-haiku-4-5", "thinkingLevel": "high" }
  ],
  "thinkingLevel": "medium",

  "debugCompactions": false,
  "toolResultMaxChars": 45000,
  "toolCallPreviewChars": 60,
  "toolCallConcurrency": 9,
  "minSummaryChars": 360
}
```

Among the models I've tested (glm-4.7, gpt-5.2-codex, gpt-5.2, gpt-5.1-codex-mini, haiku-4.5), I have found `gpt-5.1-codex-mini` (**medium** thinking level) to strike the best balance of speed and performance, and that higher reasoning effort (or models with otherwise better benchmark scores, like gpt-5.2-codex) can be deleterious to these compaction summaries (e.g., introducing unhelpful hedging).

Configurable parameters:
- `compactionModels`: models to try in order (first one with an API key wins)
- `thinkingLevel`: default reasoning/thinking level for the summarizer model (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`)
- `compactionModels[].thinkingLevel`: optional per-model override (same values)
- `debugCompactions`: write debug artifacts to `~/.pi/agent/extensions/file-based-compaction/compactions/`
- `toolResultMaxChars`: truncate tool output to keep the summarizer context small
- `toolCallPreviewChars`: how many characters of the command to show in UI notifications
- `toolCallConcurrency`: max number of concurrent summarizer shell tool calls per turn
- `minSummaryChars`: minimum accepted summary length (guards against empty/failed summaries)

## License

MIT
