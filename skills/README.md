# Skills

## New or locally modified

- ● [`repoprompt-tool-guidance-refresh/`](repoprompt-tool-guidance-refresh/)
  - Maintenance skill for keeping RepoPrompt tool guidance up to date after new releases
  - Contents:
    - [`SKILL.md`](repoprompt-tool-guidance-refresh/SKILL.md)
    - [`changelog-latest.md`](repoprompt-tool-guidance-refresh/changelog-latest.md)
    - [`rp-cli-prompts/`](repoprompt-tool-guidance-refresh/rp-cli-prompts) — RP-CLI-specific prompts maintained by this skill

- ◐ [`qmd/`](qmd/)
  - Local search/indexing CLI usage (BM25 + vectors + hybrid)
  - Includes helper script(s) for intelligence-gathering alongside qmd searches (e.g. session log time-window reports)
  - Contents:
    - [`SKILL.md`](qmd/SKILL.md)
    - [`analyze-sessions.sh`](qmd/analyze-sessions.sh) — time-window filtering + aggregation/reporting for session logs

- ◐ [`dev-browser/`](dev-browser/) (upstream: [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser))
  - Persistent browser automation via the Dev Browser Chrome extension (Playwright-backed)
  - This version includes a token-efficient CLI wrapper and an extended Skill covering that
    - [`devbrowse`](dev-browser/devbrowse)
    - [`src/cli.ts`](dev-browser/src/cli.ts)
    - [`dev-browser/SKILL.md`](dev-browser/SKILL.md)

## Other skills

- ○ [`brave-search/`](brave-search/) (upstream: [badlogic/pi-skills](https://github.com/badlogic/pi-skills))
  - `SKILL.md`: Brave Search API web search + content extraction

- ○ [`gdcli/`](gdcli/) (upstream: [badlogic/pi-skills](https://github.com/badlogic/pi-skills))
  - `SKILL.md`: Google Drive CLI usage

- ◐ [`xcodebuildmcp/`](xcodebuildmcp/) (upstream: [cameroncooke/XcodeBuildMCP](https://github.com/cameroncooke/XcodeBuildMCP))
  - `SKILL.md`: local CLI wrapper for XcodeBuildMCP
  - With CLI for Pi created with [mcporter](https://github.com/steipete/mcporter)
