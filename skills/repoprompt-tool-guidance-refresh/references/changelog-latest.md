[2.1.3] - 2026-04-04

Improvements
Smarter workspace binding — bind_context now resolves workspaces by matching repo paths against open folders
Auto-switches workspace in the target window when the matched workspace isn't already active
Clearer bind_context responses showing match method, candidate counts, and actionable error messages

Fixes
Fixed branch comparison diffs showing wrong files — review mode and MCP diff tools now use merge-base semantics, preventing base branch changes from being misattributed as your work
Fixed bash tool cards auto-expanding when the agent stream returned to idle
Filtered noisy diagnostic output from discovery agent logs
