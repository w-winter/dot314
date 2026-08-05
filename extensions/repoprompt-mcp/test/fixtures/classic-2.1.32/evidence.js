import { inventoryScenarios as sharedJsonShapeScenarios } from "../ce-1.2/evidence.js";

export const evidence = {
  target: "classic-2.1.32",
  build: 334,
  catalogSource: "live 2.1.32 capability probe against the stored rpcli-l__2.1.29.txt minimum schema",
  inventorySource: "live E2E parser diagnostic reporting binding_kind context; raw result not stored",
  provenance: "2.1.32 live contract observation plus synthetic inventory scenarios",
  jsonInventory: "unresolved",
  connectionBinding: "unresolved",
  hiddenRawJson: "unresolved",
  hiddenWindowSelector: "unresolved",
  operationEvidence: {
    bindContext: "live 2.1.32 capability probe and E2E inventory observation",
    manageWorkspaces: "live 2.1.32 capability probe",
    manageWorktree: "not required by the Classic target profile",
    agentRun: "live 2.1.32 capability probe",
    agentManage: "live 2.1.32 capability probe",
  },
  diagnostic: "Classic 2.1.32 (334) reports binding_kind context; raw inventory and hidden-selector captures remain unavailable",
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
  mode: { type: "string", enum: ["blank", "fork"] },
  name: { type: "string" },
  open_in_new_window: { type: "boolean" },
  source_tab: { type: "string" },
  switch_to_created: { type: "boolean" },
  tab: { type: "string" },
  window_id: { type: "integer" },
  workspace: { type: "string" },
};

export const catalog = {
  target: "classic-2.1.32",
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
          window_id: { type: "integer" },
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
          mode: { type: "string", enum: ["chat", "plan", "edit", "review"] },
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
      description: "Code structure",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["paths", "selected"] },
          paths: { type: "array", items: { type: "string" } },
          max_results: { type: "integer" },
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

const multiWindow = structuredClone(sharedJsonShapeScenarios.multiWindow);
multiWindow.binding.binding_kind = "context";

export const inventoryScenarios = {
  ...sharedJsonShapeScenarios,
  multiWindow,
  provenance: "Classic 2.1.32 binding_kind context with otherwise synthetic parser scenarios",
};
