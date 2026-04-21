New Features

Redesigned Settings with a dedicated window, modernized sidebar, and agent-first organization that progressively reveals advanced options
Agent Models settings — a new home for configuring recommendations and model selection per agent role
Agent Permissions settings with separate scopes for direct and sub-agent permissions, and a tri-state sub-agent policy
Toolbar update pill — surfaces available Sparkle updates directly in the toolbar
App Settings MCP tool — query and update app preferences from MCP clients and the CLI, with an options op for discovering allowed values
Agent Explore tool — a lightweight, read-only exploration tool for sub-agent contexts
Improvements

Secure storage for agent and provider permission preferences
Global settings now backed by JSON in Application Support; presets moved alongside
Refined Settings typography, spacing, and section layouts throughout
Claude reasoning now shown in live agent status
Claude Code auto permission mode supported for Opus 1M
Cleaner update notifications with separate passive vs. user-initiated flows
Copy button on agent error bubbles
Reorganized orchestration skills (rp-orchestrate, rp-investigate) for clearer delegation
Updated Gemini recommendation defaults
Fixes

Hardened MCP transport lifecycle and compatibility edge cases
Agent file mention display and caret placement
Claude auto permission fallback behavior
file_actions now requires absolute paths to prevent ambiguity
app_settings accepts string-encoded booleans and numbers from MCP clients