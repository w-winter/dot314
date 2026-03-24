# Files Touched for Pi (`pi-files-touched`)

Deterministic file-activity tracking across a Pi session branch that registers `/files-touched`, a picker that lists every file the agent has read, written, edited, moved, or deleted.  The list is sorted newest-first and has colored `R`/`W`/`E`/`M`/`D` operation badges and normalized paths.

Evolved from [`pi-mono/.pi/extensions/files.ts`](https://github.com/badlogic/pi-mono/blob/main/.pi/extensions/files.ts) by Mario Zechner (MIT).  See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Install

```bash
pi install npm:pi-files-touched
```

## What it tracks

`pi-files-touched` walks the current branch of the Pi session tree and collects file activity from:

- **Pi native tools**: `read`, `write`, `edit` tool calls matched with their tool results
- **RepoPrompt tools**: `rp` and `rp_exec` tool calls: `read_file`, `apply_edits`, `file_actions` (create/move/delete), `git mv`, `git rm`
- **Bash commands**: `sed -i` (edit), `cp`/`rsync` (write destination), `tee`/`touch` (write), `patch` (edit), `curl -o`/`wget -O` (write), `cat`/`head`/`tail` (read), shell output redirections (`>`, `>>`), `mv` (move), `rm`/`trash` (delete), heredoc body filtering

All path spellings — relative, root-prefixed (`RootName:path`), and absolute — are normalized and coalesced so the same file appears once regardless of how different tools referred to it.  File moves are tracked and earlier references are carried forward to the final path.

## Shared core for other extensions

The tracking engine lives in `extensions/_shared/files-touched-core.ts` and is designed to be imported by other extensions that need an authoritative, deterministic manifest of file activity across any segment of the session tree.

```typescript
import { collectFilesTouched, type FilesTouchedEntry, type FileTouchOperation } from "./_shared/files-touched-core.ts";

// Walk the current branch
const files = collectFilesTouched(ctx.sessionManager.getBranch(), ctx.cwd);

// Or pass any subset of session entries (e.g., the entries being compacted)
const spanFiles = collectFilesTouched(entriesToSummarize, ctx.cwd);
```

This is useful for extensions that generate compaction summaries, handoff documents, branch summaries, or anywhere else benefiting from a grounded file manifest instead of relying on LLM inference-mediated recall.

## `/files-touched`

Opens an interactive picker listing all files on the current branch.  You can select a file to open it in VS Code (supports Windows `cmd` launch hardening).

```
 ┌──────────────────────────────────────────────────┐
  Select file to open
  ▸ RW src/header.txt
    RE src/utils.ts
    E  src/config.ts
    W  src/synced.ts
    W  data/downloaded.json
    W  src/redirected.ts
    W  src/brand-new.ts
    W  src/copy.ts
  ↑↓ navigate • ←→ page • enter open • esc close
 └──────────────────────────────────────────────────┘
```

## License

MIT
