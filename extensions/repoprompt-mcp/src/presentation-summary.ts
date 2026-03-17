import { normalizeToolName } from "./tool-names.js";

export interface PresentationSummary {
  primary: string;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function formatRange(startLine: number | undefined, limit: number | undefined): string | undefined {
  if (startLine === undefined) {
    return undefined;
  }

  if (limit === undefined || limit <= 0) {
    return `lines ${startLine}+`;
  }

  if (limit === 1) {
    return `line ${startLine}`;
  }

  return `lines ${startLine}-${startLine + limit - 1}`;
}

function quote(value: string): string {
  return `"${value}"`;
}

function summarizePathList(paths: string[]): string | undefined {
  if (paths.length === 0) {
    return undefined;
  }

  if (paths.length <= 2) {
    return paths.join(", ");
  }

  return `${paths.length} paths`;
}

function summarizeManageWorkspacesCall(callArgs: Record<string, unknown>): string {
  const action = asString(callArgs.action);
  const name = asString(callArgs.name);
  const folderPath = asString(callArgs.folder_path);
  const tab = asString(callArgs.tab);
  const target = name ?? folderPath ?? tab;

  switch (action) {
    case "list":
      return "Workspaces";
    case "create":
      return target ? `Create Workspace • ${target}` : "Create Workspace";
    case "switch":
      return target ? `Switch Workspace • ${target}` : "Switch Workspace";
    case "delete":
      return target ? `Delete Workspace • ${target}` : "Delete Workspace";
    case "add_folder":
      return target ? `Add Folder • ${target}` : "Add Folder";
    case "list_tabs":
      return "Tabs";
    case "select_tab":
      return target ? `Select Tab • ${target}` : "Select Tab";
    case "create_tab":
      return target ? `Create Tab • ${target}` : "Create Tab";
    case "close_tab":
      return target ? `Close Tab • ${target}` : "Close Tab";
    default:
      return action ? `Workspaces • ${action}` : "Workspaces";
  }
}

function summarizeManageWorkspacesResult(callArgs: Record<string, unknown>): string {
  const action = asString(callArgs.action);
  const name = asString(callArgs.name);
  const folderPath = asString(callArgs.folder_path);
  const tab = asString(callArgs.tab);
  const target = name ?? folderPath ?? tab;
  const openInNewWindow = callArgs.open_in_new_window === true;

  switch (action) {
    case "list":
      return "workspaces listed";
    case "create":
      return [target, openInNewWindow ? "new window" : "created"]
        .filter((part): part is string => Boolean(part))
        .join(" • ");
    case "switch":
      return target ?? "workspace switched";
    case "delete":
      return target ?? "workspace deleted";
    case "add_folder":
      return target ?? "folder added";
    case "list_tabs":
      return "tabs listed";
    case "select_tab":
      return target ?? "tab selected";
    case "create_tab":
      return target ?? "tab created";
    case "close_tab":
      return target ?? "tab closed";
    default:
      return action ? `${action} complete` : "workspace action complete";
  }
}

export function summarizeRpCall(args: Record<string, unknown>): string | null {
  if (args.call) {
    const normalizedToolName = normalizeToolName(String(args.call));
    const callArgs = typeof args.args === "object" && args.args !== null
      ? args.args as Record<string, unknown>
      : {};

    switch (normalizedToolName) {
      case "read_file": {
        const path = asString(callArgs.path);
        return path ? `Read File • ${path}` : "Read File";
      }
      case "file_search": {
        const pattern = asString(callArgs.pattern);
        return pattern ? `Search • ${quote(pattern)}` : "Search";
      }
      case "get_file_tree": {
        const path = asString(callArgs.path);
        return path ? `File Tree • ${path}` : "File Tree";
      }
      case "get_code_structure": {
        const paths = asStringArray(callArgs.paths);
        const pathSummary = summarizePathList(paths);
        return pathSummary ? `Code Structure • ${pathSummary}` : "Code Structure";
      }
      case "workspace_context": {
        return "Workspace Context";
      }
      case "manage_workspaces": {
        return summarizeManageWorkspacesCall(callArgs);
      }
      default:
        break;
    }
  }

  if (args.search) {
    return `Tool Search • ${quote(String(args.search))}`;
  }

  if (args.describe) {
    return `Describe • ${String(args.describe)}`;
  }

  if (args.windows) {
    return "Windows";
  }

  if (args.bind && typeof args.bind === "object" && args.bind !== null) {
    const bind = args.bind as Record<string, unknown>;
    const windowId = asNumber(bind.window);
    return windowId !== undefined ? `Bind • W${windowId}` : "Bind";
  }

  if (Object.keys(args).length === 0) {
    return "Status";
  }

  return null;
}

export function summarizeRpResult(details: Record<string, unknown>): PresentationSummary | null {
  const mode = asString(details.mode);

  if (mode === "search") {
    const count = asNumber(details.count) ?? 0;
    return {
      primary: `${count} ${pluralize(count, "tool")} found`,
    };
  }

  if (mode === "describe") {
    const tool = typeof details.tool === "object" && details.tool !== null
      ? details.tool as Record<string, unknown>
      : null;
    const toolName = tool ? asString(tool.name) : undefined;
    return {
      primary: toolName ? `${toolName} • parameters available` : "tool schema loaded",
    };
  }

  if (mode === "windows") {
    const count = asNumber(details.count) ?? 0;
    return {
      primary: `${count} ${pluralize(count, "window")} available`,
    };
  }

  if (mode === "bind") {
    const binding = typeof details.binding === "object" && details.binding !== null
      ? details.binding as Record<string, unknown>
      : null;
    const windowId = binding ? asNumber(binding.windowId) : undefined;
    const workspace = binding ? asString(binding.workspace) : undefined;
    const tabLabel = asString(details.tabLabel);
    return {
      primary: [workspace, tabLabel ? `Tab ${tabLabel}` : undefined, workspace ? undefined : windowId !== undefined ? `W${windowId}` : undefined]
        .filter((part): part is string => Boolean(part))
        .join(" • "),
    };
  }

  if (mode === "status") {
    const status = asString(details.status);
    const toolsCount = asNumber(details.toolsCount);
    const binding = typeof details.binding === "object" && details.binding !== null
      ? details.binding as Record<string, unknown>
      : null;
    const windowId = binding ? asNumber(binding.windowId) : undefined;
    const workspace = binding ? asString(binding.workspace) : undefined;

    return {
      primary: [
        status,
        toolsCount !== undefined ? `${toolsCount} ${pluralize(toolsCount, "tool")}` : undefined,
        windowId !== undefined ? `W${windowId}` : undefined,
        workspace,
      ].filter((part): part is string => Boolean(part)).join(" • "),
    };
  }

  const normalizedToolName = asString(details.tool) ? normalizeToolName(String(details.tool)) : undefined;
  const callArgs = typeof details.args === "object" && details.args !== null
    ? details.args as Record<string, unknown>
    : {};

  switch (normalizedToolName) {
    case "read_file": {
      const path = asString(callArgs.path);
      if (!path) {
        return null;
      }
      const range = formatRange(asNumber(callArgs.start_line), asNumber(callArgs.limit));
      return {
        primary: range ?? "full file",
      };
    }
    case "file_search": {
      const pattern = asString(callArgs.pattern);
      if (!pattern) {
        return null;
      }

      const directPath = asString(callArgs.path);
      const filter = typeof callArgs.filter === "object" && callArgs.filter !== null
        ? callArgs.filter as Record<string, unknown>
        : null;
      const filterPaths = filter ? asStringArray(filter.paths) : [];
      const pathSummary = directPath ?? summarizePathList(filterPaths);

      return {
        primary: pathSummary ? `in ${pathSummary}` : "search complete",
      };
    }
    case "get_file_tree": {
      const maxDepth = asNumber(callArgs.max_depth);
      return {
        primary: maxDepth !== undefined ? `depth ${maxDepth}` : "tree loaded",
      };
    }
    case "get_code_structure": {
      const scope = asString(callArgs.scope);
      return {
        primary: scope ? `scope ${scope}` : "structure loaded",
      };
    }
    case "workspace_context": {
      const include = asStringArray(callArgs.include);
      return {
        primary: include.length > 0 ? include.join(", ") : "context loaded",
      };
    }
    case "manage_workspaces": {
      return {
        primary: summarizeManageWorkspacesResult(callArgs),
      };
    }
    default:
      return null;
  }
}
