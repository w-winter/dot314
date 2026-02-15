# Model-Aware Compaction for Pi (`pi-model-aware-compaction`)

Per-model context-usage thresholds for Pi's built-in auto-compaction, because different models have different context windows and different performance profiles near their context window limits.

This extension nudges Pi's native compaction pipeline at configurable percent-used thresholds, preserving the full built-in UX (loader, summary message, queued-message flush).

## Install

From npm:

```bash
pi install npm:pi-model-aware-compaction
```

From the dot314 git bundle (filtered install):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/model-aware-compaction/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Requirements

Pi auto-compaction must be enabled in `~/.pi/agent/settings.json`:

```json
{ "compaction": { "enabled": true } }
```

Compatible with compaction-summary extensions (e.g. `pi-agentic-compaction` via `session_before_compact`), since it triggers Pi's normal compaction pipeline rather than calling `ctx.compact()` directly.

## Configuration

Copy `config.json.example` to `config.json` in the extension's directory and edit:

```json
{
  "global": 70,
  "models": {
    "claude-opus-4-6": 85,
    "gpt-5.2*": 75
  }
}
```

| Key | Purpose |
|-----|---------|
| `global` | Default threshold (percent used) for models without a specific override |
| `models` | Per-model overrides keyed by model ID; supports `*` wildcards |

Compaction triggers when `used% >= threshold`.

### Tuning `reserveTokens`

Pi's own auto-compaction triggers when `usedTokens > contextWindow - reserveTokens`. If that fires before your model-aware threshold, Pi compacts first. To let model-aware thresholds take priority, lower `reserveTokens`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 9000,
    "keepRecentTokens": 15000
  }
}
```

## How it works

After each agent run, the extension checks context usage against the model-specific threshold. When exceeded, it inflates the last assistant message's `usage.totalTokens` past the context window size, causing Pi's `_checkCompaction()` to fire its normal pipeline. The inflated value is ephemeral — compaction rebuilds messages from the session file.

This approach preserves the full native compaction UX (loader, summary, queued-message flush) that would be lost by calling `ctx.compact()` directly.
