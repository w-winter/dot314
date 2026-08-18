# .π

Extensions, skills, prompts, and themes for the [Pi coding agent](https://github.com/badlogic/pi-mono).  Several of the extensions and prompts are designed to facilitate integration of Pi and [RepoPrompt](https://repoprompt.com/docs#s=overview).

This collection is tailored to my workflow and preferences.  I may introduce breaking changes without notice.  While most of the extensions are original or modified, some that were authored by others are republished here unmodified, and those may lag well behind their upstream versions.  Extensions published as [Pi packages](#install-individual-extensions-from-npm) receive my active maintenance.

## Provenance key

| Symbol | Meaning |
|--------|-------------------------|
| ● | original |
| ◐ | forked & modified |
| ○ | republished unmodified |

## Quick start

```bash
pi install git:github.com/w-winter/dot314    # install the package
pi config                                    # enable/disable individual extensions and themes
```

Or try it for a single run without installing:

```bash
pi -e git:github.com/w-winter/dot314
```

## Installation

### Install as a Pi package

**Requires Pi 0.63.1+** (see [packages.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md))

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

After installing, use `pi config` to enable/disable individual extensions, skills, and themes. You can also filter in `settings.json`, as in this example:

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": [
      "./extensions/anycopy/index.ts",
      "./extensions/branch-out/index.ts",
      "./extensions/command-center/index.ts",
      "./extensions/editor-enhancements/index.ts",
      "./extensions/ephemeral-mode.ts",
      "./extensions/files-touched.ts",
      "./extensions/grounded-compaction/index.ts",
      "./extensions/model-aware-compaction/index.ts",
      "./extensions/move-session.ts",
      "./extensions/repoprompt-mcp/src/index.ts",
      "./extensions/session-ask/index.ts",
      "./extensions/session-switch/index.ts"
      ]
    }
  ]
}
```

Use `!path` to exclude specific extensions, or list only the ones you want. See [package filtering](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md#package-filtering) for the full syntax.

Notes:
- `pi install ...` runs `npm install` in the package root automatically
- Some extensions store optional per-user config under `~/.pi/agent/extensions/<extension-name>/...` (e.g. `poly-notify`, `sandbox`, `tools`, `rp-native-tools-lock`).  These files are not part of the package install and are created on-demand or are optional.

### Install individual extensions from npm

Many extensions are also published as standalone npm packages (see the npm column [below](#included-in-the-pi-package)).  They can be installed with:

```bash
pi install npm:<package-name>
```

For example, `pi install npm:pi-repoprompt-mcp`.

See [`packages/`](packages/) for all available npm packages.

---

## Extensions

See [extensions/README.md](extensions/README.md) for more detailed descriptions.

### Included in the Pi package

| | Extension | npm | Description |
|---|---|---|---|
| ● | `anycopy/` | [`pi-anycopy`](https://www.npmjs.com/package/pi-anycopy) | `/tree` with live syntax-highlighted preview + copy |
| ● | `assistant-provenance/` | [`pi-assistant-provenance`](https://www.npmjs.com/package/pi-assistant-provenance) | Gives models awareness of mid-session model switches |
| ◐ | `branch-out/` | [`pi-branch-out`](https://www.npmjs.com/package/pi-branch-out) | Fork session into split pane or new tab with layout policies and optional model/message queuing |
| ● | `brave-search/` | [`pi-brave-search`](https://www.npmjs.com/package/pi-brave-search) | Web search + content extraction. 🔄 Consider [pi-web-access](https://github.com/nicobailon/pi-web-access) for general-purpose search |
| ◐ | `cmux/` | | cmux sidebar integration + workspace auto-renaming; no-op outside cmux |
| ● | `command-center/` | [`pi-command-center`](https://www.npmjs.com/package/pi-command-center) | `/command` palette widget |
| ◐ | `editor-enhancements/` | | File picker, shell completions, raw paste, double-esc and slash command remapping |
| ● | `ephemeral-mode.ts` | [`pi-ephemeral`](https://www.npmjs.com/package/pi-ephemeral) | Delete session on exit |
| ◐ | `files-touched.ts` | | Files read/modified widget with path normalization and tracking coverage of Pi-native tools, RepoPrompt, recognized `bash`/`exec_command` shell operations, and `apply_patch` |
| ● | `fork-from-first.ts` | [`pi-fork-from-first`](https://www.npmjs.com/package/pi-fork-from-first) | Quickly fork session from first message to establish parent-child lineage in a blank new session |
| ● | `grounded-compaction/` | [`pi-grounded-compaction`](https://www.npmjs.com/package/pi-grounded-compaction) | Compaction summarizer with model presets, custom prompts, shared files-touched tracking, and cross-provider checkpoint summaries |
| ◐ | `handover/` | | Handover draft with files-touched → fork-from-first → prefill editor |
| ● | `iterm-tab-color.ts` | | Two-state tab coloring (running vs. idle) for iTerm2 |
| ● | `md.ts` | [`pi-md-export`](https://www.npmjs.com/package/pi-md-export) | Export session branch or last N turns to Markdown file or clipboard |
| ● | `model-aware-compaction/` | [`pi-model-aware-compaction`](https://www.npmjs.com/package/pi-model-aware-compaction) | Per-model compaction thresholds |
| ● | `model-sysprompt-appendix/` | [`pi-model-sysprompt-appendix`](https://www.npmjs.com/package/pi-model-sysprompt-appendix) | Per-model system prompt additions |
| ● | `move-session.ts` | [`pi-move-session`](https://www.npmjs.com/package/pi-move-session) | Move current active session to a new cwd |
| ◐ | `plan-mode.ts` | [`pi-plan-modus`](https://www.npmjs.com/package/pi-plan-modus) | Read-only planning sandbox with RepoPrompt support |
| ● | `poly-notify/` | [`pi-poly-notify`](https://www.npmjs.com/package/pi-poly-notify) | Desktop / sound / Pushover notifications |
| ● | `protect-paths/` | | Directory protection with configurable trusted read paths, brew prevention, and command gates. Pair with [`@aliou/pi-guardrails`](https://github.com/aliou/pi-guardrails) for `.env` protection |
| ● | `repoprompt-mcp/` | [`pi-repoprompt-mcp`](https://www.npmjs.com/package/pi-repoprompt-mcp) | RepoPrompt MCP proxy with adaptive diff rendering, collapsed outputs, read-cache, and branch-safe binding |
| ● | `reverse-thinking.ts` | | Backward thinking-level cycling on `shift+alt+tab` |
| ● | `roam/` | [`pi-roam`](https://www.npmjs.com/package/pi-roam) | Post-hoc tmux handoff for remote continuation of sessions |
| ● | `rp-native-tools-lock/` | [`pi-repoprompt-tools-lock`](https://www.npmjs.com/package/pi-repoprompt-tools-lock) | Prefer RP tools over Pi native tools |
| ◐ | `sandbox/` | | OS-level sandboxing |
| ● | `session-ask/` | [`pi-session-ask`](https://www.npmjs.com/package/pi-session-ask) | Query "pre-historical" context (post-compaction, post-fork/handoff) via subagent |
| ◐ | `session-switch/` | | `/resume`-style session picker with live preview, plus `pi --switch-session` startup relaunch |
| ● | `skill-templates/` | [`pi-skill-templates`](https://www.npmjs.com/package/pi-skill-templates) | Nunjucks-templated `SKILL.template.md` skills rendered from invocation args, options, and flags, and composed from other skills |
| ◐ | `tools/` | | UI for enabling/disabling active Pi tools |
| ◐ | `usage-bar.ts` | | Provider quota overlay |

### Also included

These extensions are tracked in the repository but not exported by the Pi package.

| | Extension |
|---|---|
| ○ | `code-actions/` |
| ● | `codex-compaction-coordinator/` |
| ● | `computer-use-toggle.ts` |
| ● | `context-limit-fallback/` |
| ◐ | `extension-stats.ts` |
| ● | `inline-shell.ts` |
| ○ | `interactive-shell.ts` |
| ● | `orca-session-tab-title/` |
| ○ | `preset.ts` |
| ● | `repoprompt-cli/` |
| ◐ | `rewind/` — if not using `anycopy`, then use upstream [`pi-rewind-hook`](https://github.com/nicobailon/pi-rewind-hook) |
| ● | `subagent-bridge/` |
| ○ | `titlebar-spinner.ts` |
| ○ | `todos.ts` |
| ◐ | `tool-horizon/` |

### Other recommended extensions

These other extensions have also improved my QoL in Pi, so I recommend checking them out.

| Extension | Description | Install |
|---|---|---|
| [bookmark](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/bookmark.ts) (badlogic) | `/bookmark <label>` to label the last message in the session tree | Copy to `~/.pi/agent/extensions/` |
| [diff](https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/diff.ts) (badlogic) | `/diff` shows git-changed files and opens selected file in VS Code's diff view | Copy to `~/.pi/agent/extensions/` |
| [diligent-pi](https://github.com/crstdr/diligent-pi) (crstdr) | `/diligent-context` hides past tool calls from the context, a useful alternative to compaction in some types of sessions |  |
| [greprip](https://github.com/kaofelix/greprip) (kaofelix) | Transparent interception of `grep`/`find` commands, translating them to `rg`/`fd` for speed | `uv tool install git+https://github.com/kaofelix/greprip` + [shell config](https://github.com/kaofelix/greprip#2-configure-pi) |
| [loop](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/loop.ts) (mitsuhiko) | `/loop` starts a follow-up loop with a breakout condition | Copy to `~/.pi/agent/extensions/` |
| [pi-codex-conversion](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-codex-conversion) (IgorWarzocha) | Codex-shaped tools for openai-codex models, plus Responses compaction, model verbosity controls, cached transport, and other niceties | `pi install npm:@howaboua/pi-codex-conversion` |
| [pi-codex-goal](https://github.com/fitchmultz/pi-codex-goal) (fitchmultz) | Durable Codex-style `/goal` command with `get_goal`, `create_goal`, and `update_goal` tools; goal state persists across compaction and session recovery | `pi install npm:pi-codex-goal` |
| [pi-computer-use](https://github.com/injaneity/pi-computer-use) (injaneity) | Desktop app observation and interaction tools for macOS, Windows, and Linux | `pi install npm:@injaneity/pi-computer-use` |
| [pi-guardrails](https://github.com/aliou/pi-guardrails) (aliou) | `.env` file protection + AST-based dangerous command gates | `pi install npm:@aliou/pi-guardrails` |
| [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) (HazAT) | Spawn, orchestrate, and manage async subagent sessions in multiplexer cmux panes; main agent keeps working while subagents run in the background | `pi install git:github.com/HazAT/pi-interactive-subagents` |
| [pi-intercom](https://github.com/nicobailon/pi-intercom) (nicobailon) | Direct 1:1 messaging between Pi sessions; augments subagents nicely | `pi install npm:pi-intercom` |
| [pi-interview](https://github.com/nicobailon/pi-interview-tool) (nicobailon) | Interactive form-based input gathering with native window support | `pi install npm:pi-interview` |
| [pi-invisible-continue](https://github.com/monotykamary/pi-invisible-continue) (monotykamary) | `/continue` resumes the agent loop without adding prompt text to the LLM context | `pi install npm:pi-invisible-continue` |
| [pi-model-sort](https://github.com/monotykamary/pi-model-sort) (monotykamary) | Sorts model lists by recent usage and restores per-model thinking levels | `pi install npm:pi-model-sort` |
| [pi-model-thinking](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-model-thinking) (ogulcancelik) | Stores and recalls last-selected thinking level per model | `pi install npm:@ogulcancelik/pi-model-thinking` |
| [pi-nvim](https://github.com/aliou/pi-harness/tree/main/integrations/neovim) (aliou) | Bidirectional Neovim integration: `nvim_context` tool, LSP diagnostics at turn end, file reload after edits, visible-splits injection | Neovim plugin; see [setup instructions](https://github.com/aliou/pi-harness/tree/main/integrations/neovim#installation) |
| [pi-prompt-template-model](https://github.com/nicobailon/pi-prompt-template-model) (nicobailon) | Adds `model`, `skill`, and `thinking` frontmatter to pi prompt templates and chained prompt template execution | `pi install npm:pi-prompt-template-model` |
| [pi-queue-steer](https://github.com/tmustier/pi-queue-steer) (tmustier) | Cursor-inspired visible steering and follow-up timeline: queue instructions while the agent works, with editable steering (next turn) and follow-up (after run) lanes | `pi install git:github.com/tmustier/pi-queue-steer` |
| [pi-retry](https://github.com/monotykamary/pi-retry) (monotykamary) | Automatically retries most errors with capped backoff and continues after output-token limits | `pi install https://github.com/monotykamary/pi-retry` |
| [pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) (MasuRii) | Read-tool-kit context optimization for token efficiency | `pi install npm:pi-rtk-optimizer` |
| [pi-screenshots-picker](https://github.com/Graffioh/pi-screenshots-picker) (Graffioh) | Quick screenshot selection and attachment for prompts | `pi install npm:pi-screenshots-picker` |
| [pi-token-burden](https://github.com/Whamp/pi-token-burden) (Whamp) | Token usage breakdown and context burden analysis | `pi install npm:pi-token-burden` |
| [pi-tool-display](https://github.com/MasuRii/pi-tool-display) (MasuRii) | Compact tool call rendering with diff visualization | `pi install npm:pi-tool-display` |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) (nicobailon) | Gemini-powered web search with AI-synthesized overviews and citations | `pi install npm:pi-web-access` |
| [whimsical](https://github.com/mitsuhiko/agent-stuff/blob/main/pi-extensions/whimsical.ts) (mitsuhiko) | Whimsical messages while the agent is working | Copy to `~/.pi/agent/extensions/` |

---

## Themes

| | Theme |
|---|---|
| ● | `violet-dawn.json` |
| ● | `violet-dusk.json` |

## Skills

The Pi package does not export skills.  See [skills/README.markdown](skills/README.markdown) for full descriptions.

| | Skill | Notes |
|---|---|---|
| ○ | `agent-browser/` | |
| ○ | `deep-x-research/` | Requires [surf-cli](https://github.com/nicobailon/surf-cli) |
| ○ | `gdcli/` | |
| ● | `repoprompt-tool-guidance-refresh/` | Maintainer workflow |
| ● | `rp-deep-build/` | Requires [pi-codex-goal](https://github.com/fitchmultz/pi-codex-goal) |
| ○ | `surf/` | Requires [surf-cli](https://github.com/nicobailon/surf-cli) |
| ◐ | `text-search/` | |
| ◐ | `xcodebuildmcp/` | |

## Prompts

Prompts are not exported as part of the Pi package.

**AGENTS.md prefaces for reliable RepoPrompt tool usage** — see [AGENTS-prefaces/README.md](AGENTS-prefaces/README.md)

| | Preface |
|---|---|
| ● | `AGENTS-prefaces/rp-cli-preface.md` |
| ● | `AGENTS-prefaces/rp-mcp-preface.md` |
| ● | `AGENTS-prefaces/rp-mcp-preface-exPi.md` |
