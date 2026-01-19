# Changelog

All notable changes to pi-skill-palette will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Theming system** — Load custom colors from `theme.json` with fallback to defaults
- **Rainbow progress dots** — Spaced out dots with rainbow gradient (matching powerline-footer)
- **Skill content preview** — Message renderer shows actual skill content in collapsible block
- **Expandable content** — Click to expand full skill content in chat

### Fixed
- **Import package** — Changed from `@anthropic-ai/claude-code` to `@mariozechner/pi-coding-agent`
- **Countdown timer** — Unqueue dialog timer now actually updates visually
- **Array content handling** — Message renderer handles both string and TextContent[] formats
- **Missing skill directories** — Now scans all directories that pi scans:
  - `~/.codex/skills` (recursive)
  - `~/.claude/skills` (claude format - one level)
  - `${cwd}/.claude/skills` (claude format - one level)
  - `~/.pi/agent/skills` (recursive)
  - `~/.pi/skills` (recursive)
  - `${cwd}/.pi/skills` (recursive)
- **Claude format support** — Claude skill directories (one level deep) now handled differently from recursive directories

### Changed
- Skill injection now sets `display: true` to show content in chat

### Removed
- Unused `progress` theme property (progress dots use rainbow colors directly)

## [1.0.0] - 2025-01-09

### Added

- Initial release of Skill Palette extension
- `/skill` command to open the skill palette overlay
- Fuzzy search filtering by skill name and description
- Keyboard navigation with arrow keys and wrap-around
- Visual queue indicators:
  - Footer status showing queued skill name
  - Widget above editor with "will be applied to next message" hint
  - Green dot indicator next to queued skill in palette
- Toggle behavior: selecting a queued skill triggers unqueue flow
- Confirmation dialog for unqueuing with:
  - 30-second auto-cancel timeout
  - Color-coded Remove (red) / Keep (green) buttons
  - Quick `Y`/`N` keyboard shortcuts
  - Progress dots countdown timer
- Skill content injection via `before_agent_start` event
- Support for multiple skill directories:
  - `~/.pi/agent/skills/`
  - `~/.pi/skills/`
  - `.pi/skills/` (project-specific)
- Symlink support for skill directories
- Skill deduplication by name (first occurrence wins)
- Elegant TUI design with:
  - Title integrated into border
  - Section dividers
  - Search icon with placeholder text
  - Dot-style selection indicators
  - Progress dots for scroll position
  - Italic keyboard hints
