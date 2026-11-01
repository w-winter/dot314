# Native MCP approvals for Pi

Require per-call approval for selected tools from Pi's native MCP integration, including calls made through codemode.

## Install

```bash
pi install npm:pi-native-mcp-approvals
```

Configure the policy below, then run `/reload` to load the extension.

## Configuration

Create `~/.pi/agent/extensions/native-mcp-approvals/config.json`. If you set `PI_CODING_AGENT_DIR`, use that directory in place of `~/.pi/agent`. This location applies to npm and source installations and keeps your policy outside the npm package directory.

```json
{
  "approveTools": ["delete_*", "remove_*"],
  "exemptServers": []
}
```

The package includes this example at `extensions/native-mcp-approvals/config.json.example`.

- `approveTools`: patterns for tools that require approval. Match the name shown in Pi's catalog after removing the `mcp__<server>__` prefix. Matching is case-sensitive; `*` matches any characters, and other punctuation is converted to underscores as Pi does for tool names. For shortened names, use the suffix Pi displays, including its hash, or a wildcard pattern.
- `exemptServers`: server names from `mcp.json` whose calls proceed without this extension's approval. An empty array exempts no servers.

Both fields are required arrays of strings. Server names may contain letters, digits, underscores and hyphens. Extra fields are rejected. The extension reads the file before each native MCP server-tool call, so policy edits apply to the next call. A missing, unreadable or invalid file blocks those calls until the configuration is fixed.

## Approval behavior

The prompt shows the tool name and arguments. Approval permits that one call; denial, dismissal or cancellation blocks it. A call requiring approval is also blocked when no interactive approval UI is available. Exempt servers and tools that match no pattern proceed without this extension's approval.

Use native MCP's `toolExposure` settings in `mcp.json` to hide tools from discovery and execution.
