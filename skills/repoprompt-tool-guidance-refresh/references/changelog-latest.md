New Features

Cursor CLI agent support — full Agent Mode integration with dynamic model discovery, auto model fallback, and ACP session management
Workspace hiding — hide and restore workspaces from the manager
Agent handoff export — new MCP surfaces for exporting agent transcripts between windows and agents
Improvements

Bounded memory usage in codemap and ignore caches for large repos
Generalized ACP tool lifecycle handling for more consistent tool cards across providers
Cleaner RepoPrompt tool name parsing from ACP session titles
OpenCode running tool updates render more smoothly
Suppressed noisy session resume replay events when reopening ACP agents
Selection CLI output respects full paths when requested
Fixes

Fixed Tree-sitter scan crash
Fixed ACP auto-approval for RepoPrompt tools
Fixed stale codemap cache reuse across worktrees
Fixed OpenCode "none" variant grouping in model picker
Fixed agent input capsule vertical offset
Fixed markdown code block spacing
Restored persisted tool result subtitles after transcript reload
Fixed path regex anchor search in file finder
Removed

Removed diff capability allowlists — model diff support is now universal
