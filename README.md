# Tools and accessories for [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

- [extensions/](extensions/) ([README](extensions/README.md))
- [skills/](skills/) ([README](skills/README.md))
- [themes/](themes/)
- [AGENTS-prefaces/](AGENTS-prefaces/)
- [prompts/](prompts/) ([README](prompts/README.md))

The Pi resources I'm currently enjoying - some adapted from the community, some original.  There is an emphasis here on making Pi and RepoPrompt co-operate well.

## Provenance

- ● → new
- ◐ → from Pi community, modified
- ○ → from Pi community, unmodified

## Installation

### Install as a Pi package

**Requires Pi 0.50.0+** (see [packages.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md))

Install from git:

```bash
pi install git:github.com/w-winter/dot314
# (or with the raw URL)
pi install https://github.com/w-winter/dot314
```

Try it for a single run without installing:

```bash
pi -e git:github.com/w-winter/dot314
```

Project-local install (writes to `.pi/settings.json`):

```bash
pi install -l git:github.com/w-winter/dot314
```

After installing, use `pi config` to enable/disable individual extensions, skills, and themes.

Notes:
- `pi install ...` runs `npm install` in the package root automatically
- Some extensions store optional per-user config under `~/.pi/agent/extensions/<extension-name>/...` (e.g. `poly-notify`, `sandbox`, `tools`, `rp-native-tools-lock`). These files are not part of the package install and are created on-demand or are optional

### Install individual extensions from npm

If you only want one extension, you can install the per-extension npm packages (see `packages/` in this repo).

Example:

```bash
pi install npm:pi-repoprompt-cli
```

### What the Pi package includes

This repo contains more resources than the package exports. When installed as a Pi package, Pi will discover only the resources listed in [`package.json`](package.json):

**Extensions**
- ● `brave-search/`  (requires `BRAVE_API_KEY`)
- ● `editor-enhancements/`
- ● `ephemeral-mode.ts`
- ◐ `agentic-compaction/`
- ◐ `guardrails/`
- ● `md.ts`
- ● `model-sysprompt-appendix/`
- ● `poly-notify/`
- ◐ `oracle.ts`
- ◐ `plan-mode.ts`
- ● `repoprompt-cli.ts`
- ● `repoprompt-mcp/`
- ● `rp-native-tools-lock/`
- ◐ `sandbox/`
- ◐ `tools/`
- ◐ `usage-bar.ts`
- ● `vog/`

**Themes**
- ● `themes/violet-dawn.json`
- ● `themes/violet-dusk.json`

### Manual / symlink setup

If you prefer a local working-copy workflow, clone this repo anywhere:

```bash
git clone git@github.com:w-winter/dot314.git ~/path/to/dot314-agent
```

Then symlink what you want into `~/.pi/agent/`:

```bash
# Example: add one extension (single-file)
ln -s ~/path/to/dot314-agent/extensions/repoprompt-cli.ts ~/.pi/agent/extensions/

# Example: add all skills from this repo
ln -s ~/path/to/dot314-agent/skills/* ~/.pi/agent/skills/
```

Pi scans `~/.pi/agent/extensions/`, `skills/`, and `prompts/` for resources.

## Extensions

See [extensions/README.md](extensions/README.md) for descriptions

- ◐ `branch-term.ts`
- ● `brave-search/`
- ○ `code-actions/`
- ● `commands.ts`
- ○ `confirm-destructive.ts`
- ● `dedup-agents-files.ts`
- ◐ `editor-enhancements/`
- ● `ephemeral-mode.ts`
- ◐ `agentic-compaction/`
- ◐ `guardrails/`
- ○ `inline-bash.ts`
- ○ `interactive-shell.ts`
- ○ `mac-system-theme.ts`
- ● `md.ts`
- ● `model-sysprompt-appendix/`
- ● `poly-notify/`
- ◐ `oracle.ts`
- ○ `pi-prompt-template-model/`
- ◐ `plan-mode.ts`
- ○ `preset.ts`
- ○ `questionnaire.ts`
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
- ○ `subagent/`
- ○ `titlebar-spinner.ts`
- ○ `todos.ts`
- ◐ `tools/`
- ◐ `ultrathink.ts`
- ◐ `usage-bar.ts`
- ● `vog/`

## Skills

See [skills/README.md](skills/README.md)

Note: the Pi package does not export any skills. The skills in this repo are intended for local/symlink workflows.

- ● `repoprompt-tool-guidance-refresh/` (maintainer workflow; writes tracking files and edits docs)
- ◐ `text-search/`
- ◐ `dev-browser/`
- ◐ `xcodebuildmcp/`
- ○ `gdcli/`

## Prompts

See [prompts/README.md](prompts/README.md)

Note: prompts are not exported as part of the Pi package.

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
