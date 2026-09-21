# pi-screenshots-picker

A [pi coding agent](https://github.com/badlogic/pi-mono/) extension for quickly selecting and attaching screenshots to your prompts. Works on **macOS** and **Linux**. Browse recent screenshots with thumbnail previews, stage multiple images, then type your message - screenshots attach automatically when you send.



https://github.com/user-attachments/assets/365f6fa8-0922-4172-8611-141300aed7f6



## Why

Attaching screenshots during development is tedious. You're constantly:
- Dragging files from Desktop/Finder
- Losing track of which screenshot is which
- Breaking your flow to find the right image

pi-screenshots-picker gives you a visual screenshot browser right in your terminal:

```
/ss
```

## Install

```bash
pi install git:github.com/w-winter/dot314
```

Enable `screenshots-picker` with `pi config`.

## Changes from upstream

The upstream source is [Graffioh/pi-screenshots-picker](https://github.com/Graffioh/pi-screenshots-picker). This version adds sent-screenshot previews that follow Pi's image visibility and resizing settings, metadata previews for Orca terminals, `Ctrl+\`` and `Ctrl+1` shortcuts, picker-clear notifications, system image-viewer support, current `@earendil-works` Pi imports, and `glob` 13.0.6.

## Quick Start

1. Press `Ctrl+\`` or type `/ss` to open the picker
2. Navigate with `↑↓`, press `s` or `space` to stage screenshots (✓ appears)
3. Press `Enter` to close the picker
4. Type your message in the prompt
5. Press `Enter` to send - staged images attach automatically and appear as inline previews in chat

Staged images also attach to steering and follow-up messages managed by `pi-queue-steer`.

## Orca

Run Pi in an [Orca](https://github.com/stablyai/orca) terminal pane and use `/ss` or `Ctrl+\`` normally. The picker uses a lightweight metadata preview in Orca's xterm.js terminal; press `o` to inspect the original in your system image viewer. Staged screenshots are attached directly to Pi's next prompt.

Use the terminal pane for this workflow because Pi extension commands and custom TUI components run inside the hosted terminal.

## Commands

### `/ss`

Opens the interactive screenshot picker UI. Browse recent screenshots with native thumbnails or metadata previews, depending on the terminal.

**Keys:**
- **↑↓** - Navigate through screenshots
- **Ctrl+T** - Cycle through source tabs (when multiple sources configured)
- **z** - Toggle zoom inspector mode
- **+ / -** - Zoom in/out (inspector mode)
- **←↑→↓** - Pan image in inspector mode (Kitty/Ghostty/WezTerm); falls back to nav otherwise
- **[ / ]** - Previous/next screenshot in inspector mode
- **0** - Reset inspector zoom + pan (only after this you can select other screenshots)
- **s / space** - Stage/unstage current screenshot (✓ indicator appears)
- **x** - Clear all staged screenshots
- **o** - Open in the system image viewer
- **d** - Delete screenshot from disk
- **Enter** - Close picker
- **Esc** - Cancel

### `/ss-clear`

Clear all staged screenshots without sending.

### `Ctrl+\``

Keyboard shortcut to open the picker (same as `/ss`).

### `Ctrl+1`

Keyboard shortcut to clear all staged screenshots (same as `/ss-clear`).

## Features

- **Multiple sources with tabs** - Configure multiple directories/patterns, switch with Ctrl+T
- **Glob pattern support** - Use patterns like `**/*.png` to match files flexibly
- **Thumbnail previews** - Native terminal images in Kitty/iTerm2/Ghostty/WezTerm and metadata previews in Orca
- **Zoom inspector mode** - Press `z`, then pan with arrows and zoom with +/-
- **Multi-select** - Stage multiple screenshots, they all attach when you send
- **Relative timestamps** - "2 minutes ago", "yesterday", etc.
- **File sizes** - Know what you're attaching
- **Delete screenshots** - Press `d` to remove unwanted screenshots from disk
- **Staged indicator** - Widget shows `📷 N screenshots staged` below the editor
- **Sent previews in chat** - After sending, screenshots show up as inline previews in the TUI
- **Matches Pi image settings** - Sent previews respect Pi's image display toggle and auto-resize behavior
- **Auto-detection** - Finds your screenshot folder automatically when no config

## Configuration

By default, the extension auto-detects your screenshot location based on your platform.

### Multiple Sources with Tabs

Configure multiple screenshot sources in `~/.pi/agent/settings.json`. Each source becomes a tab in the picker UI - use **Ctrl+T** to cycle through them:

```json
{
  "pi-screenshots": {
    "sources": [
      "~/Desktop/ss",
      "~/Pictures/Screenshots",
      "/path/to/comfyui/output/**/thumbnail_*.png"
    ]
  }
}
```

### Source Types

**Plain directories** - Scans for screenshot-named PNG files:
```json
"~/Desktop/ss"
```

**Glob patterns** - Matches any image file (PNG, JPG, WebP) matching the pattern:
```json
"/path/to/images/**/*.png"
"/mnt/Store/ComfyUI/Output/**/thumbnail_*.png"
```

Glob patterns support:
- `*` - Match any characters in a filename
- `**` - Match any directories recursively
- `?` - Match a single character
- `[abc]` - Match any character in brackets

### Default Locations (when no config)

**macOS:**
1. System preferences (`defaults read com.apple.screencapture location`)
2. `~/Desktop`

**Linux:**
1. `~/Pictures/Screenshots`
2. `~/Pictures`
3. `~/Screenshots`
4. `~/Desktop`

### Environment Variable

You can also use the `PI_SCREENSHOTS_DIR` environment variable as a fallback:

```bash
export PI_SCREENSHOTS_DIR="/path/to/screenshots"
```

### Priority

1. Config in `~/.pi/agent/settings.json` (`pi-screenshots.sources`)
2. Environment variable (`PI_SCREENSHOTS_DIR`)
3. Platform default (see above)

## Remote Development

When developing on a remote machine via SSH, you need a way to get screenshots from your local machine to the remote. Use one of these external tools:

### Option 1: SSHFS (Simplest)

Mount a remote folder locally. Screenshots you take locally appear on the remote instantly.

**On your local machine:**

```bash
# Install sshfs
# macOS: brew install macfuse sshfs
# Linux: sudo apt install sshfs

# Create mount point
mkdir -p ~/remote-screenshots

# Mount (replace with your remote)
sshfs user@remote:~/Screenshots ~/remote-screenshots

# Configure macOS to save screenshots there
defaults write com.apple.screencapture location ~/remote-screenshots
killall SystemUIServer
```

**On the remote**, configure pi-screenshots to read from `~/Screenshots`:

```json
{
  "pi-screenshots": {
    "sources": ["~/Screenshots"]
  }
}
```

### Option 2: Syncthing (Most Robust)

[Syncthing](https://syncthing.net/) provides continuous, bidirectional file sync. Better for unreliable connections.

1. Install Syncthing on both machines
2. Share your local screenshot folder with the remote
3. Configure pi-screenshots to read from the synced folder

### Thumbnail Previews over SSH

To enable thumbnail previews over SSH, add your terminal to the remote's shell profile:

```bash
# Add to remote ~/.bashrc or ~/.zshrc
export TERM_PROGRAM=ghostty  # or: kitty, WezTerm, iTerm.app
```

Restart pi after (can't use `!` inside pi).

## Supported Screenshot Formats

The extension recognizes screenshots from various tools:

**macOS:**
- English: `Screenshot ...`
- French: `Capture ...`
- German: `Bildschirmfoto ...`
- Spanish: `Captura ...`
- Italian: `Istantanea ...`
- Dutch: `Scherm...`

**Linux:**
- GNOME Screenshot: `2024-01-30_12-30-45.png`
- Flameshot: `flameshot...`
- KDE Spectacle: `spectacle...`
- Scrot: `scrot...`
- Maim: `maim...`
- Grim (Wayland): `grim...`
- Generic: `screenshot...`

Only PNG files matching these patterns are shown.

## Requirements

- macOS or Linux
- Terminal with image support for thumbnails (Kitty, iTerm2, Ghostty, WezTerm)
  - Falls back gracefully on unsupported terminals

## License

MIT
