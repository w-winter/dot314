# model-aware-compaction

Triggers Pi's built-in auto-compaction at configurable, model-specific context-usage thresholds expressed in **percentages** of each model's available context window rather than tokens.  Why?  Because models have different context window sizes, and they also vary in their performance ("dumb zone" encroachment) at the same % of window utilized.

## Requirements

- Pi auto-compaction must be enabled:

```json
{ "compaction": { "enabled": true } }
```

Set in `~/.pi/agent/settings.json`.

This extension is compatible with extensions that customize compaction summaries (e.g. `agentic-compaction` via `session_before_compact`), since it uses Pi's normal compaction pipeline rather than calling `ctx.compact()`.

## Configuration

### Thresholds (`config.json` in this extension's folder)

Thresholds are **percent used** (0–100): compaction triggers when `used% >= threshold`.

| Key | Purpose |
|-----|---------|
| `global` | Default threshold for models without a specific override |
| `models` | Per-model overrides, keyed by model ID; supports `*` wildcards |

Example:

```json
{
  "global": 70,
  "models": {
    "claude-opus-4-6": 85,
    "gpt-5.2*": 75,
    "gpt-5.3*": 75
  }
}
```

### Tuning `reserveTokens` in `settings.json`

Pi's own auto-compaction triggers when `usedTokens > contextWindow - reserveTokens`. If that fires before your model-aware threshold, Pi compacts first.

To let model-aware thresholds take priority, lower `reserveTokens`, but keep enough headroom for responses.  A reasonable starting point:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 9000,
    "keepRecentTokens": 15000
  }
}
```

- **`reserveTokens`**: smaller → compaction triggers later (less headroom).  Too small risks context overflow.
- **`keepRecentTokens`**: how much recent conversation is kept verbatim during compaction; smaller values free more context but summarize more aggressively.

## How it works

Pi checks whether to auto-compact after each agent run (`agent_end`), using the last assistant message's `usage.totalTokens`.

When this extension detects that a model-specific threshold has been exceeded, it inflates that usage value above the context window.  Pi's `_checkCompaction()` then fires its normal pipeline:

1. "Auto-compacting…" loader
2. Compaction + summary message
3. Automatic flush of messages queued during compaction

The inflated usage is ephemeral — compaction rebuilds agent messages from the session file, so the mutation doesn't persist.

### Why not `ctx.compact()`?

Extensions can't access InteractiveMode's compaction queue (the mechanism behind "Queued message for after compaction").  Calling `ctx.compact()` directly works for the compaction itself, but skips the compaction-summary UI and won't auto-send messages the user typed while compaction was in progress. Nudging Pi's built-in pipeline preserves the full native UX.
