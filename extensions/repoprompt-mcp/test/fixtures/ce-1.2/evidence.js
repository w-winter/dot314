export const evidence = {
  target: "ce-1.2",
  catalogSource: "skills/repoprompt-tool-guidance-refresh/rp-tool-defs/rpcecli-l__1.2.0.txt",
  inventorySource: [
    "extensions/repoprompt-mcp/docs/investigations/repoprompt-mcp-contract-breakage-audit-2026-08-03.md",
    "repoprompt-ce:Sources/RepoPrompt/Infrastructure/MCP/WindowRoutingService.swift@v1.2.0",
  ],
  provenance: "sanitized source-grounded reconstruction of the stored three-window reproduction",
  jsonInventory: "proven",
  connectionBinding: "proven",
  hiddenRawJson: "proven",
  hiddenWindowSelector: "proven",
  operationEvidence: {
    bindContext: "rpcecli-l__1.2.0.txt plus WindowRoutingService.swift",
    manageWorkspaces: "rpcecli-l__1.2.0.txt plus WindowRoutingService.swift",
    manageWorktree: "rpcecli-l__1.2.0.txt plus MCPWorktreeToolProvider.swift and MCPDomainProtectedMutationToolProvider.swift",
    agentRun: "rpcecli-l__1.2.0.txt",
    agentManage: "rpcecli-l__1.2.0.txt",
  },
};

const manageWorkspaceProperties = {
  action: {
    type: "string",
    enum: [
      "list", "switch", "create", "hide", "unhide", "delete", "add_folder", "remove_folder",
      "list_tabs", "select_tab", "create_tab", "close_tab",
    ],
  },
  allow_active: { type: "boolean" },
  bind: { type: "boolean" },
  close_window: { type: "boolean" },
  focus: { type: "boolean" },
  folder_path: { type: "string" },
  include_hidden: { type: "boolean" },
  mode: { type: "string" },
  name: { type: "string" },
  open_in_new_window: { type: "boolean" },
  source_tab: { type: "string" },
  switch_to_created: { type: "boolean" },
  tab: { type: "string" },
  window_id: { type: "integer" },
  workspace: { type: "string" },
};

export const catalog = {
  target: "ce-1.2",
  tools: [
    {
      name: "bind_context",
      description: "Canonical routing inventory and binding",
      inputSchema: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["list", "status", "bind"] },
          context_id: { type: "string" },
          create_if_missing: { type: "boolean" },
          tab_name: { type: "string" },
          working_dirs: { type: "string" },
        },
        required: ["op"],
      },
    },
    {
      name: "manage_workspaces",
      description: "Workspace inventory and lifecycle",
      inputSchema: {
        type: "object",
        properties: manageWorkspaceProperties,
        required: ["action"],
      },
    },
    {
      name: "manage_worktree",
      description: "Worktree and session-worktree management",
      inputSchema: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["list", "show", "create", "bind", "select", "unbind", "preview", "apply", "status", "continue", "abort"],
          },
          session_id: { type: "string" },
          repo_root: { type: "string" },
          worktree: { type: "string" },
          worktree_id: { type: "string" },
        },
        required: ["op"],
      },
    },
    {
      name: "agent_run",
      description: "Agent run lifecycle",
      inputSchema: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["start", "poll", "wait", "cancel", "steer", "respond"] },
          session_id: { type: "string" },
          session_ids: { type: "array", items: { type: "string" } },
        },
        required: ["op"],
      },
    },
    {
      name: "agent_manage",
      description: "Agent session metadata",
      inputSchema: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: [
              "list_agents", "list_sessions", "get_log", "extract_handoff", "handoff", "create_session",
              "resume_session", "stop_session", "cleanup_sessions", "list_workflows",
            ],
          },
          session_id: { type: "string" },
          session_ids: { type: "array", items: { type: "string" } },
        },
        required: ["op"],
      },
    },
    {
      name: "oracle_send",
      description: "Oracle conversations",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
          mode: { type: "string", enum: ["chat", "plan", "review"] },
          chat_id: { type: "string" },
          export_response: { type: "boolean" },
          model: { type: "string" },
          new_chat: { type: "boolean" },
        },
        required: ["message"],
      },
    },
    {
      name: "get_code_structure",
      description: "Committed code structure",
      inputSchema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" } },
          expand: { type: "string", enum: ["uses", "used_by", "both"] },
          depth: { type: "integer" },
          signatures: { type: "boolean" },
          size: { type: "string", enum: ["small", "medium", "large"] },
        },
      },
    },
    {
      name: "get_file_tree",
      description: "File tree and roots",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["files", "roots"] },
          mode: { type: "string", enum: ["auto", "full", "folders", "selected"] },
          path: { type: "string" },
          max_depth: { type: "integer" },
        },
      },
    },
  ],
};

