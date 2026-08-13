# Changelog

## [0.3.4] - 2026-08-13

### Fixed
- **Fullscreen preview layout** — `/anycopy` opens over the session view so widgets above the editor do not clip the preview; line and page scrolling reach every preview line, scroll indicators remain accurate, terminal resizing updates the tree and preview layout, and closing restores editor focus. Contributed by [@AdamsGH](https://github.com/AdamsGH)

### Changed
- Requires Pi 0.84.0 or newer

## [0.3.3] - 2026-08-01

### Fixed
- Copy ordering handles deeply nested session trees without overflowing the call stack

### Changed
- Widened Pi compatibility to versions 0.74.0 and newer

## [0.3.1] - 2026-05-15

### Added
- **Node creation timestamps** — `Shift+Ctrl+T` toggles compact creation times beside visible tree nodes, configurable through `keys.toggleEntryTimestamps`

## [0.3.0] - 2026-05-11

### Fixed
- Invalid JSON configuration now reports its parse error instead of silently loading defaults

### Changed
- Updated the anycopy demo

## [0.2.7] - 2026-05-07

### Changed
- Migrated Pi runtime dependencies to the `@earendil-works` package scope

## [0.2.6] - 2026-04-13

### Fixed
- Repeated `Enter` input cannot start duplicate tree navigation
- Selecting the current session leaf reports that the session is already at that point

## [0.2.5] - 2026-04-07

### Changed
- Requires Pi 0.65.0 or newer

## [0.2.4] - 2026-04-07

### Changed
- Label timestamps use Pi's native tree display
- Preview paging defaults to `Shift+PageUp` and `Shift+PageDown`

## [0.2.3] - 2026-04-02

### Fixed
- The npm package includes the fold-state module required for persistent folded branches

## [0.2.2] - 2026-04-02

### Added
- **Persistent folded branches** — Folded state is restored after reopening `/anycopy`, switching branches, or revisiting a session; controlled by `persistFoldState`

### Changed
- Node selection defaults to `Shift+A`, leaving Space available for search input

## [0.2.1] - 2026-03-29

### Added
- **Label timestamps** — `Shift+T` toggles the latest label-change time beside labeled nodes, configurable through `keys.toggleLabelTimestamps`

## [0.2.0] - 2026-03-23

### Added
- **Native tree navigation** — `Enter` navigates to the focused node with Pi's summary choices, cancellation behavior, filters, folding, and labeling

### Fixed
- Configured anycopy shortcuts do not intercept input while editing a node label

### Removed
- The global anycopy shortcut; open the browser with `/anycopy`

## [0.1.4] - 2026-03-14

### Added
- **Configurable global shortcut** — Open and close `/anycopy` without clearing the current editor draft; configured through `shortcut`

## [0.1.3] - 2026-03-05

### Added
- **Initial tree filter** — `treeFilterMode` selects the filter used when `/anycopy` opens: `default`, `no-tools`, `user-only`, `labeled-only`, or `all`

## [0.1.2] - 2026-03-05

### Changed
- Clarified that preview truncation does not affect clipboard output

## [0.1.1] - 2026-03-05

### Fixed
- Clipboard copies include complete node content even when the on-screen preview is truncated

## [0.1.0] - 2026-03-03

### Added
- **Initial release** — Browse the full session tree with syntax-highlighted previews and copy one or more nodes to the clipboard
- Chronological ordering for multi-node copies
- Configurable selection, copy, clear, scrolling, and paging keys
- Native node labeling
