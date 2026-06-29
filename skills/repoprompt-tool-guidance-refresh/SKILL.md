---
disable-model-invocation: true
name: repoprompt-tool-guidance-refresh
description: Refresh RepoPrompt tool guidance when the CLI/MCP surface changes. Tracks RepoPrompt CE (`rpce-cli`, the maintained target) across versions, and can diff the frozen Classic CLI (`rp-cli`) against CE. Uses `~/.pi/agent/skills/repoprompt-tool-guidance-refresh/scripts/track-rp-version.sh` to capture/diff `--help` and `-l` (tool definitions) under `~/.pi/agent/skills/repoprompt-tool-guidance-refresh/rp-tool-defs/`.
---

# Workflow

RepoPrompt CE (`rpce-cli`) is the maintained target and the default for this skill. RepoPrompt Classic (`rp-cli`) is frozen — it no longer changes, so you only touch it for a one-shot cross-app comparison.

Two comparison modes:
- **Same CLI across versions** (the normal loop): older `rpce-cli` → newer `rpce-cli`, run as a pre/post pair around a CE upgrade.
- **Across apps** (one-shot): Classic `rp-cli` vs CE `rpce-cli`, to understand where CE's tools/flags diverge from frozen Classic.

**Canonical locations** (use these even if your working directory differs):
- Skill directory: `~/.pi/agent/skills/repoprompt-tool-guidance-refresh/` (may be a symlink target)
- Script: `~/.pi/agent/skills/repoprompt-tool-guidance-refresh/scripts/track-rp-version.sh`
- Output directory: `~/.pi/agent/skills/repoprompt-tool-guidance-refresh/rp-tool-defs/`

Snapshots are namespaced per CLI so Classic and CE never collide: CE writes `rpcecli-help__{VERSION}.txt` / `rpcecli-l__{VERSION}.txt` with baseline `.baseline_version__rpcecli`; Classic writes `rpcli-*` (frozen, last captured at v2.1.29).

## Phase A — Pre-Upgrade (invoke BEFORE updating RepoPrompt CE)

1. Run the version tracking script:
   ```bash
   ~/.pi/agent/skills/repoprompt-tool-guidance-refresh/scripts/track-rp-version.sh --pre
   ```
   (Defaults to CE. Equivalent if you `cd` into the skill dir: `./scripts/track-rp-version.sh --pre`.)

2. The script writes a baseline snapshot under `rp-tool-defs/`:
   - `.baseline_version__rpcecli` — the baseline `rpce-cli` version
   - `rpcecli-help__{VERSION}.txt` — output of `rpce-cli --help`
   - `rpcecli-l__{VERSION}.txt` — output of `rpce-cli -l`

3. **Stop here.** Tell the user:
   > ✓ Baseline captured at v{VERSION}. Go update RepoPrompt CE, then re-invoke this skill.

## Phase B — Post-Upgrade (invoke AFTER updating RepoPrompt CE)

1. Run the version tracking script:
   ```bash
   ~/.pi/agent/skills/repoprompt-tool-guidance-refresh/scripts/track-rp-version.sh --post
   ```

2. On version change, the script captures a *new* snapshot and generates diffs under `rp-tool-defs/`:
   - `rpcecli-help__{NEW_VERSION}.txt` / `rpcecli-l__{NEW_VERSION}.txt` — new snapshots
   - `rpcecli-help__{NEW_VERSION}.diff` — changes in `rpce-cli --help`
   - `rpcecli-l__{NEW_VERSION}.diff` — changes in `rpce-cli -l` (MCP tool definitions)

3. If no changes detected in the diffs, tell the user and stop:
   > ✓ No MCP/CLI tool changes detected. Documentation is current.

4. **(Optional) Changelog context**: Ask the user:
   > Paste release notes for v{NEW_VERSION} (or press Enter to skip):

   If provided, write to `~/.pi/agent/skills/repoprompt-tool-guidance-refresh/references/changelog-latest.md`. If skipped, proceed using diffs as ground truth.

5. **Review diffs** and identify what changed:
   - New tools
   - Removed tools
   - Changed parameters or descriptions
   - New modes/options

## Phase C — Update MCP documentation (primary output)

The `rp` MCP tool surface is what Pi agents actually use, and it is app-neutral, so CE tool/help changes flow here.

1. The MCP files live outside this skill folder:
   - **AGENTS prefaces**: `agent/AGENTS-prefaces/rp-mcp-*.md`
   - **Prompts**: `agent/prompts/rp-*.md` (excluding `*-cli.md`)

2. Using the diffs as reference, make surgical updates to bring these files into alignment with the new tool definitions.

## Phase D — Classic CLI documentation (only if a cross-app diff demands it)

Classic `rp-cli` is frozen, so its CLI docs do not need routine updates. The Classic-CLI artifacts are:
- **AGENTS preface**: `agent/AGENTS-prefaces/rp-cli-preface.md`
- **Prompts**: `~/.pi/agent/skills/repoprompt-tool-guidance-refresh/rp-cli-prompts/rp-*-cli.md`
- **Extension**: `agent/extensions/repoprompt-cli/` (deprecated)

Only touch these if a cross-app comparison (Phase F) shows the guidance relies on a Classic-only behavior that CE has changed or dropped.

## Phase E — Git

Stage the changed files (new snapshots/diffs under `rp-tool-defs/`, plus any updated docs).

## Phase F — Cross-app comparison (one-shot: Classic vs CE)

Use this to understand how CE's CLI/tool surface diverges from frozen Classic — useful when migrating guidance or validating the `repoprompt-mcp` extension's compatibility assumptions.

1. Ensure a current CE snapshot exists (capture one if needed):
   ```bash
   ./scripts/track-rp-version.sh --ce --force
   ```
   The frozen Classic baseline is already captured (`rpcli-*`, v2.1.29). To refresh it while Classic is still installed: `./scripts/track-rp-version.sh --classic --force`.

2. Generate the cross-app diffs:
   ```bash
   ./scripts/track-rp-version.sh --compare-apps
   ```
   This writes, under `rp-tool-defs/`:
   - `xapp-help__rpcli-{CLASSIC}__rpcecli-{CE}.diff` — `--help` differences
   - `xapp-l__rpcli-{CLASSIC}__rpcecli-{CE}.diff` — tool-definition differences

3. These diffs are large by design (different apps). Read them to spot CE tools, flags, or parameters that differ from Classic, then update Phase C (and only if necessary, Phase D).

---

# Scope of Relevant Changes

Only update documentation for changes that affect levers you directly use:
- New/changed/removed MCP tools
- New/changed/removed CLI commands or flags
- Changed parameters, modes, or behaviors

Ignore changes that only affect:
- RepoPrompt desktop app UI (without MCP/CLI changes)
- Integrations with other apps/harnesses (without MCP/CLI changes)
- Internal implementation details not exposed via tools

The diffs are the source of truth. If a changelog item has no corresponding signature in the diffs, it's not relevant to this refresh.

# Token Economy

The preface files are included in every session's system prompt. Keep them tight:
- Do not document OS-level implementation details (e.g., how delete works under the hood) unless agents need to reason about it
- When two ops overlap significantly (e.g., `extract_handoff` and `get_log` both read session transcripts), pick one canonical op for the preface and omit the other. Skills and prompts can expand on the omitted op when a specific workflow needs it
- Behavioral notes about agent roles (e.g., what `design` produces) should be ≤10 tokens — just enough to route correctly