const unboundBinding = {
  binding_kind: "unbound",
  repo_paths: [],
  explicit: false,
  run_scoped: false,
};

export const inventoryScenarios = {
  incompleteWorkspaceInventoryWindowIds: [2, 10],
  multiWindow: {
    windows: [
      {
        window_id: 2,
        is_current_window: false,
        workspace: { id: "00000000-0000-4000-8000-000000000002", name: "workspace-two" },
        active_context_id: "00000000-0000-4000-8000-000000000202",
        tabs: [{
          context_id: "00000000-0000-4000-8000-000000000202",
          name: "Tab Two",
          workspace_id: "00000000-0000-4000-8000-000000000002",
          workspace_name: "workspace-two",
          is_active: true,
          is_bound: false,
          repo_paths: ["/fixtures/workspace-two", "/fixtures/shared"],
        }],
      },
      {
        window_id: 10,
        is_current_window: true,
        workspace: { id: "00000000-0000-4000-8000-000000000010", name: "workspace-ten" },
        active_context_id: "00000000-0000-4000-8000-000000001010",
        tabs: [{
          context_id: "00000000-0000-4000-8000-000000001010",
          name: "Tab Ten",
          workspace_id: "00000000-0000-4000-8000-000000000010",
          workspace_name: "workspace-ten",
          is_active: true,
          is_bound: true,
          repo_paths: ["/fixtures/workspace-ten"],
        }],
      },
      {
        window_id: 11,
        is_current_window: false,
        workspace: { id: "00000000-0000-4000-8000-000000000011", name: "workspace-eleven" },
        active_context_id: "00000000-0000-4000-8000-000000001111",
        tabs: [{
          context_id: "00000000-0000-4000-8000-000000001111",
          name: "Tab Eleven",
          workspace_id: "00000000-0000-4000-8000-000000000011",
          workspace_name: "workspace-eleven",
          is_active: true,
          is_bound: false,
          repo_paths: ["/fixtures/workspace-eleven"],
        }],
      },
    ],
    binding: {
      binding_kind: "tab_context",
      window_id: 10,
      context_id: "00000000-0000-4000-8000-000000001010",
      workspace_id: "00000000-0000-4000-8000-000000000010",
      workspace_name: "workspace-ten",
      tab_name: "Tab Ten",
      repo_paths: ["/fixtures/workspace-ten"],
      explicit: true,
      run_scoped: false,
    },
  },
  validEmpty: { windows: [], binding: unboundBinding },
  unbound: {
    windows: [{
      window_id: 2,
      is_current_window: true,
      workspace: { id: "00000000-0000-4000-8000-000000000002", name: "workspace-two" },
      active_context_id: "00000000-0000-4000-8000-000000000202",
      tabs: [{
        context_id: "00000000-0000-4000-8000-000000000202",
        name: "Tab Two",
        workspace_id: "00000000-0000-4000-8000-000000000002",
        workspace_name: "workspace-two",
        is_active: true,
        is_bound: false,
        repo_paths: ["/fixtures/workspace-two"],
      }],
    }],
    binding: unboundBinding,
  },
  rootUnavailable: {
    windows: [{
      window_id: 12,
      is_current_window: false,
      workspace: { id: "00000000-0000-4000-8000-000000000012", name: "workspace-twelve" },
      tabs: [],
    }],
    binding: unboundBinding,
  },
  malformed: { windows: [{ window_id: "eleven", tabs: [] }] },
};
