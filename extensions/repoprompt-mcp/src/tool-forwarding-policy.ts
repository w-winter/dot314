import { ROUTE_SELECTOR_KEYS } from "./route-state.js";
import { normalizeToolName } from "./tool-names.js";

export const BIND_CONTEXT_OPERATIONS = ["list", "status", "bind"] as const;
export const MANAGE_WORKSPACES_ACTIONS = [
  "list",
  "switch",
  "create",
  "hide",
  "unhide",
  "delete",
  "add_folder",
  "remove_folder",
  "list_tabs",
  "select_tab",
  "create_tab",
  "close_tab",
] as const;
export const MANAGE_WORKTREE_OPERATIONS = [
  "list",
  "show",
  "create",
  "bind",
  "select",
  "unbind",
  "preview",
  "apply",
  "status",
  "continue",
  "abort",
] as const;
export const AGENT_RUN_OPERATIONS = ["start", "poll", "wait", "cancel", "steer", "respond"] as const;
export const AGENT_MANAGE_OPERATIONS = [
  "list_agents",
  "list_sessions",
  "get_log",
  "extract_handoff",
  "handoff",
  "create_session",
  "resume_session",
  "stop_session",
  "cleanup_sessions",
  "list_workflows",
] as const;

export type ForwardingClass =
  | "routing_observation"
  | "routing_mutation"
  | "workspace_observation"
  | "workspace_routing_mutation"
  | "route_independent"
  | "route_dependent";

export type OperationClassification =
  | { kind: "classified"; forwardingClass: ForwardingClass }
  | { kind: "rejected"; diagnostic: string };

const ROUTE_INDEPENDENT_TOOLS = new Set([
  "app_settings",
  "context_builder_wait",
  "oracle_send_wait",
]);

const BIND_CONTEXT_CLASSES: Readonly<Record<(typeof BIND_CONTEXT_OPERATIONS)[number], ForwardingClass>> = {
  list: "routing_observation",
  status: "routing_observation",
  bind: "routing_mutation",
};

const MANAGE_WORKSPACES_CLASSES: Readonly<
  Record<(typeof MANAGE_WORKSPACES_ACTIONS)[number], ForwardingClass>
> = {
  list: "workspace_observation",
  list_tabs: "workspace_observation",
  switch: "workspace_routing_mutation",
  create: "workspace_routing_mutation",
  hide: "workspace_routing_mutation",
  unhide: "workspace_routing_mutation",
  delete: "workspace_routing_mutation",
  add_folder: "workspace_routing_mutation",
  remove_folder: "workspace_routing_mutation",
  select_tab: "workspace_routing_mutation",
  create_tab: "workspace_routing_mutation",
  close_tab: "workspace_routing_mutation",
};

const MANAGE_WORKTREE_CLASSES: Readonly<
  Record<(typeof MANAGE_WORKTREE_OPERATIONS)[number], ForwardingClass>
> = {
  list: "route_dependent",
  show: "route_dependent",
  create: "workspace_routing_mutation",
  bind: "workspace_routing_mutation",
  select: "workspace_routing_mutation",
  unbind: "workspace_routing_mutation",
  preview: "route_dependent",
  apply: "route_dependent",
  status: "route_dependent",
  continue: "route_dependent",
  abort: "route_dependent",
};

const AGENT_RUN_CLASSES: Readonly<Record<(typeof AGENT_RUN_OPERATIONS)[number], ForwardingClass>> = {
  start: "route_dependent",
  poll: "route_independent",
  wait: "route_independent",
  cancel: "route_independent",
  steer: "route_independent",
  respond: "route_independent",
};

const AGENT_MANAGE_CLASSES: Readonly<Record<(typeof AGENT_MANAGE_OPERATIONS)[number], ForwardingClass>> = {
  list_agents: "route_independent",
  list_sessions: "route_dependent",
  get_log: "route_independent",
  extract_handoff: "route_independent",
  handoff: "route_independent",
  create_session: "route_dependent",
  resume_session: "route_independent",
  stop_session: "route_independent",
  cleanup_sessions: "route_independent",
  list_workflows: "route_independent",
};

function classifyKnownOperation(
  toolName: string,
  operation: unknown,
  table: Readonly<Record<string, ForwardingClass>>
): OperationClassification {
  if (typeof operation !== "string" || !Object.hasOwn(table, operation)) {
    return {
      kind: "rejected",
      diagnostic:
        `Unsupported ${toolName} operation ${JSON.stringify(operation)}; update the routing classification first`,
    };
  }

  return { kind: "classified", forwardingClass: table[operation] };
}

export function operationForTool(
  toolName: string,
  args: Readonly<Record<string, unknown>>
): unknown {
  return normalizeToolName(toolName).toLowerCase() === "manage_workspaces" ? args.action : args.op;
}

export function classifyForwardingOperation(toolName: string, operation?: unknown): OperationClassification {
  const normalizedName = normalizeToolName(toolName).toLowerCase();

  switch (normalizedName) {
    case "bind_context":
      return classifyKnownOperation(normalizedName, operation, BIND_CONTEXT_CLASSES);
    case "manage_workspaces":
      return classifyKnownOperation(normalizedName, operation, MANAGE_WORKSPACES_CLASSES);
    case "manage_worktree":
      return classifyKnownOperation(normalizedName, operation, MANAGE_WORKTREE_CLASSES);
    case "agent_run":
      return classifyKnownOperation(normalizedName, operation, AGENT_RUN_CLASSES);
    case "agent_manage":
      return classifyKnownOperation(normalizedName, operation, AGENT_MANAGE_CLASSES);
    default:
      return {
        kind: "classified",
        forwardingClass: ROUTE_INDEPENDENT_TOOLS.has(normalizedName) ? "route_independent" : "route_dependent",
      };
  }
}

export function isRoutingMutationClass(forwardingClass: ForwardingClass): boolean {
  return forwardingClass === "routing_mutation" || forwardingClass === "workspace_routing_mutation";
}

function omitRoutingSelectors(args: Record<string, unknown>): Record<string, unknown> {
  const selectorFree = { ...args };
  for (const key of ROUTE_SELECTOR_KEYS) {
    delete selectorFree[key];
  }
  return selectorFree;
}

export function buildForwardedCallArgs(args: {
  forwardingClass: ForwardingClass;
  userArgs: Record<string, unknown>;
  verifiedSelectors?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  if (args.forwardingClass === "route_independent") {
    return omitRoutingSelectors(args.userArgs);
  }
  if (args.forwardingClass !== "route_dependent") {
    return { ...args.userArgs };
  }

  return { ...args.userArgs, ...(args.verifiedSelectors ?? {}) };
}

export function buildForwardedUserArgs(args: {
  toolName: string | undefined;
  userArgs: Record<string, unknown>;
}): Record<string, unknown> {
  const forwardedUserArgs: Record<string, unknown> = { ...args.userArgs };

  if (args.toolName === "read_file") {
    delete forwardedUserArgs.bypass_cache;
  }

  if (args.toolName === "apply_edits") {
    forwardedUserArgs.verbose = true;
  }

  return forwardedUserArgs;
}
