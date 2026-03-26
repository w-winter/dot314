# .π

Extensions, skills, prompts, and themes for [Pi coding agent](https://github.com/badlogic/pi-mono).  There is an emphasis here on making Pi and [RepoPrompt](https://repoprompt.com) co-operate well.

> This collection is tailored to my workflow and preferences.  I may introduce breaking changes without notice.  While most of the extensions are original or modified, some that were authored by others are republished here unmodified, and those may lag well behind their upstream versions.  Extensions published as [Pi packages](#install-individual-extensions-from-npm) receive my active maintenance.

## Provenance key

- ● → new
- ◐ → from Pi community, modified
- ○ → from Pi community, unmodified

## Quick start

```bash
pi install git:github.com/w-winter/dot314    # install the package
pi config                                     # enable/disable individual extensions and themes
```

Or try it for a single run without installing:

```bash
pi -e git:github.com/w-winter/dot314
```

## Installation

### Install as a Pi package

**Requires Pi 0.50.0+** (see [packages.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md))

Install from git:

```bash
pi install git:github.com/w-winter/dot314
# (or with the raw URL)
pi install https://github.com/w-winter/dot314
```

Project-local install (writes to `.pi/settings.json`):

```bash
pi install -l git:github.com/w-winter/dot314
```

After installing, use `pi config` to enable/disable individual extensions, skills, and themes. You can also filter in `settings.json` - for example:

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": [
        "extensions/repoprompt-mcp/src/index.ts",
        "extensions/rp-native-tools-lock/index.ts",
        "extensions/session-ask/index.ts",
        "extensions/anycopy/index.ts"
      ]
    }
  ]
}
```

Use `!path` to exclude specific extensions, or list only the ones you want. See [package filtering](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md#package-filtering) for the full syntax.

Notes:
- `pi install ...` runs `npm install` in the package root automatically
- Some extensions store optional per-user config under `~/.pi/agent/extensions/<extension-name>/...` (e.g. `poly-notify`, `sandbox`, `tools`, `rp-native-tools-lock`). These files are not part of the package install and are created on-demand or are optional

### Install individual extensions from npm

If you only want one extension, you can install the per-extension npm packages (see [`packages/`](packages/) in this repo).

Example:

```bash
pi install npm:pi-repoprompt-cli
```

All available npm packages:

| npm package | Extension |
|---|---|
| [pi-anycopy](https://www.npmjs.com/package/pi-anycopy) | anycopy |
| [pi-branch-out](https://www.npmjs.com/package/pi-branch-out) | branch-out |
| [pi-brave-search](https://www.npmjs.com/package/pi-brave-search) | brave-search |
| [pi-command-center](https://www.npmjs.com/package/pi-command-center) | command-center |
| [pi-ephemeral](https://www.npmjs.com/package/pi-ephemeral) | ephemeral-mode |
| [pi-fork-from-first](https://www.npmjs.com/package/pi-fork-from-first) | fork-from-first |
| [pi-grounded-compaction](https://www.npmjs.com/package/pi-grounded-compaction) | grounded-compaction |
| [pi-md-export](https://www.npmjs.com/package/pi-md-export) | md |
| [pi-model-aware-compaction](https://www.npmjs.com/package/pi-model-aware-compaction) | model-aware-compaction |
| [pi-model-sysprompt-appendix](https://www.npmjs.com/package/pi-model-sysprompt-appendix) | model-sysprompt-appendix |
| [pi-move-session](https://www.npmjs.com/package/pi-move-session) | move-session |
| [pi-plan-modus](https://www.npmjs.com/package/pi-plan-modus) | plan-mode |
| [pi-poly-notify](https://www.npmjs.com/package/pi-poly-notify) | poly-notify |
| [pi-repoprompt-cli](https://www.npmjs.com/package/pi-repoprompt-cli) | repoprompt-cli |
| [pi-repoprompt-mcp](https://www.npmjs.com/package/pi-repoprompt-mcp) | repoprompt-mcp |
| [pi-repoprompt-tools-lock](https://www.npmjs.com/package/pi-repoprompt-tools-lock) | rp-native-tools-lock |
| [pi-roam](https://www.npmjs.com/package/pi-roam) | roam |
| [pi-session-ask](https://www.npmjs.com/package/pi-session-ask) | session-ask |

### What the Pi package includes

This repo contains more resources than the package exports. When installed as a Pi package, Pi will discover only the resources declared in [`package.json`](package.json):

**Extensions**

| | Extension | Notes |
|---|---|---|
| ◐ | `agentic-compaction/` | Summarizer explores conversation as a filesystem |
| ● | `anycopy/` | `/tree` with live syntax-highlighted preview + copy: navigate branches, summarize, label, and copy any node(s) to clipboard |
| ◐ | `branch-out/` | Fork the current Pi session into a split terminal pane or new tab with rotating layout policies, and with optional model and message queuing |
| ● | `brave-search/` | Web search + content extraction. Requires `BRAVE_API_KEY`. 🔄 Consider [pi-web-access](https://github.com/nicobailon/pi-web-access) for general-purpose agent search |
| ◐ | `cmux.ts` | cmux sidebar integration + workspace auto-renaming synced to Pi session name; no-op outside cmux |
| ● | `command-center/` | /command palette widget |
| ◐ | `editor-enhancements/` | File picker, shell completions, raw paste, double-esc and slash command remapping |
| ● | `ephemeral-mode.ts` | Delete session on exit |
| ◐ | `files-touched.ts` | Widget listing files read/edited/written, with path normalizations, tracking of reads/edits/writes by Pi native tools, `repoprompt-cli`, `repoprompt-mcp`, and bash-level file operations |
| ● | `fork-from-first.ts` | Quickly fork session from first message |
| ● | `grounded-compaction/` | Compaction summarizer with model presets, custom prompts, and comprehensive files-touched tracking; also augments branch summarization |
| ◐ | `handover/` | Generate handover draft with deterministic files-touched list -> fork-from-first -> prefill editor (default to conversation-only fork if coinstalled with `rewind/`) |
| ● | `iterm-tab-color.ts` | Two-state tab coloring (running vs. not-running) for iTerm2 |
| ● | `md.ts` | Export full session branch or its last N turns to Markdown file, or as Markdown to clipboard |
| ● | `model-aware-compaction/` | Per-model compaction thresholds |
| ● | `model-sysprompt-appendix/` | Per-model system prompt additions |
| ● | `move-session.ts` | Move session to a different cwd |
| ◐ | `oracle.ts` | Second opinion from alternate model |
| ◐ | `plan-mode.ts` | Read-only planning sandbox with support for RepoPrompt tools |
| ● | `poly-notify/` | Desktop / sound / Pushover notifications |
| ● | `protect-paths.ts` | Directory protection, brew prevention, extra command gates. 🔄 Replaces the path/brew hooks from old `guardrails/`; install [`@aliou/pi-guardrails`](https://github.com/aliou/pi-guardrails) for `.env` protection + AST-based dangerous command gates |
| ● | `repoprompt-cli/` | RepoPrompt bridge via rp-cli with syntax/diff rendering, read-cache token savings, branch-safe binding, and branch-safe auto-selection replay for read slices/files |
| ● | `repoprompt-mcp/` | RepoPrompt MCP proxy with adaptive diff rendering (split/unified/compact/summary), collapsed tool outputs for non-LOC-mutating actions, syntax highlighting, read-cache token savings, automated and branch-safe window and tab binding, and automated branch-safe selection of files and slices read for RP Chat |
| ● | `reverse-thinking.ts` | Adds backward thinking-level cycling on `shift+alt+tab` |
| ● | `roam/` | Post-hoc tmux handoff for remote (e.g. mobile) continuation of Pi sessions |
| ● | `rp-native-tools-lock/` | Prefer RP tools over Pi native tools |
| ◐ | `sandbox/` | OS-level sandboxing |
| ● | `session-ask/` | Query session history via subagent |
| ◐ | `session-switch.ts` | `/resume`-style session picker (via `/switch-session`), with live background preview of selected session |
| ◐ | `tools/` | Interactive tool enable/disable |
| ◐ | `usage-bar.ts` | Provider quota overlay |

**Themes**

| | Theme |
|---|---|
| ● | `themes/violet-dawn.json` |
| ● | `themes/violet-dusk.json` |

### Recommended companion extensions

These extensions are not included in this repo but have also become established in my regular Pi sessions.  You can install them via `pi install`, or copy single files into `~/.pi/agent/extensions/`.

| Extension | Description | Install |
|---|---|---|
| [bookmark](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/bookmark.ts) | `/bookmark <label>` to label the last message in the session tree | Copy to `~/.pi/agent/extensions/` |
| [diff](https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/diff.ts) | `/diff` shows git-changed files and opens selected file in VS Code's diff view | Copy to `~/.pi/agent/extensions/` |
| [greprip](https://github.com/kaofelix/greprip) | Transparent interception of `grep`/`find` commands, translating them to `rg`/`fd` for speed | `uv tool install git+https://github.com/kaofelix/greprip` + [shell config](https://github.com/kaofelix/greprip#2-configure-pi) |
| [pi-guardrails](https://github.com/aliou/pi-guardrails) | `.env` file protection + AST-based dangerous command gates | `pi install npm:@aliou/pi-guardrails` |
| [pi-interview](https://github.com/nicobailon/pi-interview-tool) | Interactive form-based input gathering with native window support | `pi install npm:pi-interview` |
| [pi-nvim](https://github.com/aliou/pi-harness/tree/main/integrations/neovim) | Bidirectional Neovim integration: `nvim_context` tool, LSP diagnostics at turn end, file reload after edits, visible-splits injection | Neovim plugin; see [setup instructions](https://github.com/aliou/pi-harness/tree/main/integrations/neovim#installation) |
| [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) | Read-tool-kit context optimization for token efficiency | `pi install npm:pi-rtk-optimizer` |
| [pi-screenshots-picker](https://github.com/Graffioh/pi-screenshots-picker) | Quick screenshot selection and attachment for prompts | `pi install npm:pi-screenshots-picker` |
| [pi-token-burden](https://github.com/Whamp/pi-token-burden) | Token usage breakdown and context burden analysis | `pi install npm:pi-token-burden` |
| [pi-tool-display](https://github.com/MasuRii/pi-tool-display) | Compact tool call rendering with diff visualization.  ⚠ Collides with `sandbox/`, so enable only one | `pi install npm:pi-tool-display` |
| [pi-verbosity-control](https://github.com/ferologics/pi-verbosity-control) | Per-model OpenAI verbosity presets with configurable shortcut | `pi install npm:pi-verbosity-control` |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | Gemini-powered web search with AI-synthesized overviews and citations | `pi install npm:pi-web-access` |
| [whimsical](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/whimsical.ts) | Whimsical messages while the agent is working | Copy to `~/.pi/agent/extensions/` |

### Manual / symlink setup

If you prefer a local working-copy workflow, clone this repo anywhere:

```bash
git clone --recurse-submodules git@github.com:w-winter/dot314.git ~/path/to/dot314-agent
```

Then symlink what you want into `~/.pi/agent/`:

```bash
# Example: add one extension (single-file)
ln -s ~/path/to/dot314-agent/extensions/move-session.ts ~/.pi/agent/extensions/

# Example: add all skills from this repo
ln -s ~/path/to/dot314-agent/skills/* ~/.pi/agent/skills/
```

Pi scans `~/.pi/agent/extensions/`, `skills/`, and `prompts/` for resources.

---

## Everything in this repo

The sections below list all resources in this repository, including items not exported by the Pi package.

### Extensions

See [extensions/README.md](extensions/README.md) for full descriptions.

| | Extension |
|---|---|
| ◐ | `agentic-compaction/` |
| ● | `anycopy/` |
| ◐ | `branch-out/` |
| ● | `brave-search/` |
| ◐ | `cmux.ts` |
| ○ | `code-actions/` |
| ● | `command-center/` |
| ● | `dedup-agents-files.ts` |
| ◐ | `editor-enhancements/` |
| ● | `ephemeral-mode.ts` |
| ◐ | `extension-stats.ts` |
| ◐ | `files-touched.ts` |
| ● | `fork-from-first.ts` |
| ● | `grounded-compaction/` |
| ◐ | `handover/` |
| ○ | `inline-bash.ts` |
| ○ | `interactive-shell.ts` |
| ● | `iterm-tab-color.ts` |
| ● | `md.ts` |
| ● | `model-aware-compaction/` |
| ● | `model-sysprompt-appendix/` |
| ● | `move-session.ts` |
| ◐ | `oracle.ts` |
| ○ | `pi-prompt-template-model/` |
| ◐ | `plan-mode.ts` |
| ● | `poly-notify/` |
| ○ | `preset.ts` |
| ● | `protect-paths.ts` |
| ● | `reverse-thinking.ts` |
| ● | `repoprompt-cli/` |
| ● | `repoprompt-mcp/` |
| ◐ | `rewind/` |
| ● | `roam/` |
| ● | `rp-native-tools-lock/` |
| ◐ | `sandbox/` |
| ● | `session-ask/` |
| ◐ | `session-switch.ts` |
| ◐ | `skill-palette/` |
| ○ | `subagent/` |
| ○ | `titlebar-spinner.ts` |
| ○ | `todos.ts` |
| ◐ | `tools/` |
| ◐ | `usage-bar.ts` |

### Skills

The Pi package does not export any skills. The skills in this repo are intended for local/symlink workflows.

See [skills/README.md](skills/README.md) for full descriptions.

| | Skill | Notes |
|---|---|---|
| ○ | `agent-browser/` | |
| ◐ | `dev-browser/` | 🔄 Prefer [surf/](skills/surf/) for browsing/scraping, [agent-browser/](skills/agent-browser/) for structured testing |
| ○ | `gdcli/` | |
| ● | `repoprompt-tool-guidance-refresh/` | Maintainer workflow |
| ○ | `surf/` | |
| ◐ | `text-search/` | |
| ◐ | `xcodebuildmcp/` | |

### Prompts

Prompts are not exported as part of the Pi package.

See [prompts/README.md](prompts/README.md) for full descriptions.

**`/command` prompts**

| | Prompt |
|---|---|
| ● | `rp-address-review.md` |
| ● | `rp-plan.md` |
| ● | `rp-review-chat.md` |

**AGENTS.md prefaces for reliable RepoPrompt tool usage** — see [AGENTS-prefaces/README.md](AGENTS-prefaces/README.md)

| | Preface |
|---|---|
| ● | `AGENTS-prefaces/rp-cli-preface.md` |
| ● | `AGENTS-prefaces/rp-mcp-preface.md` |
| ● | `AGENTS-prefaces/rp-mcp-preface-exPi.md` |

### Themes

| | Theme |
|---|---|
| ● | `violet-dawn.json` |
| ● | `violet-dusk.json` |
