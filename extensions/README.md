# Extensions

## New or locally modified

- ● [`repoprompt-mcp/`](repoprompt-mcp/) ([README](./repoprompt-mcp/README.md))
  - Pi-compatible, token-efficient proxy for the RepoPrompt MCP server with RP-bespoke features:
    - Window/tab binding that prevents user/agent or agent/agent clobbering: auto-detects by `cwd`, optional persistence and restoration per session, interactive binding resolution in case of multiple windows containing the required root, and manual selection via `/rp bind`
    - Output rendering: diff highlighting, syntax highlighting (file reads and codemaps)
    - Safety guardrails: blocks deletes unless `allowDelete: true`, optional edit confirmation gate (`confirmEdits`)

- ● [`repoprompt-cli.ts`](repoprompt-cli.ts)
  - [RepoPrompt](https://repoprompt.com/docs) bridge for Pi: `rp_bind` + `rp_exec`
  - `rp_exec` wraps `rp-cli -e ...` with safe defaults (quiet, fail-fast, timeout, output truncation)
  - Safety features: blocks unbound usage, delete-like commands (unless `allowDelete=true`), and in-place workspace switching (unless explicitly allowed)
  - Syntax-highlights fenced code blocks; diff blocks get word-level change highlighting
  - Persists the current RepoPrompt window/tab binding across session reloads
  - Edit ergonomics: detects no-op edits and fails loudly by default (set `failOnNoopEdits=false` to allow intentional no-ops)
  - Used by [Pi × RP-CLI AGENTS.md guidance](../AGENTS-rp-cli-prefix.md), [RP-CLI prompts](../prompts/README.md#for-repoprompt-cli-rp-cli), and this [skill](../skills/repoprompt-tool-guidance-refresh/) for keeping it all up-to-date with new RepoPrompt versions

<p align="center">
  <img width="450" alt="repoprompt syntax highlighting example" src="https://github.com/user-attachments/assets/a416af2c-6f8e-4141-8040-abb8492eda7b" />
</p>

- ● [`md.ts`](md.ts)
  - `/md` exports the current Pi session to a legible Markdown transcript in `~/.pi/agent/pi-sessions-extracted/`
  - `/md thinking` includes thinking blocks

- ● [`commands.ts`](commands.ts)
  - `/commands` — compact overlay for built-in commands, extension commands, prompts, and skills (for when the `/` menu gets long)
  - Shortcuts: `ctrl+/` and `F1`

<p align="center">
  <img width="450" alt="commands overlay" src="https://github.com/user-attachments/assets/b32ba300-62ce-47b2-89b6-25c7cfa2bcbc" />
</p>

- ● [`ephemeral-mode.ts`](ephemeral-mode.ts)
  - `/ephemeral` toggles whether the current session file is deleted on exit (otherwise only possible via pre-committing `pi --no-session`), preventing throwaway sessions from cluttering `/resume`
  - Shortcut: `alt+e`

- ● [`model-sysprompt-appendix.ts`](model-sysprompt-appendix.ts) + [`model-sysprompt-appendix.json`](model-sysprompt-appendix.json)
  - Appends a per-model appendix to the system prompt (exact match or default).  Helpful for Claude models with confused identities (e.g. Opus 4.5, without a system prompt guiding it otherwise, assuming itself to be Sonnet 3.5 and low in capability)
  - `/model-sysprompt-appendix reload|status`

- ● [`notify.ts`](notify.ts)
  - Desktop / sound / Pushover notifications (e.g. to smart watch) when an agent turn completes and exceeds a duration threshold
  - Sound aliases include `random` (randomly picks from configured list of sounds)
  - Volume modes: `constant` or `timeScaled`
  - `/notify` interactive menu, plus quick toggles (`/notify on|off|popup|pushover|volume|<seconds>|<sound>`)
  - Config file lives at `~/.pi/agent/extensions/notify.json` (example: [`notify.json.example`](notify.json.example))

<p align="center">
  <img width="270" alt="notify menu" src="https://github.com/user-attachments/assets/474af589-ee3e-423d-a800-4331f2517676" />
</p>

- ◐ [`plan-mode.ts`](plan-mode.ts) (upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions))
  - `/plan` (and `ctrl+alt+p`) toggles a read-only sandbox
  - No todo extraction or step execution prompting (planning stays on the user)
  - Restricts tools, blocks destructive shell commands, and blocks RepoPrompt write operations
    - Covers `rp_exec`, `rp-cli -e ...`, and `rp` (repoprompt-mcp)

- ◐ [`raw-paste.ts`](raw-paste.ts) (upstream: [tmustier/pi-extensions](https://github.com/tmustier/pi-extensions))
  - `/paste` arms raw paste for the next paste operation
  - This version adds `alt+v` performing both arm + paste directly from the clipboard, preserving newlines (bracketed paste handling)

- ◐ [`oracle.ts`](oracle.ts) (upstream: [hjanuschka/shitty-extensions](https://github.com/hjanuschka/shitty-extensions/tree/main))
  - `/oracle` queries an alternate model for a second opinion, with optional file inclusion (`-f`) and injection into the current conversation
  - This version adds a thinking-level picker

- ◐ [`skill-palette/`](skill-palette/) (upstream: [pi-skill-palette](https://github.com/nicobailon/pi-skill-palette))
  - Skill command palette (`/skill`)
  - This version's scanning order matches Pi/Codex/Claude conventions and avoids symlink cycles when scanning skill dirs

- ◐ [`tools.ts`](tools.ts) + [`tools-config.json`](tools-config.json) (upstream: )
  - `/tools` interactive enable/disable UI
  - This version persists tool enablement globally (`~/.pi/agent/extensions/tools-config.json`) and per-session via session entries

- ◐ [`usage-bar.ts`](usage-bar.ts) (upstream: )
  - `/usage` usage overlay for multiple providers, with provider status polling and reset countdowns
  - This version adds `alt+u` shortcut

## Vendored extensions (have their own READMEs)

- ○ [`async-subagents/`](async-subagents/) (upstream: [nicobailon/pi-async-subagents](https://github.com/nicobailon/pi-async-subagents))
- ◐ [`guardrails/`](guardrails/) — security hooks: `prevent-brew`, `protect-paths`, `permission-gate` (upstream: [aliou/pi-extensions](https://github.com/aliou/pi-extensions))
  - `protect-paths` merges upstream's `protect-env-files` + `protected-paths` with broader coverage (all tools, bash command parsing, context-aware errors)
- ○ [`pi-prompt-template-model/`](pi-prompt-template-model/) (upstream: [nicobailon/pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model))
- ○ [`rewind/`](rewind/) (upstream: [nicobailon/pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook))

## Other extensions in this folder

Single-file extensions (see file headers):

Upstream: [pi-mono examples](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions)
- ○ `confirm-destructive.ts`
- ○ `interactive-shell.ts`
- ○ `mac-system-theme.ts`
- ○ `preset.ts`
- ○ `protected-paths.ts`
- ○ `question.ts`
- ○ `review.ts`
- ○ `send-user-message.ts`
- ○ `status-line.ts`
- ○ `todo.ts`

Other:
- ○ [`code-actions/`](code-actions/) (upstream: [tmustier/pi-extensions](https://github.com/tmustier/pi-extensions))
  - `/code` to pick code blocks or inline code from recent assistant messages, then copy or insert
  - Type to search; enter to copy, right arrow to insert in the command line
- ○ `speedreading.ts` (upstream: [hjanuschka/shitty-extensions](https://github.com/hjanuschka/shitty-extensions/tree/main))
- ◐ `ultrathink.ts` (upstream: [hjanuschka/shitty-extensions](https://github.com/hjanuschka/shitty-extensions/tree/main))
