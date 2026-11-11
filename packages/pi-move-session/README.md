# Move Session for Pi (`pi-move-session`)

Move the current Pi session to a different working directory and relaunch Pi there. Add `--family` to move its whole family together.

## Install

From npm:

```bash
pi install npm:pi-move-session
```

From the dot314 git bundle (filtered install):

```json
{
  "packages": [
    {
      "source": "git:github.com/w-winter/dot314",
      "extensions": ["extensions/move-session/index.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

The `pi` and `trash` commands must be available on `PATH`.

## Usage

```text
/move-session <targetCwd>
/move-session --family <targetCwd>
```

The target directory must already exist. Paths support spaces, relative paths, and `~` expansion. Enter them without surrounding quotes.

```text
/move-session ~/code/my-project
/move-session --family ~/code/my-project
/move-session --family $main-worktree
```

`$main-worktree` selects the current Git repository's main worktree. Put `--family` before the target path.

### Move a whole family

`--family` follows the current session's `parentSession` links to its oldest ancestor, then includes every descendant of that ancestor. This includes other sessions sharing a parent and all their descendants, across working directories. The confirmation shows the session count, source paths, and target working directory.

Close every other Pi process using a session in that family before confirming, and keep them closed until the move finishes. Other processes can still write to session files during a move. File-change checks stop cleanup if they detect an edit.

Family discovery searches the working-directory folders under the configured Pi agent directory's `sessions/`, plus folders containing the current session and its ancestors. Parent links between session files define the family. Branches inside a session's `/tree` remain part of that session file.

The move retains session IDs, timestamps, metadata, and every byte of history after the header. It assigns new filenames, changes each session's working directory, and rewrites parent links to the relocated files. Pi resumes the session where you ran the command.

### Move one session

Without `--family`, the command copies the current session into a new session with a new ID and no parent link, then trashes the original after launching Pi. Use `--family` when you want related sessions to remain connected.

Both modes reopen at the session file's default branch tip. If your current `/tree` selection differs, the extension warns before proceeding.

## Safety and recovery

A family move verifies every copied history before launching Pi. Missing parents, parent cycles, unreadable files, malformed headers in the selected family, and destination conflicts stop the move. Originals stay in place until the complete destination family exists and the new Pi process has spawned.

If copying or launching fails, the extension trashes the copies it created and keeps the originals. If cleanup fails after launch, it keeps the complete destination family and reports the original paths to inspect. The command uses recoverable Trash for originals and reports trash failures.

Moving several files is not an atomic filesystem operation. After an interruption or cleanup error, inspect the reported paths and Trash before retrying. Resume a moved session with `pi --session <path>`; recover originals from Trash if needed. Keep other family sessions closed while resolving an incomplete move.

## Tests

From the dot314 repository root, with Bun and `trash` installed:

```bash
bun test extensions/move-session/test
```

The tests create temporary session families and check their resulting files, ancestry, and failure recovery. Test directories go to Trash after each test.
