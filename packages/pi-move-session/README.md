# Move Session for Pi (`pi-move-session`)

Losslessly move a live Pi session to a different working directory and jump into the new session. Useful when you need a session to move to a different working directory after it's already built up valuable context.

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
      "extensions": ["extensions/move-session.ts"],
      "skills": [],
      "themes": [],
      "prompts": []
    }
  ]
}
```

## Usage

```
/move-session <targetCwd>
```

Supports `~` expansion (e.g. `/move-session ~/code/my-project`).

## How it works

1. Forks the current session JSONL into the target cwd's session bucket via `SessionManager.forkFrom()`
2. Tears down the parent's terminal state (Kitty keyboard protocol, bracketed paste, cursor visibility)
3. Spawns a new `pi --session <fork>` process in the target directory with inherited stdio
4. Trashes the old session file (via `trash` if available; never permanently deletes)
5. Destroys the parent's stdin so it can't steal keypresses from the child

The parent process stays alive as an inert wrapper that forwards the child's exit code.
