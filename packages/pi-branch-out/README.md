# branch-out for Pi (`pi-branch-out`)

Fork the current Pi session into a split terminal pane or new tab with rotating layout policies, and with optional model and message queuing. Routing, split geometry, and focus behavior are config-driven. Inside Orca, the fork opens as a new pane in the current terminal tab and worktree.

## Install

```bash
pi install npm:pi-branch-out
```

From the dot314 git bundle (filtered install):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/branch-out/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

After installing, copy `extensions/branch-out/config.json.example` to `extensions/branch-out/config.json` and adjust to taste. Pi `>=0.87.1` is required for the session snapshot and native tree selector APIs.

## Commands

```text
/branch-tree [--model <query>] [message]
/branch [--tree] [--model <query>] [message]
```

`/branch-tree` is the shortcut for `/branch --tree`. In short terminals, the picker reduces the tree viewport while keeping the focused entry visible and a preview row available; when the terminal cannot show both safely, it displays a resize prompt instead of accepting a hidden fork point.

Use `/branch-tree` to select a historical entry, or `/branch` to fork from the current position. `/branch --tree` is equivalent to `/branch-tree`; both use the same handler and accept a model query and an optional draft message.

- **`--tree`** — open Pi's native session-tree selector and fork the child from the selected entry without navigating the parent. Selecting a user message restores its prompt in the child editor; selecting another entry forks through that entry. `Esc` cancels without creating a child.
- **`--model <query>`** — target model for the child session.  Accepts a fully qualified `provider/model-id` or a fuzzy query scoped to the current provider.  If the query does not resolve safely the child keeps the parent's model.
- **`message`** — prefilled text in the child session's editor with a 10-second auto-submit countdown. Typing anything or pressing `Esc` cancels the countdown; `Enter` sends immediately. When a text-only user message is selected, the supplied instructions are appended to the restored prompt. Restoring a historical prompt without new instructions leaves it in the editor without auto-submitting it.

Examples:

```text
/branch-tree
/branch-tree --model flash
/branch-tree Please focus on the failure mechanism
/branch --tree
```

The selector uses Pi's native session tree, including search, filtering, folding, labels, and sibling branches. The current leaf is initially selected. A live preview below the tree shows the focused entry before you choose where to fork. Markdown content and ordinary tool results use Pi's Markdown renderer; Bash commands and `read` results with a recognized file path receive syntax highlighting. Hidden thinking blocks are not shown. Attachment placeholders identify content that remains in the child. The footer explains whether the selected entry is included or restored as an editable prompt. Previews are capped at the reference picker's limits of 7,000 characters or 200 rendered lines, with an explicit notice; this never truncates the child session's history.

| Key | Action |
|-----|--------|
| `Tab` | Toggle between a larger tree and a larger preview; both remain visible |
| `Shift+Up` / `Shift+Down` | Scroll the preview by one line |
| `Shift+PageUp` / `Shift+PageDown` | Page through the preview |
| `Enter` | Fork from the focused entry |
| `Esc` | Clear an active search, or close the picker without forking |

Native navigation, search, filters, labels, spacing, and borders keep their configured bindings. Copy actions are omitted from this picker. Selection changes reset the preview scroll; resizing the terminal or toggling the layout preserves the selected node. Very large previews are capped at 7,000 characters or 200 rendered lines with an explicit notice; this never truncates the child session's history.

Selecting a node does not navigate or interrupt the parent session. Label edits are persisted through Pi's `setLabel` API.

Selecting a text-only user message forks before it and restores its prompt in the child editor for editing. Messages with attachments are retained intact through the selected message, so images are preserved without repeating the prompt. Selecting an assistant or other entry forks through that entry. The child opens using the existing terminal backend. The tree picker requires Pi's interactive terminal UI; ordinary `/branch` usage is unchanged.

## Config

Config lives in `extensions/branch-out/config.json` next to the extension.

```json
{
  "launchMode": "split",
  "splitDirection": "right",
  "preserveFocus": true
}
```

### `launchMode`

| Value | Behavior |
|-------|----------|
| `"split"` | Open in a new split pane inside the current window (default) |
| `"tab"` | Open in a new tab / surface |

### `splitDirection`

Accepts a single value or a **comma-separated fallback list**.  The first entry supported by the active backend is used; if none match, `right` is the final default.

```json
"splitDirection": "counterclockwise,right"
```

This is useful when `splitDirection` is a rotating policy (unsupported by iTerm2).  The fallback `right` kicks in automatically on that backend.

#### Static directions

| Value | Effect |
|-------|--------|
| `"right"` | Split to the right of the current pane |
| `"down"` | Split below the current pane |
| `"left"` | Split to the left of the current pane |
| `"up"` | Split above the current pane |

#### Rotating layout policies (`cmux` and `tmux` only)

`clockwise` and `counterclockwise` are stateful layout policies.  On the first `/branch` call the current pane is split in the policy's initial direction.  On each subsequent call the policy picks the next queued managed leaf and splits it in that leaf's assigned direction, building a balanced recursive tree rather than a linear stack.

| Value | Pattern |
|-------|--------|
| `"clockwise"` | First split right → children split up/down → grandchildren split right/left → … |
| `"counterclockwise"` | First split right → children split down/up → grandchildren split left/right → … |

