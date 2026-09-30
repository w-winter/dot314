# AGENTS.md

Read [DEVELOPMENT.md](DEVELOPMENT.md) before changing behavior. It holds the invariants and the test setup, and this file does not repeat them.

## Working here
- Pi may load this checkout live (`src/index.ts`), and a change takes effect on the next `/reload`. Do multi-commit work in a git worktree, and move main only after its checks pass.
- Commits use Conventional Commits and open with the problem.
- Nothing in this repository names other GitHub users or where an idea came from. That covers commits, code, comments, tests, docs, and issue and PR text: no user mentions, no `owner/repo#N` references or issue/PR/commit links to other repositories, no Co-authored-by lines. `.git/hooks/commit-msg` checks commit messages; run it over the full diff and over any issue or PR body too, for example `git diff main..HEAD > /tmp/d && .git/hooks/commit-msg /tmp/d`. Any at-sign followed by a word counts, including test strings.
- Bound every test run, because a promise that never settles hangs the runner. macOS has no `timeout`, so wrap the command in a 250-second perl `alarm` that then `exec`s it, and add `--test-timeout=60000` for a single file. A hang is a bug to fix, not a timeout to raise. CI runs `test:ci` on Node 22.
- A test proves itself by failing without the change. Commit first, swap the source with `git show <base>:<file> > <file>`, run the test, then `git checkout HEAD -- <file>`. Never use `git stash`.
- Integration suites (`tests/int-*`) spend real Claude usage. Run them with Haiku, and only with a `claude-bridge.json` that sets `systemPrompt.replacement`; without one, Anthropic refuses the request as a third-party app.
