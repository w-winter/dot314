# Roam

Post-hoc handoff of a live Pi session into tmux for remote continuation.

If you wish you had started Pi inside tmux, run `/roam` mid-session and continue from another device over SSH.

## Usage

```text
/roam [window-name]
```

Defaults window name to the current cwd basename.

## Setup

Optional per-user config:

- copy `config.json.example` → `config.json`
- location: `~/.pi/agent/extensions/roam/config.json`

Example:

```json
{
  "tailscale": {
    "account": "you@example.com",
    "binary": "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  }
}
```

## What it does

1. Pre-flight checks (interactive TTY, not already in tmux, `tmux` installed, session exists)
2. On macOS, optionally runs `tailscale switch <account>` then `tailscale up` (non-fatal)
3. Forks the current session, clears the fork header's `parentSession` pointer
4. Creates/joins dedicated tmux server `-L pi`, one window per roamed session
5. Attaches your terminal to tmux and leaves parent process as inert exit-code forwarder
6. Best-effort trashes original session file (for standard `~/.pi/` session paths)

## Notes

- Cross-platform tmux behavior; Tailscale integration is currently macOS-specific by default binary path
- Uses dedicated tmux socket (`-L pi`) plus per-socket config for isolation
- Config template is intentionally user-specific; do not commit your local `config.json`

For npm installation and package-specific docs, see [`packages/pi-roam/README.md`](../../packages/pi-roam/README.md)