State is persisted per backend and workspace key in `/tmp/pi-branch-out-layout-state.json`.  Stale entries are pruned against live pane/surface lists on each call. To reset the policy entirely:

```bash
rm /tmp/pi-branch-out-layout-state.json
```

### `preserveFocus`

| Value | Behavior |
|-------|----------|
| `true` | Ask the terminal to keep the source pane selected (default) |
| `false` | Allow the terminal's normal child-focus behavior |

This applies to both `/branch` and `/branch-tree` and is read on every launch. Focus behavior depends on the backend and desktop environment. A successful CLI switch or an active-pane marker does not establish that subsequent keyboard input will reach the child, particularly over a remote connection.

Use the terminal's native pane-switching shortcuts when automatic focus is unreliable. Orca's default bindings are `Cmd+]` / `Cmd+[` on macOS and `Ctrl+]` / `Ctrl+[` on Linux and Windows for the next / previous pane. These follow the desktop client's platform; custom Orca bindings take precedence. Wait for the child Pi editor to start before typing.

## Terminal backend routing

Routing is automatic and tried in this order:

1. `--branch-out-terminal` flag override (always wins)
2. Orca — detected via `ORCA_WORKTREE_ID` and either `ORCA_TERMINAL_HANDLE` or `ORCA_PANE_KEY`
3. cmux — detected via `CMUX_SOCKET_PATH`
4. tmux — detected via `TMUX`
5. iTerm2 — detected via `TERM_PROGRAM=iTerm.app`
6. Terminal.app — detected via `TERM_PROGRAM=Apple_Terminal`
7. Ghostty — detected via `GHOSTTY_RESOURCES_DIR` or `TERM_PROGRAM` containing `ghostty`
8. Warp — detected via `TERM_PROGRAM=WarpTerminal`

If no backend is detected, macOS tries iTerm2 and Terminal.app before falling back to an Alacritty window; other platforms fall back to Alacritty. These fallbacks require `launchMode: "tab"`.

The Orca backend opens the fork beside the terminal that ran `/branch` and uses Pi's current working directory. Direction values describe the desired placement: `right` creates a left/right split (Orca `vertical`), while `down` creates a top/bottom split (Orca `horizontal`). Orca requires `launchMode: "split"`.

The Warp backend opens the fork in a new tab in Warp's active window and uses Pi's current working directory. It works with Warp Stable on macOS and Linux when Pi runs on the same machine as Warp, not in an SSH session. It requires `launchMode: "tab"`; for splits inside Warp, run Pi in tmux with `launchMode: "split"`. Each launch writes a temporary [Tab Config](https://docs.warp.dev/terminal/windows/tab-configs/) named `tmp_pi_branch_*.toml`, which the new tab deletes as it starts. If a launch never opens a tab, delete the leftover file from `~/.warp/tab_configs/` on macOS or `${XDG_DATA_HOME:-$HOME/.local/share}/warp-terminal/tab_configs/` on Linux.

### Backend capability matrix

| Backend | `tab` | `split` — static directions | `split` — rotating policies |
|---------|-------|------------------------------|--------------------------|
| Orca | — | `right` `down` | Defaults to `right` |
| cmux | ✓ | `left` `right` `up` `down` | `clockwise` `counterclockwise` |
| tmux | ✓ | `left` `right` `up` `down` | `clockwise` `counterclockwise` |
| iTerm2 | ✓ | `right` `down` | — (use fallback list) |
| Terminal.app | ✓ | — (error) | — (error) |
| Ghostty | — (new window) | — (error) | — (error) |
| Warp | ✓ | — (error) | — (error) |

Backends without a default for the requested `splitDirection` fail fast with an explicit error. Use a comma-separated preference list to select a supported direction across backends (e.g. `"counterclockwise,right"`).

## Examples

```text
/branch
```
Fork current session and open in a new pane/tab using config defaults.

```text
/branch explore the auth edge cases
```
Fork with a queued message.  The child session opens with `"explore the auth edge cases"` prefilled in the editor and a 10-second auto-submit countdown.

```text
/branch --model flash
```
Fork using a fuzzy model query.  If the current provider is Anthropic, `flash` would resolve to the closest Gemini Flash match available; if unresolvable the child keeps the parent's model.

```text
/branch --model gemini/flash-2.5 try rewriting the parser without recursion
```
Fork with both a target model and a queued message.

## Building and publishing

To release from a dot314 repository checkout, use Node.js 24 or newer and `trash` on your PATH. Update the version in `packages/pi-branch-out/package.json`, then run these commands from the repository root:

```bash
cd packages/pi-branch-out
npm run test:package
npm pack
```

The package-local `.npmrc` enables npm lifecycle scripts. Packing runs `prepack` to copy the current extension source and check for local JSON configs. The package test checks the tarball against the source and runs the Orca tests on its extracted implementation.

Publish the resulting tarball with `npm publish <tarball-path>`.

## Upstream credit

An earlier version of this extension began as an iteration on davidgasquez's [`branch-term.ts`](https://github.com/davidgasquez/dotfiles/blob/main/agents/pi/extensions/branch-term.ts), MIT license.
