# Changelog

## [0.9.6] - 2026-09-03

### Added

- Pi Codex Conversion 3.0.24 or newer can invoke the existing `rp` tool inside Code and Notebook Mode with the same Pi context, cancellation, progress updates, and rendering

## [0.9.5] - 2026-08-18

### Changed

- RepoPrompt `apply_edits` diffs show one edited, created, deleted, or moved file heading instead of separate `---` and `+++` path lines

## [0.9.4] - 2026-08-17

### Fixed

- Window and tab routing distinguishes identical context IDs belonging to different RepoPrompt windows
- Verified routes compare both the bound window and context, preventing a tab in another window from being mistaken for the active route

## [0.9.3] - 2026-08-14

### Fixed

- Restored extension registration when `extensions/repoprompt-mcp` is loaded as a local Pi package

## [0.9.2] - 2026-08-14

### Fixed

- Explicit `/rp bind` and `rp({ bind })` operations preserve the previous tab's managed selection instead of issuing a stale selection request after binding to a new tab
- The target tab's saved selection remains authoritative when an explicit bind overlaps an in-flight auto-selection update

### Changed

- Consolidated package metadata and package smoke validation around the canonical extension source

## [0.9.1] - 2026-08-05

### Changed

- Published a package-version-only update with no user-facing behavior changes

## [0.9.0] - 2026-08-05

### Added

- **Steerable background waits** — Typing a message while a Context Builder or Oracle job is in flight ends that wait early, letting you redirect the agent without losing the job; the agent picks it back up afterwards. A wait is interrupted only when your message arrives while nothing else is queued
- **Steerable RepoPrompt CE Agent Mode waits** — Steering also ends waits on CE sub-agent sessions, individually or across a whole batch, without cancelling the sub-agent itself
- **Routing contract verification** — On connect, the extension checks that the selected target provides the MCP operations needed for window and tab routing. Tools that act on a workspace or tab stay blocked when a required operation is missing or incompatible, and `/rp status` names what is unavailable
- **Route quarantine** — When a routing mutation may have succeeded but its result cannot be confirmed, the route is quarantined until `/rp reconnect` or an explicit `/rp bind` establishes it again

### Changed

- RepoPrompt CE Agent Mode blocking waits now follow a cache-aware schedule for the Pi model handling the current turn instead of repeatedly waking Pi on CE's two-minute default
- `/rp status` now reports a precise route state: `verified tab`, `stale/missing`, `restored but unverified`, `quarantined`, `unverified (observation failed)`, `unsupported contract`, or `unbound`. Only a verified tab can receive tools that act on a workspace or tab
- Saved window and tab bindings are validated against the live connection before use
- Pending and ordinary `running` heartbeat waits render no transcript rows, so repeated waits no longer crowd the session; they remain in the session record and HTML exports
- `/rp oracle` mode validation follows the selected target — CE accepts `chat`, `plan`, and `review`; Classic also accepts `edit`
- `get_code_structure` call summaries reflect the argument shape of the selected target
- Requires Pi 0.83.0 or newer, and RepoPrompt CE 1.2.0 or newer or RepoPrompt Classic 2.1.32

## [0.8.3] - 2026-08-02

### Added

- **Asynchronous Context Builder** — Context Builder runs as a background job instead of blocking the turn
- **Asynchronous Oracle sends** — Oracle sends run as background jobs
- **Cache-aware background waits** — New `backgroundWaitHeartbeatEnabled` and `backgroundWaitCacheTtlMsByModel` settings tune wait behavior against per-model prompt cache lifetimes

### Changed

- Asynchronous wait rows are decluttered so repeated polling does not dominate the transcript

### Fixed

- Heartbeat handling calibrated against observed GPT-5.6 Codex behavior

## [0.8.1] - 2026-07-13

### Fixed

- The MCP tool catalog refreshes dynamically in response to tool-list change notifications, so newly available RepoPrompt tools appear without a reconnect. Status identifies the tool list as fresh, stale, or unavailable

## [0.8.0] - 2026-06-29

### Added

- **RepoPrompt CE and Classic targets** — Both applications are supported and selectable with `/rp app`, letting you curate context in one and execute in the other within a single session. Configuration moves to an `apps` map with per-target `appPath` and `autoLaunchApp`, selected by `activeApp`

### Changed

- Widened Pi peer dependency ranges

## [0.7.5] - 2026-05-07

### Changed

- Migrated to the `@earendil-works` scope for Pi runtime packages

## [0.7.4] - 2026-05-06

### Fixed

- Stale context host errors are ignored during reconnect instead of surfacing as failures

## [0.7.3] - 2026-04-24

### Changed

