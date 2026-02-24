# Third-Party Notices

This repository includes code derived from, inspired by, or copied from the
following open-source projects. Each extension directory (or companion
`.LICENSE` file for single-file extensions) contains the applicable license
text. This file provides a consolidated overview.

---

## MIT Licensed

### badlogic/pi-mono
- **URL:** https://github.com/badlogic/pi-mono
- **License:** MIT
- **Copyright:** © 2025 Mario Zechner
- **Used in:**
  - `extensions/plan-mode.ts` (◐ modified)
  - `extensions/tools/` (◐ modified)
  - `extensions/sandbox/` (◐ modified)
  - `extensions/inline-bash.ts` (○ unmodified)
  - `extensions/interactive-shell.ts` (○ unmodified)
  - `extensions/preset.ts` (○ unmodified)
  - `extensions/questionnaire.ts` (○ unmodified)
  - `extensions/review.ts` (○ unmodified)
  - `extensions/send-user-message.ts` (○ unmodified)
  - `extensions/status-line.ts` (○ unmodified)
  - `extensions/titlebar-spinner.ts` (○ unmodified)

### Gurpartap/pi-readcache
- **URL:** https://github.com/Gurpartap/pi-readcache
- **License:** MIT
- **Copyright:** © 2026 Gurpartap Singh
- **Used in:**
  - `extensions/repoprompt-cli/readcache/` (◐ derived implementation)
  - `extensions/repoprompt-mcp/src/readcache/` (◐ derived implementation)

### tmustier/pi-extensions
- **URL:** https://github.com/tmustier/pi-extensions
- **License:** MIT
- **Copyright:** © 2026 Thomas Mustier
- **Used in:**
  - `extensions/editor-enhancements/` (◐ raw-paste component)
  - `extensions/code-actions/` (○ unmodified, with sandbox additions)

### davidgasquez/dotfiles
- **URL:** https://github.com/davidgasquez/dotfiles
- **License:** MIT
- **Copyright:** © 2016 David Gasquez
- **Used in:**
  - `extensions/branch-term.ts` (◐ modified — added iTerm2/Terminal.app support)

### pasky/pi-amplike
- **URL:** https://github.com/pasky/pi-amplike
- **License:** MIT
- **Copyright:** © 2026 pasky
- **Used in:**
  - `extensions/handover/` (◐ borrows heavily from handoff extension)

### hjanuschka/shitty-extensions
- **URL:** https://github.com/hjanuschka/shitty-extensions
- **License:** MIT (declared in package.json)
- **Copyright:** © hjanuschka
- **Used in:**
  - `extensions/oracle.ts` (◐ modified — thinking picker, CJK-safe wrapping)
  - `extensions/usage-bar.ts` (◐ modified — multi-Codex, color scale, alignment)
  - `extensions/speedreading.ts` (○ unmodified)
  - `extensions/ultrathink.ts` (◐ modified)

### damianpdr/pi-thread-switcher
- **URL:** https://github.com/damianpdr/pi-thread-switcher
- **License:** MIT (declared in README)
- **Copyright:** © damianpdr
- **Used in:**
  - `extensions/session-switch.ts` (◐ modified — mirrors native /resume layout)

### nicobailon/pi-prompt-template-model
- **URL:** https://github.com/nicobailon/pi-prompt-template-model
- **License:** MIT
- **Copyright:** © 2026 Nico Bailon
- **Used in:**
  - `extensions/pi-prompt-template-model/` (○ unmodified)

### nicobailon/pi-skill-palette
- **URL:** https://github.com/nicobailon/pi-skill-palette
- **License:** MIT (declared in package.json)
- **Copyright:** © Nico Bailon
- **Used in:**
  - `extensions/skill-palette/` (○ unmodified)

### nicobailon/pi-subagents
- **URL:** https://github.com/nicobailon/pi-subagents
- **License:** MIT (declared in package.json)
- **Copyright:** © Nico Bailon
- **Used in:**
  - `extensions/subagent/` (○ unmodified)

### nicobailon/pi-rewind-hook
- **URL:** https://github.com/nicobailon/pi-rewind-hook
- **License:** MIT (declared in package.json)
- **Copyright:** © Nico Bailon
- **Used in:**
  - `extensions/rewind/` (◐ modified — menu reorder)

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
  - `extensions/agentic-compaction/` (◐ derived from file-based-compaction)

### damianpdr/pi-handoff
- **URL:** https://github.com/damianpdr/pi-handoff
- **No license specified**
- **Used in:**
  - `extensions/handover/` (◐ borrows from handoff approach)

---

---

# Skills

## MIT Licensed

### SawyerHood/dev-browser
- **URL:** https://github.com/SawyerHood/dev-browser
- **License:** MIT
- **Copyright:** © 2025 Sawyer Hood
- **Used in:**
  - `skills/dev-browser/` (◐ modified — added CLI wrapper and extended SKILL.md)

### nicobailon/surf-cli
- **URL:** https://github.com/nicobailon/surf-cli
- **License:** MIT
- **Copyright:** © 2025 Nico Bailon
- **Used in:**
  - `skills/surf/` (○ unmodified SKILL.md)

### badlogic/pi-skills
- **URL:** https://github.com/badlogic/pi-skills
- **License:** MIT
- **Copyright:** © 2024 Mario Zechner
- **Used in:**
  - `skills/gdcli/` (○ unmodified)

### cameroncooke/XcodeBuildMCP
- **URL:** https://github.com/cameroncooke/XcodeBuildMCP
- **License:** MIT
- **Copyright:** © 2025 Cameron Cooke
- **Used in:**
  - `skills/xcodebuildmcp/` (◐ modified — local CLI wrapper for SKILL.md)

### steipete/mcporter
- **URL:** https://github.com/steipete/mcporter
- **License:** MIT
- **Copyright:** © 2026 Peter Steinberger
- **Used in:**
  - `skills/xcodebuildmcp/` (CLI generated with mcporter)

## Apache 2.0 Licensed

### vercel-labs/agent-browser
- **URL:** https://github.com/vercel-labs/agent-browser
- **License:** Apache License 2.0
- **Copyright:** Vercel, Inc.
- **Used in:**
  - `skills/agent-browser/` (○ unmodified SKILL.md)

---

## Referenced but Not Derived

The following projects are referenced in documentation or complement this
repository's extensions/skills but no code is copied or derived from them:

- **nicobailon/pi-web-access** (MIT) — https://github.com/nicobailon/pi-web-access
- **aliou/pi-extensions** (no license) — https://github.com/aliou/pi-extensions

---

Legend: ● = original, ◐ = modified fork, ○ = unmodified copy
