# branch-out

Fork the current Pi session into a split terminal pane or new tab with rotating layout policies, and with optional model and message queuing.  Routing, split geometry, and focus behavior are all config-driven.

## Command

```text
/branch [--model <query>] [message]
```

Both arguments are optional and independent.

- **`--model <query>`** — target model for the child session.  Accepts a fully qualified `provider/model-id` or a fuzzy query scoped to the current provider.  If the query does not resolve safely the child keeps the parent's model.
- **`message`** — prefilled text in the child session's editor with a 10-second auto-submit countdown.  Typing anything or pressing `Esc` cancels the countdown; `Enter` sends immediately.

## Config

Config lives in `extensions/branch-out/config.json` next to the extension.

```json
{
  "launchMode": "split",
  "splitDirection": "counterclockwise,right",
  "preserveFocus": false
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

State is persisted per backend and workspace key in `/tmp/pi-branch-out-layout-state.json`.  Stale entries are pruned against live pane/surface lists on each call.  To reset the policy entirely:

```bash
rm /tmp/pi-branch-out-layout-state.json
```

### `preserveFocus`

| Value | Behavior |
|-------|----------|
| `true` | Focus stays in the pane that ran `/branch` (default) |
| `false` | Focus moves to the newly created pane |

## Terminal backend routing

Routing is automatic and tried in this order:

1. `--branch-out-terminal` flag override (always wins)
2. cmux — detected via `CMUX_SOCKET_PATH`
3. tmux — detected via `TMUX`
4. iTerm2 — detected via `TERM_PROGRAM=iTerm.app`
5. Terminal.app — detected via `TERM_PROGRAM=Apple_Terminal`
6. Ghostty — detected via `GHOSTTY_RESOURCES_DIR` or `TERM_PROGRAM` containing `ghostty`
7. Fallback Alacritty window

### Backend capability matrix

| Backend | `tab` | `split` — static directions | `split` — rotating policies |
|---------|-------|------------------------------|--------------------------|
| cmux | ✓ | `left` `right` `up` `down` | `clockwise` `counterclockwise` |
| tmux | ✓ | `left` `right` `up` `down` | `clockwise` `counterclockwise` |
| iTerm2 | ✓ | `right` `down` | — (use fallback list) |
| Terminal.app | ✓ | — (error) | — (error) |
| Ghostty | — (new window) | — (error) | — (error) |

Backends that don't support the requested `splitDirection` fail fast with an explicit error rather than silently doing something else.  Use a comma-separated fallback list in `splitDirection` to handle this gracefully (e.g. `"counterclockwise,right"` works on all split-capable backends).

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

## Upstream credit

An earlier version of this extension began as an iteration on davidgasquez's [`branch-term.ts`](https://github.com/davidgasquez/dotfiles/blob/main/agents/pi/extensions/branch-term.ts).