- Migrated to the Pi 0.69 session and typebox APIs

## [0.7.2] - 2026-04-16

### Added

- **Configurable MCP tool timeout** — New `toolCallTimeoutMs` setting, defaulting to 90 minutes

## [0.7.1] - 2026-04-05

### Changed

- Version alignment across the Pi extension packages

## [0.7.0] - 2026-04-05

### Changed

- Migrated lifecycle handling to Pi 0.65 and raised the peer dependency accordingly

## [0.6.2] - 2026-04-03

### Fixed

- Explicit context binding is preferred in the RepoPrompt 2.1.x workflow

## [0.6.1] - 2026-04-03

### Fixed

- `bind_context` and the agent tools are exempt from the tab guard, so they work before a tab is bound

### Changed

- Clarified Oracle-related wording throughout the documentation

## [0.6.0] - 2026-04-03

### Changed

- **RepoPrompt 2.1.x context routing** — Tab discovery and binding move from `manage_workspaces` to `bind_context`, with `context_id` as the canonical routed tab identifier. `/rp oracle` uses `oracle_send`
- Safe tab reuse now requires both an empty selection for the candidate context and no Oracle session associated with that context, restoring non-clobbering reuse
- Branch-safe tab and context recovery works under the new routing surface

## [0.5.5] - 2026-04-01

### Removed

- Model-facing raw output mode from the `rp` tool

## [0.5.4] - 2026-03-31

### Changed

- Pinned the Pi peer dependency to 0.64.0

## [0.5.3] - 2026-03-26

### Added

- **Auto-launch** — The RepoPrompt app is launched automatically on connection failure, controlled by `autoLaunchApp`

## [0.5.2] - 2026-03-26

### Fixed

- The extension auto-pauses when the RepoPrompt app is unavailable rather than failing tool calls

## [0.5.1] - 2026-03-18

### Fixed

- Screenshot rendering in the npm package README

## [0.5.0] - 2026-03-18

### Fixed

- Screenshot rendering in the documentation

## [0.4.9] - 2026-03-18

### Added

- **Revamped tool output displays** — New diff renderer with side-by-side and unified modes, language detection, and presentation summaries, cutting the tokens spent on tool results. New `diffViewMode` and `diffSplitMinWidth` settings
- **Workspace recovery** — Session context is recovered into any workspace whose roots cover the requirement, not only the originating one

### Fixed

- Only safe tabs are bound, and cumulative read context is preserved across binding changes

## [0.4.0] - 2026-03-17

### Added

- **Automated and manual tab management** — Tabs are discovered, created, and reused automatically, with branch-safe replay across `/tree`, `/fork`, and reconnect, plus manual overrides

### Changed

- `collapsedMaxLines` now defaults to 3 and `readcacheReadFile` to false

### Fixed

- Automatic window binding is symlink-safe

## [0.3.0] - 2026-03-12

### Added

- `**collapsedMaxLines**` — Controls how many lines of a tool display remain visible when collapsed

## [0.2.9] - 2026-02-22

### Changed

- `readcacheReadFile` guidance promoted so the read cache is enabled by default

## [0.2.8] - 2026-02-22

### Added

- **Oracle auto-selection from `read_file`** — Files the agent reads are added to the RepoPrompt selection automatically, with branch-safe replay across `/tree`, `/fork`, and reconnect. New `autoSelectReadSlices` and `oracleDefaultMode` settings

## [0.2.7] - 2026-02-20

### Added

- **Delta diff rendering** — Diffs render through `delta` when available, falling back to the built-in renderer otherwise

### Changed

- `readcacheReadFile` now defaults to true

## [0.2.6] - 2026-02-18

### Added

- **Read cache** — `read_file` results are cached in a content-addressed store and replayed as diffs on re-read, so repeated reads of the same file cost a fraction of the tokens. Controlled by `readcacheReadFile`

## [0.2.1] - 2026-02-15

### Added

- **Branch-safe state** — Bindings survive `/tree` and `/fork` by replaying against the active branch

## [0.2.0] - 2026-02-03

### Fixed

- First-run experience for fresh installs

## [0.1.1] - 2026-02-02

### Changed

- Updated for Pi 0.51.0

## [0.1.0] - 2026-01-28

### Added

- **Initial release** — A RepoPrompt MCP proxy for Pi that exposes RepoPrompt's tools through a single `rp` tool
- Syntax and diff highlighting for tool output
- Automatic window binding, matching the Pi working directory against open RepoPrompt workspace roots
- Guardrails for destructive operations via `confirmDeletes` and `confirmEdits`
- Configuration through `repoprompt-mcp.json`, including `autoBindOnStart`, `persistBinding`, and `collapsedMaxLines`
