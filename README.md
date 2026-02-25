# .π

Extensions, skills, prompts, and themes for [Pi coding agent](https://github.com/badlogic/pi-mono).  There is an emphasis here on making Pi and [RepoPrompt](https://repoprompt.com) co-operate well.

> This is a personal collection.  Some items are original, some adapted from the Pi community, some used unadapted.  It's tailored to my workflow and may introduce breaking changes without notice.  Unadapted items may lag well behind their upstream versions.  Extensions published as [Pi packages](#install-individual-extensions-from-npm) receive more careful maintenance.

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
        "extensions/vog/index.ts"
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
| [pi-brave-search](https://www.npmjs.com/package/pi-brave-search) | brave-search |
| [pi-command-center](https://www.npmjs.com/package/pi-command-center) | command-center |
| [pi-ephemeral](https://www.npmjs.com/package/pi-ephemeral) | ephemeral-mode |
| [pi-fork-from-first](https://www.npmjs.com/package/pi-fork-from-first) | fork-from-first |
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
| [pi-voice-of-god](https://www.npmjs.com/package/pi-voice-of-god) | vog |

### What the Pi package includes

This repo contains more resources than the package exports. When installed as a Pi package, Pi will discover only the resources declared in [`package.json`](package.json):

**Extensions**

| | Extension | Notes |
|---|---|---|
| ◐ | `agentic-compaction/` | Summarizer explores conversation as a filesystem |
| ● | `brave-search/` | Web search + content extraction. Requires `BRAVE_API_KEY`. 🔄 Consider [pi-web-access](https://github.com/nicobailon/pi-web-access) for general-purpose agent search |
| ● | `command-center/` | /command palette widget |
| ◐ | `editor-enhancements/` | File picker, shell completions, raw paste |
| ● | `ephemeral-mode.ts` | Delete session on exit |
| ● | `fork-from-first.ts` | Quickly fork session from first message |
| ◐ | `handover/` | Generate handover draft -> fork-from-first -> prefill editor (default to conversation-only fork if coinstalled with `rewind/`) |
| ● | `iterm-tab-color.ts` | Two-state tab coloring (running vs. not-running) for iTerm2 |
| ● | `md.ts` | Export session or last N turns to Markdown |
| ● | `model-aware-compaction/` | Per-model compaction thresholds |
| ● | `model-sysprompt-appendix/` | Per-model system prompt additions |
| ● | `move-session.ts` | Move session to a different cwd |
| ◐ | `oracle.ts` | Second opinion from alternate model |
| ◐ | `plan-mode.ts` | Read-only planning sandbox |
| ● | `poly-notify/` | Desktop / sound / Pushover notifications |
| ● | `protect-paths.ts` | Directory protection, brew prevention, extra command gates. 🔄 Replaces the path/brew hooks from old `guardrails/`; install [`@aliou/pi-guardrails`](https://github.com/aliou/pi-extensions) for `.env` protection + AST-based dangerous command gates |
| ● | `repoprompt-cli/` | RepoPrompt bridge via rp-cli with syntax/diff rendering, read-cache token savings, branch-safe binding, and branch-safe auto-selection replay for read slices/files |
| ● | `repoprompt-mcp/` | RepoPrompt MCP proxy with syntax and diff rendering, read-cache token savings, and branch-safe window binding and auto-selection of slices read for RP Chat |
| ● | `roam/` | Post-hoc tmux handoff for remote (e.g. mobile) continuation of Pi sessions |
| ● | `rp-native-tools-lock/` | Prefer RP tools over Pi native tools |
| ◐ | `sandbox/` | OS-level sandboxing |
| ● | `session-ask/` | Query session history via subagent |
| ◐ | `session-switch.ts` | `/resume`-style session picker (via `/switch-session`), with live background preview of selected session |
| ◐ | `tools/` | Interactive tool enable/disable |
| ◐ | `usage-bar.ts` | Provider quota overlay |
| ● | `vog/` | Inject custom system prompt message |

**Themes**

| | Theme |
|---|---|
| ● | `themes/violet-dawn.json` |
| ● | `themes/violet-dusk.json` |

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
| ◐ | `branch-term.ts` |
| ● | `brave-search/` |
| ○ | `code-actions/` |
| ● | `command-center/` |
| ● | `dedup-agents-files.ts` |
| ◐ | `editor-enhancements/` |
| ● | `ephemeral-mode.ts` |
| ◐ | `extension-stats.ts` |
| ● | `fork-from-first.ts` |
| ◐ | `handover/` |
| ○ | `inline-bash.ts` |
| ○ | `interactive-shell.ts` |
| ● | `iterm-tab-color.ts` |
| ○ | `mac-system-theme.ts` |
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
| ○ | `questionnaire.ts` |
| ● | `repoprompt-cli/` |
| ● | `repoprompt-mcp/` |
| ○ | `review.ts` |
| ◐ | `rewind/` |
| ● | `roam/` |
| ● | `rp-native-tools-lock/` |
| ◐ | `sandbox/` |
| ○ | `send-user-message.ts` |
| ● | `session-ask/` |
| ◐ | `session-switch.ts` |
| ◐ | `skill-palette/` |
| ○ | `speedreading.ts` |
| ○ | `status-line.ts` |
| ○ | `subagent/` |
| ○ | `titlebar-spinner.ts` |
| ○ | `todos.ts` |
| ◐ | `tools/` |
| ◐ | `ultrathink.ts` |
| ◐ | `usage-bar.ts` |
| ● | `vog/` |

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
| ○ | `handoff.md` |
| ○ | `pickup.md` |
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
