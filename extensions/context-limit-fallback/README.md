# context-limit-fallback

Switches a Pi session to a configured larger-context model when the active model reaches its context-usage threshold.

> **Bespoke companion extension.** This is one of the more 'artisanal' extensions in this repository, similar to [`subagent-bridge`](../subagent-bridge/). It's designed to work alongside [`model-aware-compaction`](../model-aware-compaction/), which supplies the per-model compaction thresholds.

## Why

Occasionally, I prefer to wade fearlessly into the so-called ["dumb zone"](https://www.aihero.dev/why-the-anthropic-ralph-plugin-sucks#the-problem-with-anthropics-ralph-plugin) rather than let a session auto-compact when the active model reaches its configured threshold. While I don't recommend this as a default policy, it *can* be useful when compaction risks losing earlier context that still matters for an orchestrator agent's unfinished delegated work.

This can also buy the opportunity to prune accumulated tool-call payloads before deciding what context to retain (e.g., via [crstdr's diligent-context](https://github.com/crstdr/diligent-pi/tree/main/extensions/diligent-context)).

Lastly, [due to prefill effects](https://stencil.so/blog/prewalk), a lower-capability model with a larger context window can continue along a trajectory established by a higher-capability model with a smaller window, making that "dumb zone" a bit less dumb.

This extension offers the convenience to make these edge-case choices on a per-session basis: allow normal auto-compaction, or switch to the configured larger-context model and continue from there.

## What it does

At the end of each turn, the extension compares the active model's context usage with the threshold configured by `model-aware-compaction`. When the current session has an enabled fallback and usage reaches that threshold, it switches to the selected fallback model.

The fallback must be registered in Pi, have usable credentials, and expose a strictly larger context window than the active model. Once the fallback is active, subsequent checks are no-ops.

Thresholds come from `model-aware-compaction`: an exact model-ID key wins, then the first matching `*` pattern, then its required `global` value, so an installed, valid config always supplies a threshold. Only when that config is absent entirely does the switch use Pi's own native auto-compaction point instead — `usedTokens > contextWindow - reserveTokens`, reading `compaction.reserveTokens` from `~/.pi/agent/settings.json` (default 16384). A present but unreadable or malformed `model-aware-compaction` config is reported as an error and the switch is skipped for that turn rather than silently ignored.

After switching models, the extension applies that fallback entry's configured thinking level. Pi applies the level according to the target model's supported capabilities and remains responsible for compaction behavior.

## Configuration

Copy `config.json.example` to `config.json` beside the extension:

```json
{
  "fallback": {
    "enabled": false,
    "selected": "anthropic/claude-opus-4-8",
    "models": [
      {
        "model": "anthropic/claude-opus-4-8",
        "thinkingLevel": "xhigh"
      },
      {
        "model": "openai-codex/gpt-5.4",
        "thinkingLevel": "medium"
      }
    ]
  }
}
```

- `models` is the ordered set of fallback choices shown by `/context-limit-fallback`. Each entry requires a canonical `provider/modelId` `model` and a `thinkingLevel` of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `enabled` and `selected` provide defaults for sessions without an explicit fallback choice. A non-empty `selected` value must match an entry's `model`, and `enabled: true` requires a selection.

Manual config edits take effect after reloading the extension or restarting Pi.

Configure thresholds in the sibling `../model-aware-compaction/config.json`, keyed by model ID. Only `*` has wildcard meaning. Keep both extension directories as siblings when installing them outside this repository.

## Per-session command

Run `/context-limit-fallback` to disable automatic switching or choose a configured model and thinking level for the current session. The command stores the selected model reference in the Pi session, allowing concurrent sessions to use different fallback behavior without rewriting `config.json`.

Session choices survive resume. Forks inherit the choice from their ancestry, and `/tree` restores the latest choice on the selected branch. Registry model names and configured thinking levels appear in the menu while session state uses canonical `provider/modelId` references.

## Extension order

Load `context-limit-fallback` before `model-aware-compaction`. Both evaluate at the end of a turn; loading the fallback first lets it switch to the larger model before `model-aware-compaction` evaluates whether to start compaction.

## Failure policy

A successful model-and-thinking switch is announced in the UI. Missing models, unavailable credentials, invalid context windows, and failures before Pi activates the target leave the active model unchanged. If Pi reports a failure after the target becomes active, the extension still applies its configured thinking level and reports the retained model transition. If applying that level reports an error, the extension reports the active target and the configured level without assuming whether Pi persisted the change. Invalid saved session choices are reported when the session or branch is loaded.
