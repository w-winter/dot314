import path from "node:path";

import { extractJsonContent, extractTextContent } from "./mcp-json.js";
import type { TargetContract } from "./target-contract.js";
import { resolveToolName } from "./tool-names.js";
import type { McpToolResult, RpToolMeta } from "./types.js";

export const ROUTING_OBSERVATION_TIMEOUT_MS = 10_000;

export interface NormalizedTab {
  readonly contextId: string;
  readonly name: string;
  readonly isActive?: boolean;
  readonly isBound?: boolean;
  readonly selectedFileCount?: number;
}

export type RootObservation =
  | { kind: "observed"; paths: readonly string[] }
  | { kind: "unavailable"; diagnostic: string };

export interface NormalizedWindow {
  readonly id: number;
  readonly workspace: string;
  readonly roots: RootObservation;
  readonly tabs: readonly NormalizedTab[];
}

export type ConnectionBindingObservation =
  | { kind: "bound"; contextId: string }
  | { kind: "window"; windowId: number }
  | { kind: "unbound" };

export interface RoutingInventory {
  readonly windows: readonly NormalizedWindow[];
  readonly connectionBinding: ConnectionBindingObservation;
}

export type InventoryObservation =
  | { kind: "observed"; inventory: RoutingInventory }
  | { kind: "contract_unestablished"; diagnostic: string }
  | { kind: "tool_missing"; toolName: string }
  | { kind: "call_failed"; diagnostic: string }
  | { kind: "malformed"; diagnostic: string };

export interface RoutingInventoryClient {
  readonly tools: readonly RpToolMeta[];
  callTool(
    name: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<McpToolResult>;
}

const inventoryContractProof: unique symbol = Symbol("EstablishedInventoryContract");

export interface EstablishedInventoryContract {
  readonly client: RoutingInventoryClient;
  readonly contract: TargetContract;
  readonly [inventoryContractProof]: true;
}

export type InventoryContractEstablishment =
  | {
      readonly kind: "established";
      readonly token: EstablishedInventoryContract;
      readonly inventory: RoutingInventory;
    }
  | Exclude<InventoryObservation, { readonly kind: "observed" }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "boolean" ? value : null;
}

function parseAbsolutePathArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }

  const paths = value.map((item) => (item as string).trim());
  if (paths.some((item) => !item || !path.isAbsolute(item))) {
    return null;
  }
  return [...new Set(paths)];
}

function parseWorkspaceName(window: Record<string, unknown>, tabs: readonly Record<string, unknown>[]): string {
  const workspace = asRecord(window.workspace);
  const workspaceName = nonEmptyString(workspace?.name);
  if (workspaceName) {
    return workspaceName;
  }

  for (const tab of tabs) {
    const tabWorkspaceName = nonEmptyString(tab.workspace_name);
    if (tabWorkspaceName) {
      return tabWorkspaceName;
    }
  }

  return "";
}

function parseWindow(value: unknown, index: number): { window?: NormalizedWindow; diagnostic?: string } {
  const record = asRecord(value);
  if (!record) {
    return { diagnostic: `windows[${index}] is not an object` };
  }

  const windowId = record.window_id;
  if (!Number.isInteger(windowId) || (windowId as number) < 0) {
    return { diagnostic: `windows[${index}].window_id is not a non-negative integer` };
  }

  if (!Array.isArray(record.tabs)) {
    return { diagnostic: `windows[${index}].tabs is not an array` };
  }

  const rawTabs: Record<string, unknown>[] = [];
  const normalizedTabs: NormalizedTab[] = [];
  const rootPaths: string[] = [];
  const contextIds = new Set<string>();

  for (const [tabIndex, value] of record.tabs.entries()) {
    const tab = asRecord(value);
    if (!tab) {
      return { diagnostic: `windows[${index}].tabs[${tabIndex}] is not an object` };
    }

    const contextId = nonEmptyString(tab.context_id);
    const name = nonEmptyString(tab.name);
    const isActive = optionalBoolean(tab.is_active);
    const isBound = optionalBoolean(tab.is_bound);
    const repoPaths = parseAbsolutePathArray(tab.repo_paths);
    if (!contextId || !name || isActive === null || isBound === null || repoPaths === null) {
      return { diagnostic: `windows[${index}].tabs[${tabIndex}] has an invalid required field` };
    }
    if (contextIds.has(contextId)) {
      return { diagnostic: `windows[${index}] repeats context_id ${contextId}` };
    }

    const selectedFileCount = tab.selected_file_count;
    if (
      selectedFileCount !== undefined
      && (!Number.isInteger(selectedFileCount) || (selectedFileCount as number) < 0)
    ) {
      return { diagnostic: `windows[${index}].tabs[${tabIndex}].selected_file_count is invalid` };
    }

    contextIds.add(contextId);
    rawTabs.push(tab);
    rootPaths.push(...repoPaths);
    normalizedTabs.push({
      contextId,
      name,
      ...(isActive !== undefined ? { isActive } : {}),
      ...(isBound !== undefined ? { isBound } : {}),
      ...(selectedFileCount !== undefined ? { selectedFileCount: selectedFileCount as number } : {}),
    });
  }

  return {
    window: {
      id: windowId as number,
      workspace: parseWorkspaceName(record, rawTabs),
      roots: normalizedTabs.length > 0
        ? { kind: "observed", paths: [...new Set(rootPaths)] }
        : { kind: "unavailable", diagnostic: `Window ${windowId} has no tab carrying repo_paths` },
      tabs: normalizedTabs,
    },
  };
}

