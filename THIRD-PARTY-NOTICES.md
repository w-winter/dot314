# Third-Party Notices

This repository includes code derived from, inspired by, or copied from the
following open-source projects. Each extension directory (or companion
`.LICENSE` file for single-file extensions) contains the applicable license
text. This file provides a consolidated overview.

---

## MIT Licensed

### earendil-works/pi
- **URL:** https://github.com/earendil-works/pi
- **License:** MIT
- **Copyright:** © 2025 Mario Zechner
- **Used in:**
  - `extensions/diff.ts` (○ unmodified)
  - `extensions/files-touched.ts` (◐ modified)
  - `extensions/plan-mode.ts` (◐ modified)
  - `extensions/tools/` (◐ modified)
  - `extensions/sandbox/` (◐ modified)
  - `extensions/interactive-shell.ts` (○ unmodified)
  - `extensions/preset.ts` (○ unmodified)
  - `extensions/titlebar-spinner.ts` (○ unmodified)

### HazAT/pi-config
- **URL:** https://github.com/HazAT/pi-config
- **License:** MIT
- **Copyright:** © 2026 Daniel Griesser
- **Used in:**
  - `extensions/cmux/index.ts` (◐ modified — added workspace auto-renaming synced to Pi session name)

### Gurpartap/pi-readcache
- **URL:** https://github.com/Gurpartap/pi-readcache
- **License:** MIT
- **Copyright:** © 2026 Gurpartap Singh
- **Used in:**
  - `extensions/repoprompt-cli/readcache/` (◐ derived implementation)
  - `extensions/repoprompt-mcp/src/readcache/` (◐ derived implementation)

### crstdr/diligent-pi
- **URL:** https://github.com/crstdr/diligent-pi
- **License:** MIT
- **Copyright:** © 2026 Cristian Darie
- **Used in:**
  - `extensions/tool-horizon/` (◐ modified from `extensions/diligent-context/`; adds a session-tree picker, Tool Horizon namespace, context/cache reconstruction, compaction restore-all lifecycle, and expanded file-provenance checkpoints)

### tmustier/pi-extensions
- **URL:** https://github.com/tmustier/pi-extensions
- **License:** MIT
- **Copyright:** © 2026 Thomas Mustier
- **Used in:**
  - `extensions/editor-enhancements/` (◐ raw-paste component)
  - `extensions/code-actions/` (○ unmodified, with sandbox additions)

### can1357/oh-my-pi
- **URL:** https://github.com/can1357/oh-my-pi
- **License:** MIT
- **Copyright:** © 2025 Mario Zechner; © 2025-2026 Can Bölük; © 2026 Stencil Labs, Inc.
- **Used in:**
  - `extensions/image-url-broker/` (◐ independent Pi extension informed by the blob broker's image-handling design)

### vanillagreencom/kendex
- **URL:** https://github.com/vanillagreencom/kendex/tree/main/pi-extensions/pi-claude-bridge
- **License:** MIT
- **Copyright:** © 2026 Eli Dickinson
- **Used in:**
  - `extensions/pi-claude-bridge/` (◐ modified — complete Pi system-prompt forwarding, bridge-owned prompt replacement, strict MCP configuration on every query, and no Claude Code filesystem settings by default outside connector sessions)

### Graffioh/pi-screenshots-picker
- **URL:** https://github.com/Graffioh/pi-screenshots-picker
- **License:** MIT
- **Copyright:** © 2026 Umberto B.
- **Used in:**
  - `extensions/screenshots-picker/` (◐ modified — sent-image previews, custom shortcuts, clear notifications, current Pi imports, updated glob dependency, and staged-image handoff to `pi-queue-steer`)

### saadjs/pi
- **URL:** https://github.com/saadjs/pi
- **License:** MIT (declared in `extensions/stash/package.json`)
- **Copyright:** © 2026 Saad Bash
- **Used in:**
  - `extensions/stash/` (◐ reimplemented as a session-local manual stash, restore, and swap shortcut)

### tmustier/pi-queue-steer
- **URL:** https://github.com/tmustier/pi-queue-steer
- **License:** MIT
- **Copyright:** © 2026 Thomas Mustier
- **Used in:**
  - `extensions/pi-queue-steer/` (◐ modified — slash-command follow-ups, bidirectional lane conversion, content-free accepted-steering events, and staged-image collection from `screenshots-picker`)

### davidgasquez/dotfiles
- **URL:** https://github.com/davidgasquez/dotfiles
- **License:** MIT
- **Copyright:** © 2016 David Gasquez
- **Used in:**
  - `extensions/branch-out/` (◐ modified; renamed from `branch-term`; added cmux support, config-driven split/tab routing, iTerm2/Terminal/Ghostty routing, rotating layout policies, split-direction fallback lists, and mid-turn branching)

### pasky/pi-amplike
- **URL:** https://github.com/pasky/pi-amplike
- **License:** MIT
- **Copyright:** © 2026 pasky
- **Used in:**
  - `extensions/btw/` (◐ modified — scoped fuzzy model selection, request-auth forwarding, projected session context, double-dash options, AST-based compound Bash permission checks, and child responses saved in session-tree entries)
  - `extensions/handover/` (◐ borrows heavily from handoff extension)

### damianpdr/pi-thread-switcher
- **URL:** https://github.com/damianpdr/pi-thread-switcher
- **License:** MIT (declared in README)
- **Copyright:** © damianpdr
- **Used in:**
  - `extensions/session-switch/` (◐ modified — mirrors native /resume layout with an extension-driven startup relaunch workaround)

### MasuRii/pi-tool-display
- **URL:** https://github.com/MasuRii/pi-tool-display
- **License:** MIT (declared in package.json)
- **Copyright:** © MasuRii
- **Used in:**
  - `extensions/repoprompt-mcp/` (◐ reuses its adaptive diff rendering logic)

---

## Apache 2.0 Licensed

### mitsuhiko/agent-stuff
- **URL:** https://github.com/mitsuhiko/agent-stuff
- **License:** Apache License 2.0
- **Copyright:** Armin Ronacher
- **Used in:**
  - `extensions/todos.ts` (○ unmodified copy)
  - `extensions/handover/` (◐ borrows from handoff prompt concept)
  - `extensions/extension-stats.ts` (◐ borrows from `session-breakdown.ts`)
- **Changes:** `todos.ts` is an unmodified copy. `handover/` is a new
  implementation that borrows conceptual approach from the handoff prompt.

---

## Unlicensed Upstreams

The following upstream repositories do not specify a license. Under copyright
law, absence of a license means all rights are reserved by the author.
Attribution is provided here; the authors have been or should be contacted to
request addition of an open-source license.

### laulauland/dotfiles
- **URL:** https://github.com/laulauland/dotfiles
- **No license specified**
- **Used in:**
  - `extensions/editor-enhancements/` (◐ file-picker and shell-completions components)

### damianpdr/pi-handoff
- **URL:** https://github.com/damianpdr/pi-handoff
- **No license specified**
- **Used in:**
  - `extensions/handover/` (◐ borrows from handoff approach)

---

Legend: ● = original, ◐ = modified fork, ○ = unmodified copy
