# AGENTS Prefaces

Templates for the start of `AGENTS.md` or `CLAUDE.md` files. These steer agents to use RepoPrompt tools preferentially and effectively.

## Files

- `rp-cli-preface.md` — RepoPrompt CLI integration (`rp_exec`, `rp_bind`)
- `rp-mcp-preface.md` — RepoPrompt MCP integration (`rp` tool)
- `rp-mcp-preface-exPi.md` — MCP variant for non-Pi harnesses (Claude Code, Codex, etc.)

## Notes

The exPi variant is intended for other agent harnesses and omits Pi-specific features.

The other variants include a section advising usage of the `session_ask` and `session_lineage` tools, which are unrelated to RepoPrompt but are offered in this repo.  They also include a section advising usage of the `web_search`, `fetch_content`, and `search_github` tools, which are not included in this repo but can be installed via `pi install npm:pi-web-access` (see [nicobailon/pi-web-access](https://github.com/nicobailon/pi-web-access)).