function parseConnectionBinding(
  value: unknown,
  boundConnectionBindingKind: TargetContract["boundConnectionBindingKind"]
): {
  binding?: ConnectionBindingObservation;
  diagnostic?: string;
} {
  const binding = asRecord(value);
  if (!binding) {
    return { diagnostic: "binding is not an object" };
  }

  if (binding.binding_kind === boundConnectionBindingKind) {
    const contextId = nonEmptyString(binding.context_id);
    return contextId
      ? { binding: { kind: "bound", contextId } }
      : { diagnostic: `${boundConnectionBindingKind} binding has no context_id` };
  }

  switch (binding.binding_kind) {
    case "unbound":
      return { binding: { kind: "unbound" } };
    case "window":
      return Number.isInteger(binding.window_id) && (binding.window_id as number) >= 0
        ? { binding: { kind: "window", windowId: binding.window_id as number } }
        : { diagnostic: "window binding has no valid window_id" };
    default:
      return { diagnostic: `binding_kind ${JSON.stringify(binding.binding_kind)} is unsupported` };
  }
}

export function parseRoutingInventory(
  value: unknown,
  contract: TargetContract
): InventoryObservation {
  const root = asRecord(value);
  if (!root) {
    return { kind: "malformed", diagnostic: "bind_context result is not an object" };
  }
  if (!Array.isArray(root.windows)) {
    return { kind: "malformed", diagnostic: "bind_context result has no windows array" };
  }

  const windows: NormalizedWindow[] = [];
  const windowIds = new Set<number>();
  const contextIds = new Set<string>();
  for (const [index, value] of root.windows.entries()) {
    const parsed = parseWindow(value, index);
    if (!parsed.window) {
      return { kind: "malformed", diagnostic: parsed.diagnostic ?? `windows[${index}] is malformed` };
    }
    if (windowIds.has(parsed.window.id)) {
      return { kind: "malformed", diagnostic: `window_id ${parsed.window.id} is duplicated` };
    }
    for (const tab of parsed.window.tabs) {
      if (contextIds.has(tab.contextId)) {
        return { kind: "malformed", diagnostic: `context_id ${tab.contextId} appears in multiple windows` };
      }
      contextIds.add(tab.contextId);
    }
    windowIds.add(parsed.window.id);
    windows.push(parsed.window);
  }

  const parsedBinding = parseConnectionBinding(
    root.binding,
    contract.boundConnectionBindingKind
  );
  if (!parsedBinding.binding) {
    return { kind: "malformed", diagnostic: parsedBinding.diagnostic ?? "binding is malformed" };
  }
  if (parsedBinding.binding.kind === "bound" && !contextIds.has(parsedBinding.binding.contextId)) {
    return {
      kind: "malformed",
      diagnostic: `Connection binding context ${parsedBinding.binding.contextId} is absent from the inventory`,
    };
  }
  if (parsedBinding.binding.kind === "window" && !windowIds.has(parsedBinding.binding.windowId)) {
    return {
      kind: "malformed",
      diagnostic: `Connection binding window ${parsedBinding.binding.windowId} is absent from the inventory`,
    };
  }

  return {
    kind: "observed",
    inventory: {
      windows: windows.sort((left, right) => left.id - right.id),
      connectionBinding: parsedBinding.binding,
    },
  };
}

