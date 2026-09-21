# `/btw`

`/btw [--mode <name>] [--model <provider/id|partial>] <prompt>` runs a child agent in the background while the current session continues working. The child receives the parent session's resolved conversation context, uses its own model-specific system prompt and project resources, and persists as a child session linked to the parent.

Requires Pi 0.86.0 or later.

`--model` resolves exact or fuzzy matches within the session's scoped models, preferring the current provider when multiple providers expose similar model IDs. `--mode` reads named configurations from project-level `.pi/modes.json` or the Pi agent directory's `modes.json`.

## Installation

Run the extension directly from a dot314 checkout:

```bash
pi -e ./extensions/btw/index.ts
```

When the checkout is your Pi agent directory, Pi discovers `extensions/btw/index.ts` automatically.

## Differences from upstream

This extension is derived from [Pasky's `btw.ts` in `pi-amplike`](https://github.com/pasky/pi-amplike/blob/main/extensions/btw.ts). It retains upstream's background execution, progress and result rendering, parent-linked child sessions, compaction continuation, optional child extensions, and Amp permission model.

This version adds:

- Conventional `--mode` and `--model` options in place of upstream's `-mode` and `-model` forms.
- Exact and fuzzy model selection within the session's scoped models. Unqualified queries prefer the current provider, and ranked matches are tried until one has usable request authentication.
- Explicit forwarding of the selected model's resolved API key, headers, and environment through Pi's current `ModelRuntime` request path. If the OAuth token for OpenAI Codex is missing, the error tells the user to run `/login openai-codex`.
- The complete projected parent-session context from Pi's session manager, including active compaction and branch-summary state, rather than only raw message entries.
- AST-based handling of compound Bash commands with `just-bash`. Every simple command must resolve to `allow`; an unparseable command is blocked unless `permissions.mode` is `yolo`.
- Focused tests for persisted child resources and lineage, request authentication, scoped model ranking, compaction completion, display helpers, and compound-command permissions.

## Child extensions

Child sessions load built-in tools without the parent's extensions. To load specific extensions in children, list them in `<agent-dir>/amplike.json`; relative paths resolve from the Pi agent directory:

```json
{
  "subagent": {
    "extensions": [
      "extensions/model-sysprompt-appendix/index.ts"
    ]
  }
}
```

## Bash permissions

Child Bash calls use Amp permission rules from `~/.config/amp/settings.json` and `<project>/.agents/settings.json`. Because background children cannot display confirmation prompts, only commands resolved to `allow` run. To allow every child Bash call, set the permission mode in `<agent-dir>/amplike.json`:

```json
{
  "permissions": {
    "mode": "yolo"
  }
}
```
