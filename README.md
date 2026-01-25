# Tools and accessories for [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

- [extensions/](extensions/) ([README](extensions/README.md))
- [skills/](skills/) ([README](skills/README.md))
- [themes/](themes/)
- [AGENTS-prefaces/](AGENTS-prefaces/)
- [prompts/](prompts/) ([README](prompts/README.md))

The Pi resources I'm currently enjoying - some adapted from the community, some original.  There is an emphasis here on making Pi and RepoPrompt co-operate well.

## Installation

Clone this repo anywhere:

    git clone git@github.com:w-winter/dot314.git ~/path/to/dot314-agent

Then symlink what you want into `~/.pi/agent/`:

    # Example: add one extension
    ln -s ~/path/to/dot314-agent/extensions/repoprompt-mcp.ts ~/.pi/agent/extensions/

    # Example: add all skills from this repo
    ln -s ~/path/to/dot314-agent/skills/* ~/.pi/agent/skills/

Pi scans `~/.pi/agent/extensions/`, `skills/`, and `prompts/` for resources.

## Extensions

- ● → new
- ◐ → from pi community, modified
- ○ → from pi community, unmodified

See [extensions/README.md](extensions/README.md) for descriptions

- ○ `async-subagents/`
- ○ `code-actions/`
- ● `commands.ts`
- ○ `confirm-destructive.ts`
- ● `ephemeral-mode.ts`
- ◐ `guardrails/`
- ○ `inline-bash.ts`
- ○ `interactive-shell.ts`
- ○ `mac-system-theme.ts`
- ● `md.ts`
- ● `model-sysprompt-appendix/`
- ● `notify/`
- ◐ `oracle.ts`
- ○ `pi-prompt-template-model/`
- ◐ `plan-mode.ts`
- ○ `preset.ts`
- ○ `protected-paths.ts`
- ○ `questionnaire.ts`
- ◐ `raw-paste.ts`
- ● `repoprompt-cli.ts`
- ● `repoprompt-mcp/`
- ○ `review.ts`
- ◐ `rewind/`
- ● `rp-native-tools-lock/`
- ◐ `sandbox/`
- ○ `send-user-message.ts`
- ◐ `skill-palette/`
- ○ `speedreading.ts`
- ○ `status-line.ts`
- ○ `todos.ts`
- ◐ `tools/`
- ◐ `ultrathink.ts`
- ◐ `usage-bar.ts`
- ● `vog/`

## Skills

See [skills/README.md](skills/README.md)

- ● `repoprompt-tool-guidance-refresh/`
- ◐ `text-search/`
- ◐ `dev-browser/`
- ◐ `xcodebuildmcp/`
- ○ `brave-search/`
- ○ `gdcli/`

## Prompts

See [prompts/README.md](prompts/README.md)

### /command prompts

- ○ `handoff.md`
- ○ `pickup.md`
- ● `rp-review-chat.md`
- ● `rp-address-review.md`

### AGENTS.md prefaces for reliable RepoPrompt tool usage

See [AGENTS-prefaces/README.md](AGENTS-prefaces/README.md)

- ● `AGENTS-prefaces/rp-cli-preface.md`
- ● `AGENTS-prefaces/rp-mcp-preface.md`
- ● `AGENTS-prefaces/rp-mcp-preface-exPi.md`

## Themes

- ● `violet-dawn.json`
- ● `violet-dusk.json`