async function callRoutingInventory(
  client: RoutingInventoryClient,
  contract: TargetContract,
  signal?: AbortSignal
): Promise<InventoryObservation> {
  const toolName = resolveToolName([...client.tools], "bind_context");
  if (!toolName) {
    return { kind: "tool_missing", toolName: "bind_context" };
  }

  let result: McpToolResult;
  try {
    result = await client.callTool(
      toolName,
      { ...contract.inventoryArgs() },
      ROUTING_OBSERVATION_TIMEOUT_MS,
      signal
    );
  } catch (error) {
    return {
      kind: "call_failed",
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.isError) {
    const diagnostic = extractTextContent(result.content).trim();
    return {
      kind: "call_failed",
      diagnostic: diagnostic || "bind_context list returned an MCP error",
    };
  }

  const json = extractJsonContent(result.content);
  return json === null
    ? { kind: "malformed", diagnostic: "bind_context list did not return JSON content" }
    : parseRoutingInventory(json, contract);
}

export async function establishInventoryContract(
  client: RoutingInventoryClient,
  contract: TargetContract,
  signal?: AbortSignal
): Promise<InventoryContractEstablishment> {
  const observation = await callRoutingInventory(client, contract, signal);
  if (observation.kind !== "observed") {
    return observation;
  }

  return {
    kind: "established",
    token: { client, contract, [inventoryContractProof]: true },
    inventory: observation.inventory,
  };
}

export async function observeRoutingInventory(
  established: EstablishedInventoryContract | null,
  signal?: AbortSignal
): Promise<InventoryObservation> {
  if (!established) {
    return {
      kind: "contract_unestablished",
      diagnostic: "RepoPrompt routing inventory is unestablished for this connection",
    };
  }

  return callRoutingInventory(established.client, established.contract, signal);
}

export function windowFromInventory(inventory: RoutingInventory, windowId: number): NormalizedWindow | undefined {
  return inventory.windows.find((window) => window.id === windowId);
}

export function tabsForWindow(inventory: RoutingInventory, windowId: number): readonly NormalizedTab[] {
  return windowFromInventory(inventory, windowId)?.tabs ?? [];
}

function parseRootResult(value: unknown): RootObservation {
  const record = asRecord(value);
  if (!record || !Number.isInteger(record.roots_count) || (record.roots_count as number) < 0) {
    return { kind: "unavailable", diagnostic: "get_file_tree roots returned malformed JSON" };
  }
  if (typeof record.tree !== "string") {
    return { kind: "unavailable", diagnostic: "get_file_tree roots result has no tree string" };
  }

  const rootLines = record.tree
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (rootLines.length !== record.roots_count) {
    return {
      kind: "unavailable",
      diagnostic: `get_file_tree reported ${record.roots_count} roots but returned ${rootLines.length} paths`,
    };
  }

  const paths = parseAbsolutePathArray(rootLines);
  return paths === null
    ? { kind: "unavailable", diagnostic: "get_file_tree roots returned a non-absolute path" }
    : { kind: "observed", paths };
}

function toolAdvertisesRootObservation(tool: RpToolMeta): boolean {
  const schema = asRecord(tool.inputSchema);
  const properties = asRecord(schema?.properties);
  const typeProperty = asRecord(properties?.type);
  return schema?.type === "object" && typeProperty?.type === "string"
    && Array.isArray(typeProperty.enum) && typeProperty.enum.includes("roots");
}

export async function observeWindowRoots(
  client: RoutingInventoryClient,
  contract: TargetContract,
  windowId: number,
  signal?: AbortSignal
): Promise<RootObservation> {
  if (contract.evidence.hiddenWindowSelector !== "proven" || contract.evidence.hiddenRawJson !== "proven") {
    return {
      kind: "unavailable",
      diagnostic: contract.evidence.diagnostic
        ?? `${contract.id} has no proof for hidden _windowID root observation`,
    };
  }

  const toolName = resolveToolName([...client.tools], "get_file_tree");
  const tool = client.tools.find((candidate) => candidate.name === toolName);
  if (!toolName || !tool) {
    return { kind: "unavailable", diagnostic: "get_file_tree is not advertised" };
  }
  if (!toolAdvertisesRootObservation(tool)) {
    return { kind: "unavailable", diagnostic: "get_file_tree does not advertise type=roots" };
  }

  let result: McpToolResult;
  try {
    result = await client.callTool(
      toolName,
      { ...contract.rootObservationArgs(windowId) },
      ROUTING_OBSERVATION_TIMEOUT_MS,
      signal
    );
  } catch (error) {
    return {
      kind: "unavailable",
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.isError) {
    const diagnostic = extractTextContent(result.content).trim();
    return { kind: "unavailable", diagnostic: diagnostic || "get_file_tree roots returned an MCP error" };
  }

  const json = extractJsonContent(result.content);
  return json === null
    ? { kind: "unavailable", diagnostic: "get_file_tree roots did not return JSON content" }
    : parseRootResult(json);
}
