# AGENTS.md

Read [DEVELOPMENT.md](DEVELOPMENT.md) before changing behavior. It holds the invariants, the incident design and the test setup, and this file does not repeat them.

## Working here
- Pi may load this checkout live (`src/index.ts`), and a change takes effect on the next `/reload`. Do multi-commit work in a git worktree, and move main only after its checks pass.
- Commits use Conventional Commits and open with the problem.
- Nothing in this repository names other GitHub users or where an idea came from. That covers commits, code, comments, tests, docs, and issue and PR text: no user mentions, no `owner/repo#N` references or issue/PR/commit links to other repositories, no Co-authored-by lines. `.git/hooks/commit-msg` checks commit messages; run it over the full diff and over any issue or PR body too, for example `git diff main..HEAD > /tmp/d && .git/hooks/commit-msg /tmp/d`. Any at-sign followed by a word counts, including test strings.
- Bound every test run, because a promise that never settles hangs the runner. macOS has no `timeout`, so wrap the command in a 250-second perl `alarm` that then `exec`s it, and add `--test-timeout=60000` for a single file. A hang is a bug to fix, not a timeout to raise. CI runs `test:ci` on Node 22.
- A test proves itself by failing without the change. Commit first, swap the source with `git show <base>:<file> > <file>`, run the test, then `git checkout HEAD -- <file>`. Never use `git stash`.
- Integration suites (`tests/int-*`) spend real Claude usage. Run them with Haiku, and only with a `claude-bridge.json` that sets `systemPrompt.replacement`; without one, Anthropic refuses the request as a third-party app.

## Incidents
The bridge surfaces anomalies to the agent; it never files them on its own.

- When a notice lists an incident, inspect it with `claude_bridge_incident show <id>`. File it (`claude_bridge_incident file <id>`) only when it looks like a bridge bug worth fixing, and skip one-offs you can explain. The issue carries only the evidence the bridge recorded, never text of yours, and names any tool but Pi's built-ins and the bridge's own by a hash. After filing, tell the user the issue number and give them your analysis in chat.
- To fix a filed incident, start from the issue's flight-recorder snapshot: it is the event order to script in a fake-SDK unit test, and the issue names a test file that drives the same path. Write that test, show it fails, then fix. Close the issue from the fixing commit.
- A new anomaly needs a label in `INCIDENT_CLASSES` and a site in `INCIDENT_SITES` (`src/incidents.ts`), a sentence in `DESCRIPTIONS` (`src/incident-filer.ts`; the type check fails without it) and, when one fits, an entry in `REPRO_TESTS`.
- Classify by what the user experienced: `user-visible` (an error was shown), `silent` (the bridge recovered, including workarounds for Claude Code misbehavior), `external` (the API or a Claude Code version change) or `expected` (normal cleanup). Only `user-visible` and `silent` reach the agent as notices. An `expected` entry needs code evidence at its site that the event is benign.
- Incident evidence is validated by kind and never carries free text. Keep it that way when adding fields: add the field's kind to `projectDiagMetadata`, or it becomes a placeholder.
