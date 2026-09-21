# pi-queue-steer

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A visible steering and follow-up timeline for [Pi](https://github.com/earendil-works/pi-mono).

Queue instructions while the agent works. Steering stays in a blue next-turn box. Follow-ups stay in a yellow after-this-run box beneath it. Both lanes remain independent first-in, first-out queues and keep Pi’s delivery timing.

Move into any row to edit it. The selected row becomes the live Pi editor, with its cursor, wrapping, paste handling, autocomplete and custom-editor behaviour intact.

## Demo

![Looping demonstration of steering and follow-up queues while Pi continues working](assets/pi-queue-steer-demo.gif)

## Install

Install dot314 and enable `pi-queue-steer` with `pi config`:

```bash
pi install git:github.com/w-winter/dot314
```

Then start a new Pi session or run `/reload`.

Try a local checkout for one session:

```bash
pi -e ./index.ts
```

## Changes from upstream

The upstream source is [tmustier/pi-queue-steer](https://github.com/tmustier/pi-queue-steer). This version adds `/followup <message>`, `/steer <message>` while editing a follow-up, and symmetric `Option+Enter` conversion between steering and follow-up rows. It also emits a content-free accepted-steering event that `pi-repoprompt-mcp` uses to interrupt attended RepoPrompt waits when Pi accepts new steering.

## Controls

The extension follows your configured Pi action bindings. These are the default keys on macOS terminals:

| Context | Key | Action |
|---|---|---|
| Agent working | `Enter` | Add visible steering for Pi’s next safe turn boundary |
| Agent working | `Option+Enter` | Add a visible follow-up for after the run |
| Any time | `/followup <message>` | Add a visible follow-up without a modifier-key chord |
| Queue visible | `Option+Up` | Select the most recently queued row |
| Editing a row | `Option+Up` | Keep the current draft and move to the previous visual row |
| Editing a row | `Option+Down` | Keep the current draft and move to the next visual row |
| Editing a row | Type normally | Edit directly inside the selected row |
| Editing a steering row | `Enter` | Save all row edits without changing their lanes |
| Editing a steering row | `Option+Enter` | Save all row edits and move the selected row to the end of the follow-up queue |
| Editing a steering row | `/followup <message>` then `Enter` | Replace the selected row with `<message>` and move it to the end of the follow-up queue |
| Editing a follow-up row | `Enter` | Save all row edits without changing their lanes |
| Editing a follow-up row | `Option+Enter` | Save all row edits and move the selected row to the end of the steering queue |
| Editing a follow-up row | `/steer <message>` then `Enter` | Replace the selected row with `<message>` and move it to the end of the steering queue |
| Editing a row | `Escape` | Cancel the session and roll back all unsaved row edits |
| Queue paused after an abort | `Enter` | Resume from the next steering row, or the next follow-up |
| Agent working, queue visible | `Escape` | Abort the run and pause both visible lanes |

`Option+Down` is the only new fixed shortcut. The other controls use Pi’s configured action bindings. Terminals outside macOS may label `Option` as `Alt`.

## Delivery semantics

The extension keeps Pi’s 2 delivery classes:

- steering reaches the current run at Pi’s next safe turn boundary
- follow-ups wait until the run finishes
- the blue steering box remains above the yellow follow-up box
- each lane keeps its own first-in, first-out order
- Pi’s `one-at-a-time` and `all` settings apply independently at active-run delivery boundaries
- screenshots staged by `screenshots-picker` attach to queued steering and follow-ups, including `/followup <message>`

The extension hands messages back to Pi’s native queues only when their delivery boundary arrives. They remain visible and editable before that point. Pi records delivered rows as normal user messages.

## Accepted steering event

When the extension accepts a new interactive steering row, it synchronously emits `pi-queue-steer:accepted-steer:v1` on `pi.events`. The payload is `{ version: 1, producer: "pi-queue-steer", producerEpochId, sessionId, sequence }`.

The payload contains identifiers only and never includes message content. `producerEpochId` changes at each Pi session start, and `sequence` increases for each newly accepted steering row in that session. Use `sessionId`, `producerEpochId` and `sequence` to reject duplicate or stale notifications.

Only a newly accepted interactive steering row emits this event.

## Editing semantics

- `Option+Up` starts at the row you queued most recently
- `Option+Up` and `Option+Down` then move through the visible timeline
- `Enter` saves edits without changing a row’s position or delivery class
- `Option+Enter` moves the selected row to the end of the opposite queue
- `/followup <message>` converts steering to follow-up, and `/steer <message>` converts a follow-up to steering
- the extension removes the command prefix before saving the converted message
- a selected row becomes the real editor without a nested composer frame
- one editing session can hold drafts for several rows
- `Escape` restores every row from the session snapshot
- saving an empty text-only row removes it
- image-only rows remain queued
- an unrelated composer draft is stashed and restored when editing ends

A touched head row is pinned until you save or cancel. In `one-at-a-time` mode, later rows do not block the head. In `all` mode, editing any row holds that whole lane at active-run delivery boundaries.

## Abort and recovery

Aborting a run pauses both visible lanes. This prevents a follow-up from starting immediately after the abort.

Press `Enter` on the empty composer to resume. A failed handoff returns the affected batch to the front of its lane.

Queue state, pause state and edit drafts are session-local. They never enter the Pi transcript.

## Proof limitation

If an `all`-mode lane stays pinned until the agent settles, saving from idle restarts the run with that lane’s head. Pi receives the remaining rows at the next native boundary. Exact single-batch restart after this edge case remains open before release.

## Editor composition

pi-queue-steer wraps the active Pi editor. It does not replace Pi’s input model.

For display, it extracts the live editor’s text and cursor from the editor frame. It then places that content inside the selected queue row. Autocomplete remains below the edited text.

The extension composes with custom editors including raw-paste and pi-session-hud.

## Development

```bash
npm install
npm run ci
pi -e ./index.ts
```

The automated suite covers both lanes, queue modes, delivery boundaries, stable edits, rollback, abort recovery, image preservation, failed handoffs, editor-frame extraction and editor composition. Check TUI changes in a real interactive Pi session as well.

Tested with Pi 0.80.9.

## Security

Pi extensions run with the same system permissions as Pi. Review extension source before installing a third-party package.

## Licence

MIT. See [LICENSE](LICENSE).

This project draws on Cursor’s queue interaction. It is not affiliated with Cursor or Anysphere.
