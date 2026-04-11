2.1.5 - April 8, 2026
New Features

context_builder and oracle can now export their responses directly
Orchestrate workflow available as an MCP prompt and installable managed skill
GPT-5.4 Mini API model variants with low, high, and xhigh reasoning tiers
Improvements

Agent mode elapsed timer stays accurate when steering active sessions
Improved scroll behavior in agent transcripts — better detection of manual scroll intent
Smarter workspace binding — bind_context falls back to repo_paths superset matching when no exact match exists
Orchestrate workflow uses phased verify-then-steer loop for more reliable agent delegation
Fixes

Fixed Codex not being able to perform edits in Pro Edit mode
Fixed several issues related to ACP
Fixed stale agent sessions after app restart — orphaned active states are now properly cancelled

2.1.6:
New Features
OpenCode Agent Provider — full support for OpenCode as an Agent Mode provider, including ACP integration, dynamic model polling, settings, and discovery
Improvements
Agent providers gated by connected CLIs — Agent Mode only shows providers whose CLIs are actually available
Codex CLI path preflight — validates the Codex executable before launching, with clearer error messages when the CLI isn't found
Improved Codex connection flow — clearer setup and authentication UI for Codex
Improved CLI process launching — better detection of your PATH variables ensures CLI providers launch more reliably
Fixes
Fixed agent transcript scrolling — restored transcripts now scroll correctly
Fixed prompt export — exports now correctly use the workspace root
Fixed Codex error reporting — errors are now shown instead of failing silently
Removed
Sidebar terminal — removed the integrated terminal from the sidebar
