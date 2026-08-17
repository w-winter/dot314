import * as path from "node:path";
import { realpathSync } from "node:fs";
import { access } from "node:fs/promises";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getRpClient } from "./client.js";
import { extractTextContent } from "./mcp-json.js";
import {
  establishInventoryContract,
  observeRoutingInventory,
  observeWindowRoots,
  tabsForWindow,
  windowFromInventory,
  type EstablishedInventoryContract,
  type InventoryObservation,
  type NormalizedTab,
  type NormalizedWindow,
  type RoutingInventory,
  type RoutingInventoryClient,
} from "./routing-inventory.js";
import {
  displayIdentityFor,
  persistedIntentFromAutoSelectionEntry,
  persistedIntentFromBindingEntry,
  routeStore,
  type PersistedRouteIntent,
  type QuarantineCause,
  type RouteDispatchIssue,
  type RouteDispatchLease,
  type RouteDisplayIdentity,
  type RoutePublicationResult,
  type RouteState,
  type SelectorDecision,
  type VerifiedRoute,
} from "./route-state.js";
import { targetContractForApp, type TargetContract } from "./target-contract.js";
import { resolveToolName } from "./tool-names.js";
import type {
  BindingEntryData,
  McpToolResult,
  RpAppId,
  RpBinding,
  RpConfig,
  RpTab,
  RpWindow,
} from "./types.js";
import { AUTO_SELECTION_ENTRY_TYPE, BINDING_ENTRY_TYPE } from "./types.js";

let establishedInventoryContract: EstablishedInventoryContract | null = null;

function activeAppFromConfig(config: Pick<RpConfig, "activeApp">): RpAppId {
  return config.activeApp;
}
function displayIdentityToBinding(identity: RouteDisplayIdentity | null): RpBinding | null {
  if (!identity) {
    return null;
  }

  return {
    app: identity.app,
    windowId: identity.windowId,
    ...(identity.tabContextId ? { tab: identity.tabContextId } : {}),
    ...(identity.workspace !== undefined ? { workspace: identity.workspace } : {}),
    ...(identity.autoDetected !== undefined ? { autoDetected: identity.autoDetected } : {}),
  };
}

function verifiedRouteToBinding(
  route: VerifiedRoute | null
): (RpBinding & { readonly tab: string }) | null {
  if (!route) {
    return null;
  }

  return {
    app: route.identity.app,
    windowId: route.identity.windowId,
    tab: route.contextId,
    ...(route.identity.workspace !== undefined ? { workspace: route.identity.workspace } : {}),
    ...(route.identity.autoDetected !== undefined ? { autoDetected: route.identity.autoDetected } : {}),
  };
}

function bindingToVerifiedRoute(binding: RpBinding, tabName?: string): VerifiedRoute {
  if (!binding.tab) {
    throw new Error("A verified route requires a concrete tab");
  }
  const identity = {
    app: binding.app,
    windowId: binding.windowId,
    ...(binding.workspace !== undefined ? { workspace: binding.workspace } : {}),
    ...(binding.autoDetected !== undefined ? { autoDetected: binding.autoDetected } : {}),
  };

  return { kind: "tab", identity, contextId: binding.tab, tabName: tabName ?? binding.tab };
}

function bindingEntryData(binding: RpBinding): BindingEntryData {
  return {
    app: binding.app,
    windowId: binding.windowId,
    ...(binding.tab !== undefined ? { tab: binding.tab } : {}),
    ...(binding.workspace !== undefined ? { workspace: binding.workspace } : {}),
  };
}

export function getBinding(): RpBinding | null {
  return displayIdentityToBinding(displayIdentityFor(routeStore.statusSnapshot()));
}

export function getVerifiedBinding(): (RpBinding & { readonly tab: string }) | null {
  return verifiedRouteToBinding(routeStore.snapshotVerified());
}

export function getRouteState(): RouteState {
  return routeStore.snapshot();
}

export function getRouteStatusSnapshot() {
  return routeStore.statusSnapshot();
}

export function clearBinding(): void {
  routeStore.clear();
}

export function resetBindingStateForTests(): void {
  routeStore.resetForTests();
  establishedInventoryContract = null;
}

export function resetRoutingInventoryContractSession(): void {
  establishedInventoryContract = null;
}

export function getRouteSelectorDecision(args: {
  callerArgs?: Readonly<Record<string, unknown>>;
}): SelectorDecision {
  return routeStore.selectorDecision(args);
}

export function waitForRoutePublication(signal?: AbortSignal): Promise<void> {
  return routeStore.waitForRoutePublication(signal);
}

export function runRouteChange<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return routeStore.runRouteChange(operation, signal);
}

export function issueLeasedRouteDispatch<T>(
  options: {
    callerArgs?: Readonly<Record<string, unknown>>;
  },
  dispatch: (lease: RouteDispatchLease) => T,
  signal?: AbortSignal
): Promise<RouteDispatchIssue<T>> {
  return routeStore.issueDispatch(options, dispatch, signal);
}

export function routeDispatchLeaseBinding(
  lease: RouteDispatchLease
): RpBinding & { readonly tab: string } {
  return {
    app: lease.route.identity.app,
    windowId: lease.route.identity.windowId,
    tab: lease.route.contextId,
    ...(lease.route.identity.workspace !== undefined
      ? { workspace: lease.route.identity.workspace }
      : {}),
    ...(lease.route.identity.autoDetected !== undefined
      ? { autoDetected: lease.route.identity.autoDetected }
      : {}),
  };
}

export function routeDispatchLeaseIsCurrent(lease: RouteDispatchLease): boolean {
  return routeStore.ownsDispatchLease(lease);
}

export function quarantineRoute(
  cause: QuarantineCause,
  diagnostic: string,
  operationClass = "route_dependent"
): void {
  routeStore.quarantine(cause, diagnostic);
  console.warn(
    `[repoprompt-mcp] app=${getBinding()?.app ?? "unknown"} route=quarantined ` +
    `operation_class=${operationClass} cause=${cause}: ${diagnostic}`
  );
}

export function persistBinding(
  pi: ExtensionAPI,
  binding: RpBinding,
  config: RpConfig,
  tabName?: string
): RoutePublicationResult {
  const app = activeAppFromConfig(config);
  const verifiedBinding = { ...binding, app };
  const result = routeStore.publishVerified(
    bindingToVerifiedRoute(verifiedBinding, tabName),
    config.persistBinding === false
      ? undefined
      : () => pi.appendEntry(BINDING_ENTRY_TYPE, bindingEntryData(verifiedBinding))
  );

  if (result.persistence === "degraded") {
    console.warn(`[repoprompt-mcp] app=${app} route=verified persistence=degraded: ${result.diagnostic}`);
  }
  return result;
}

function persistWindowIntent(
  pi: ExtensionAPI,
  window: NormalizedWindow,
  config: RpConfig,
  signal?: AbortSignal
): RpBinding {
  signal?.throwIfAborted();
  const binding: RpBinding = {
    app: activeAppFromConfig(config),
    windowId: window.id,
    ...(window.workspace ? { workspace: window.workspace } : {}),
  };
  const intent: PersistedRouteIntent = {
    app: binding.app,
    windowId: binding.windowId,
    ...(binding.workspace ? { workspace: binding.workspace } : {}),
  };
  const result = routeStore.publishIntent(
    intent,
    config.persistBinding === false
      ? undefined
      : () => pi.appendEntry(BINDING_ENTRY_TYPE, bindingEntryData(binding))
  );
  if (result.persistence === "degraded") {
    console.warn(
      `[repoprompt-mcp] app=${binding.app} route=intent persistence=degraded: ${result.diagnostic}`
    );
  }
  return binding;
}

function findMostRecentBindingIntent(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  app: RpAppId
): PersistedRouteIntent | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== BINDING_ENTRY_TYPE) {
      continue;
    }

    const intent = persistedIntentFromBindingEntry(entry.data, app);
    if (intent) {
      return intent;
    }
  }
  return null;
}

function findMostRecentAutoSelectionIntent(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
  app: RpAppId,
  windowId?: number,
  workspace?: string
): PersistedRouteIntent | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== AUTO_SELECTION_ENTRY_TYPE) {
      continue;
    }

    const intent = persistedIntentFromAutoSelectionEntry(entry.data, app);
    if (!intent || (windowId !== undefined && intent.windowId !== windowId)) {
      continue;
    }
    if (workspace && intent.workspace && intent.workspace !== workspace) {
      continue;
    }
    return intent;
  }
  return null;
}

export function restoreBinding(ctx: ExtensionContext, config: RpConfig): RpBinding | null {
  const app = activeAppFromConfig(config);
  if (config.persistBinding === false) {
    const current = getBinding();
    return current?.app === app ? current : null;
  }

  const entries = ctx.sessionManager.getBranch();
  const bindingIntent = findMostRecentBindingIntent(entries, app);
  const autoSelectionIntent = findMostRecentAutoSelectionIntent(
    entries,
    app,
    bindingIntent?.windowId,
    bindingIntent?.workspace
  );

  const restored = bindingIntent
    ? {
        ...bindingIntent,
        ...(!bindingIntent.tabContextId && autoSelectionIntent?.tabContextId
          ? { tabContextId: autoSelectionIntent.tabContextId }
          : {}),
      }
    : autoSelectionIntent;

  routeStore.restoreIntent(restored);
  return getBinding();
}

function observationDiagnostic(observation: Exclude<InventoryObservation, { kind: "observed" }>): string {
  switch (observation.kind) {
    case "contract_unestablished":
      return observation.diagnostic;
    case "tool_missing":
      return `${observation.toolName} is not advertised by the selected RepoPrompt target`;
    case "call_failed":
    case "malformed":
      return observation.diagnostic;
  }
}

function requireObservedInventory(observation: InventoryObservation): RoutingInventory {
  if (observation.kind !== "observed") {
    throw new Error(`RepoPrompt routing inventory unavailable: ${observationDiagnostic(observation)}`);
  }
  return observation.inventory;
}

export async function establishRoutingInventoryContract(
  config: RpConfig,
  client: RoutingInventoryClient = getRpClient(),
  signal?: AbortSignal
): Promise<RoutingInventory> {
  const contract = targetContractForApp(activeAppFromConfig(config));
  const capabilities = contract.inspectCapabilities(client.tools);
  if (capabilities.kind === "unsupported") {
    throw new Error(
      `Unsupported RepoPrompt ${contract.id} routing contract: ${capabilities.diagnostics.join("; ")}`
    );
  }

  const establishment = await establishInventoryContract(client, contract, signal);
  if (establishment.kind !== "established") {
    throw new Error(
      `RepoPrompt routing inventory unavailable: ${observationDiagnostic(establishment)}`
    );
  }
  establishedInventoryContract = establishment.token;
  return establishment.inventory;
}

async function observeInventoryOutcome(
  config: Pick<RpConfig, "activeApp">,
  client: RoutingInventoryClient = getRpClient(),
  signal?: AbortSignal
): Promise<InventoryObservation> {
  const established = establishedInventoryContract;
  if (!established
    || established.client !== client
    || established.contract.app !== activeAppFromConfig(config)) {
    return await observeRoutingInventory(null, signal);
  }

  return await observeRoutingInventory(established, signal);
}

async function observeInventory(
  config: Pick<RpConfig, "activeApp">,
  client: RoutingInventoryClient = getRpClient(),
  signal?: AbortSignal
): Promise<RoutingInventory> {
  return requireObservedInventory(await observeInventoryOutcome(config, client, signal));
}

export interface RoutingMutationIssuanceGuard {
  validate():
    | { readonly kind: "allowed" }
    | { readonly kind: "blocked"; readonly error: string; readonly diagnostic: string };
}

export class RoutingMutationBlockedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RoutingMutationBlockedError";
  }
}

export type RoutingMutationExecution<T> =
  | { readonly kind: "reconciled"; readonly result: McpToolResult; readonly value: T }
  | { readonly kind: "blocked"; readonly error: string; readonly diagnostic: string }
  | {
      readonly kind: "superseded";
      readonly result: McpToolResult;
      readonly cause: "superseded";
      readonly possiblePartialSuccess: true;
      readonly diagnostic: string;
    }
  | {
      readonly kind: "failed";
      readonly result: McpToolResult;
      readonly cause: "mutation_failed_route_unchanged" | "mutation_failed_route_unproven";
      readonly priorAuthorityPreserved: boolean;
      readonly diagnostic: string;
    }
  | {
      readonly kind: "quarantined";
      readonly result: McpToolResult;
      readonly diagnostic: string;
    };

export interface RoutingMutationExecutorOptions<T> {
  readonly operationLabel: string;
  readonly operationClass: string;
  readonly config: RpConfig;
  readonly client: RoutingInventoryClient;
  readonly signal?: AbortSignal;
  readonly issuanceGuard?: RoutingMutationIssuanceGuard;
  readonly expectedBoundContext?: {
    readonly contextId: string;
  };
  readonly expectedCreatedTab?: {
    readonly windowId: number;
    readonly previousContextIds: ReadonlySet<string>;
  };
  dispatch(): Promise<McpToolResult>;
  reconcile(
    inventory: RoutingInventory,
    result: McpToolResult,
    priorState: RouteState
  ): T;
}

function observedInventoryProvesVerifiedRouteUnchanged(
  inventory: RoutingInventory,
  route: VerifiedRoute
): boolean {
  const live = findInventoryTab(inventory, route.identity.windowId, route.contextId);
  if (!live
    || (route.identity.workspace !== undefined && live.window.workspace !== route.identity.workspace)) {
    return false;
  }

  return inventory.connectionBinding.kind === "bound"
    && inventory.connectionBinding.windowId === route.identity.windowId
    && inventory.connectionBinding.contextId === route.contextId;
}

async function executeRoutingMutationWithinCoordinator<T>(
  options: RoutingMutationExecutorOptions<T>
): Promise<RoutingMutationExecution<T>> {
  const issuance = options.issuanceGuard?.validate();
  if (issuance?.kind === "blocked") {
    return { kind: "blocked", error: issuance.error, diagnostic: issuance.diagnostic };
  }

  const priorState = routeStore.snapshot();
  const priorGeneration = routeStore.snapshotPublicationGeneration();
  let result: McpToolResult;
  try {
    result = await options.dispatch();
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    if (routeStore.ownsPublicationGeneration(priorGeneration)) {
      quarantineRoute(
        "ambiguous_mutation_result",
        `${options.operationLabel} ended without a definitive MCP result: ${diagnostic}`,
        options.operationClass
      );
    }
    throw error;
  }

  let inventory: RoutingInventory;
  try {
    inventory = await observeInventory(
      options.config,
      options.client,
      result.isError ? undefined : options.signal
    );
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    const routeDiagnostic =
      `${options.operationLabel} failed and post-failure route observation failed: ${diagnostic}`;
    if (result.isError) {
      if (routeStore.ownsPublicationGeneration(priorGeneration)
        && priorState.kind !== "intent"
        && priorState.kind !== "quarantined") {
        quarantineRoute("post_mutation_observation_failed", routeDiagnostic, options.operationClass);
      }
      return {
        kind: "failed",
        result,
        cause: "mutation_failed_route_unproven",
        priorAuthorityPreserved: false,
        diagnostic: routeDiagnostic,
      };
    }
    if (routeStore.ownsPublicationGeneration(priorGeneration)) {
      quarantineRoute(
        "post_mutation_observation_failed",
        routeDiagnostic,
        options.operationClass
      );
    }
    return { kind: "quarantined", result, diagnostic: routeDiagnostic };
  }

  if (result.isError) {
    const priorAuthorityPreserved = priorState.kind === "verified"
      && routeStore.ownsPublicationGeneration(priorGeneration)
      && observedInventoryProvesVerifiedRouteUnchanged(inventory, priorState.route);
    const diagnostic = priorAuthorityPreserved
      ? `${options.operationLabel} failed; post-failure observation proved the prior route unchanged`
      : `${options.operationLabel} failed; post-failure observation did not prove the prior route unchanged`;
    if (!priorAuthorityPreserved
      && routeStore.ownsPublicationGeneration(priorGeneration)
      && priorState.kind !== "intent"
      && priorState.kind !== "quarantined") {
      quarantineRoute("route_conflict", diagnostic, options.operationClass);
    }
    return {
      kind: "failed",
      result,
      cause: priorAuthorityPreserved
        ? "mutation_failed_route_unchanged"
        : "mutation_failed_route_unproven",
      priorAuthorityPreserved,
      diagnostic,
    };
  }

  if (!routeStore.ownsPublicationGeneration(priorGeneration)) {
    return {
      kind: "superseded",
      result,
      cause: "superseded",
      possiblePartialSuccess: true,
      diagnostic:
        `${options.operationLabel} completed, but newer routing authority superseded reconciliation`,
    };
  }

  try {
    if (options.expectedBoundContext) {
      requireBoundTab(
        inventory,
        options.expectedBoundContext.contextId
      );
    }
    if (options.expectedCreatedTab) {
      if (inventory.connectionBinding.kind !== "bound"
        || inventory.connectionBinding.windowId !== options.expectedCreatedTab.windowId) {
        throw new Error("RepoPrompt did not report the created tab as connection-bound");
      }
      const created = requireBoundTab(
        inventory,
        inventory.connectionBinding.contextId
      );
      if (options.expectedCreatedTab.previousContextIds.has(created.tab.contextId)) {
        throw new Error("RepoPrompt did not report one new bound tab after create_tab");
      }
    }
    return {
      kind: "reconciled",
      result,
      value: options.reconcile(inventory, result, priorState),
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    const routeDiagnostic =
      `${options.operationLabel} completed, but route reconciliation failed: ${diagnostic}`;
    if (routeStore.ownsPublicationGeneration(priorGeneration)) {
      quarantineRoute(
        "post_mutation_observation_failed",
        routeDiagnostic,
        options.operationClass
      );
    }
    return { kind: "quarantined", result, diagnostic: routeDiagnostic };
  }
}

export function executeRoutingMutation<T>(
  options: RoutingMutationExecutorOptions<T>
): Promise<RoutingMutationExecution<T>> {
  return routeStore.runRouteChange(
    () => executeRoutingMutationWithinCoordinator(options),
    options.signal
  );
}

export type RouteStatusObservation =
  | {
      readonly routeState: "verified_tab";
      readonly window: { readonly id: number; readonly workspace: string };
      readonly tab: {
        readonly contextId: string;
        readonly name: string;
        readonly isActive?: boolean;
        readonly isBound: true;
      };
      readonly persistenceDiagnostic?: string;
    }
  | {
      readonly routeState: "stale";
      readonly diagnostic: string;
      readonly displayIdentity: RouteDisplayIdentity | null;
    }
  | {
      readonly routeState: "intent";
      readonly diagnostic: string;
      readonly displayIdentity: RouteDisplayIdentity;
    }
  | {
      readonly routeState: "quarantined";
      readonly diagnostic: string;
      readonly displayIdentity: RouteDisplayIdentity | null;
    }
  | {
      readonly routeState: "observation_failed";
      readonly diagnostic: string;
      readonly displayIdentity: RouteDisplayIdentity | null;
    }
  | { readonly routeState: "unsupported"; readonly diagnostic: string }
  | { readonly routeState: "unbound"; readonly diagnostic?: string };

function findInventoryTab(
  inventory: RoutingInventory,
  windowId: number,
  contextId: string
): { window: NormalizedWindow; tab: NormalizedTab } | null {
  const window = windowFromInventory(inventory, windowId);
  const tab = window?.tabs.find((candidate) => candidate.contextId === contextId);
  return window && tab ? { window, tab } : null;
}

function intentConflictsWithObservedBinding(
  intent: PersistedRouteIntent,
  inventory: RoutingInventory
): string | null {
  if (inventory.connectionBinding.kind === "unbound") {
    return null;
  }
  if (inventory.connectionBinding.kind === "window") {
    if (intent.tabContextId) {
      return (
        `Restored context ${intent.tabContextId} requires a tab binding, but the connection is bound only to ` +
        `window ${inventory.connectionBinding.windowId}`
      );
    }
    return inventory.connectionBinding.windowId === intent.windowId
      ? null
      : `Restored window ${intent.windowId} conflicts with connection-bound window ${inventory.connectionBinding.windowId}`;
  }

  return intent.tabContextId && intent.tabContextId !== inventory.connectionBinding.contextId
    ? `Restored context ${intent.tabContextId} conflicts with connection-bound context ${inventory.connectionBinding.contextId}`
    : null;
}

export async function observeRouteStatus(
  config: RpConfig,
  client: RoutingInventoryClient = getRpClient(),
  signal?: AbortSignal
): Promise<RouteStatusObservation> {
  const contract = targetContractForApp(activeAppFromConfig(config));
  const capabilities = contract.inspectCapabilities(client.tools);
  if (capabilities.kind === "unsupported") {
    const diagnostic =
      `Unsupported RepoPrompt ${contract.id} routing contract: ${capabilities.diagnostics.join("; ")}`;
    console.warn(
      `[repoprompt-mcp] app=${contract.app} route=unsupported operation_class=routing_observation ` +
      `cause=unsupported_contract: ${diagnostic}`
    );
    return { routeState: "unsupported", diagnostic };
  }

  const routeSnapshot = routeStore.statusSnapshot();
  const state = routeSnapshot.state;
  const displayIdentity = displayIdentityFor(routeSnapshot);
  const observation = await observeInventoryOutcome(config, client, signal);
  if (observation.kind !== "observed") {
    const diagnostic = observationDiagnostic(observation);
    console.warn(
      `[repoprompt-mcp] app=${contract.app} route=observation_failed operation_class=routing_observation ` +
      `cause=${observation.kind}: ${diagnostic}`
    );
    return { routeState: "observation_failed", diagnostic, displayIdentity };
  }

  const inventory = observation.inventory;
  if (state.kind === "quarantined") {
    return {
      routeState: "quarantined",
      diagnostic: state.diagnostic,
      displayIdentity,
    };
  }
  if (state.kind === "unbound") {
    const diagnostic = inventory.connectionBinding.kind === "unbound"
      ? undefined
      : "RepoPrompt reports a live connection binding that this branch has not adopted";
    return { routeState: "unbound", ...(diagnostic ? { diagnostic } : {}) };
  }
  if (state.kind === "intent") {
    const window = windowFromInventory(inventory, state.intent.windowId);
    if (!window) {
      return {
        routeState: "stale",
        diagnostic: `Restored window ${state.intent.windowId} is absent from the observed inventory`,
        displayIdentity,
      };
    }
    if (state.intent.tabContextId
      && !window.tabs.some((tab) => tab.contextId === state.intent.tabContextId)) {
      return {
        routeState: "stale",
        diagnostic: `Restored context ${state.intent.tabContextId} is absent from window ${window.id}`,
        displayIdentity,
      };
    }
    const conflict = intentConflictsWithObservedBinding(state.intent, inventory);
    return {
      routeState: "intent",
      diagnostic: conflict ?? "Restored route intent has not been verified for dispatch",
      displayIdentity: displayIdentity!,
    };
  }

  const persistenceDiagnostic = displayIdentity?.persistenceDiagnostic;
  const storedWindow = windowFromInventory(inventory, state.route.identity.windowId);
  if (!storedWindow) {
    return {
      routeState: "stale",
      diagnostic:
        `Window ${state.route.identity.windowId} for verified context ${state.route.contextId} ` +
        "is absent from the observed inventory",
      displayIdentity,
    };
  }
  const verifiedContextId = state.route.contextId;
  const live = findInventoryTab(inventory, storedWindow.id, verifiedContextId);
  if (!live) {
    return {
      routeState: "stale",
      diagnostic: `Verified context ${state.route.contextId} is absent from window ${storedWindow.id}`,
      displayIdentity,
    };
  }
  if (state.route.identity.workspace !== undefined
    && live.window.workspace !== state.route.identity.workspace) {
    return {
      routeState: "stale",
      diagnostic:
        `Verified context ${state.route.contextId} window ${storedWindow.id} changed workspace from ` +
        `${state.route.identity.workspace} to ${live.window.workspace}`,
      displayIdentity,
    };
  }
  if (inventory.connectionBinding.kind !== "bound"
    || inventory.connectionBinding.windowId !== state.route.identity.windowId
    || inventory.connectionBinding.contextId !== state.route.contextId) {
    const observedBinding = inventory.connectionBinding.kind === "bound"
      ? `context ${inventory.connectionBinding.contextId} in window ${inventory.connectionBinding.windowId}`
      : inventory.connectionBinding.kind === "window"
        ? `window-only binding ${inventory.connectionBinding.windowId}`
        : "an unbound connection";
    return {
      routeState: "stale",
      diagnostic:
        `Verified context ${state.route.contextId} in window ${state.route.identity.windowId} ` +
        `does not match ${observedBinding}`,
      displayIdentity,
    };
  }
  return {
    routeState: "verified_tab",
    window: { id: storedWindow.id, workspace: live.window.workspace },
    tab: {
      contextId: live.tab.contextId,
      name: live.tab.name,
      ...(live.tab.isActive !== undefined ? { isActive: live.tab.isActive } : {}),
      isBound: true,
    },
    ...(persistenceDiagnostic ? { persistenceDiagnostic } : {}),
  };
}

function normalizedTabToRpTab(tab: NormalizedTab): RpTab {
  return {
    id: tab.contextId,
    name: tab.name,
    ...(tab.isActive !== undefined ? { isActive: tab.isActive } : {}),
    ...(tab.isBound !== undefined ? { isBound: tab.isBound } : {}),
    ...(tab.selectedFileCount !== undefined ? { selectedFileCount: tab.selectedFileCount } : {}),
  };
}

async function normalizedWindowToRpWindow(
  window: NormalizedWindow,
  client: RoutingInventoryClient,
  contract: TargetContract,
  signal?: AbortSignal
): Promise<RpWindow> {
  const roots = window.roots.kind === "observed"
    ? window.roots
    : await observeWindowRoots(client, contract, window.id, signal);
  return {
    id: window.id,
    workspace: window.workspace,
    roots: roots.kind === "observed" ? [...roots.paths] : [],
    ...(roots.kind === "unavailable" ? { rootsUnavailableDiagnostic: roots.diagnostic } : {}),
  };
}

async function windowsFromInventory(
  inventory: RoutingInventory,
  config: Pick<RpConfig, "activeApp">,
  client: RoutingInventoryClient,
  signal?: AbortSignal
): Promise<RpWindow[]> {
  const contract = targetContractForApp(activeAppFromConfig(config));
  return await Promise.all(
    inventory.windows.map((window) => normalizedWindowToRpWindow(window, client, contract, signal))
  );
}

export async function fetchWindows(
  _pi: ExtensionAPI | undefined,
  config: Pick<RpConfig, "activeApp">,
  client: RoutingInventoryClient = getRpClient(),
  signal?: AbortSignal
): Promise<RpWindow[]> {
  const typedClient = client as ReturnType<typeof getRpClient>;
  if ("isConnected" in typedClient && !typedClient.isConnected) {
    throw new Error("Not connected to RepoPrompt");
  }

  const inventory = await observeInventory(config, client, signal);
  return await windowsFromInventory(inventory, config, client, signal);
}

export async function fetchWindowRoots(
  windowId: number,
  config: Pick<RpConfig, "activeApp">,
  client: RoutingInventoryClient = getRpClient(),
  signal?: AbortSignal
): Promise<string[]> {
  const inventory = await observeInventory(config, client, signal);
  const window = windowFromInventory(inventory, windowId);
  if (!window) {
    throw new Error(`RepoPrompt window ${windowId} not found`);
  }
  if (window.roots.kind === "observed") {
    return [...window.roots.paths];
  }

  const roots = await observeWindowRoots(
    client,
    targetContractForApp(activeAppFromConfig(config)),
    windowId,
    signal
  );
  if (roots.kind === "unavailable") {
    throw new Error(`RepoPrompt roots unavailable for window ${windowId}: ${roots.diagnostic}`);
  }
  return [...roots.paths];
}

export async function fetchWindowTabs(
  windowId: number,
  client: RoutingInventoryClient,
  config: RpConfig,
  signal?: AbortSignal
): Promise<RpTab[]> {
  const typedClient = client as ReturnType<typeof getRpClient>;
  if ("isConnected" in typedClient && !typedClient.isConnected) {
    throw new Error("Not connected to RepoPrompt");
  }

  const inventory = await observeInventory(config, client, signal);
  if (!windowFromInventory(inventory, windowId)) {
    throw new Error(`RepoPrompt window ${windowId} not found`);
  }
  return tabsForWindow(inventory, windowId).map(normalizedTabToRpTab);
}

function canonicalizePathForMatching(inputPath: string): string {
  const resolvedPath = path.resolve(inputPath);
  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const candidate = canonicalizePathForMatching(candidatePath);
  const root = canonicalizePathForMatching(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function parseSelectionRootPath(rawPath: string): { rootHint: string; relPath: string } | null {
  const colonIndex = rawPath.indexOf(":");
  if (colonIndex > 0) {
    const rootHint = rawPath.slice(0, colonIndex).trim();
    const relPath = rawPath.slice(colonIndex + 1).replace(/^\/+/, "");
    if (rootHint && relPath) {
      return { rootHint, relPath };
    }
  }

  const parts = rawPath.split(/[\\/]+/).filter(Boolean);
  return parts.length >= 2
    ? { rootHint: parts[0], relPath: parts.slice(1).join("/") }
    : null;
}

async function windowContainsSelectionPath(window: RpWindow, selectionPath: string, cwd: string): Promise<boolean> {
  const normalizedPath = selectionPath.trim();
  if (!normalizedPath) {
    return false;
  }
  if (path.isAbsolute(normalizedPath)) {
    return window.roots.some((root) => isPathWithinRoot(normalizedPath, root));
  }

  const rootScoped = parseSelectionRootPath(normalizedPath);
  if (rootScoped) {
    for (const root of window.roots.filter((candidate) => path.basename(candidate) === rootScoped.rootHint)) {
      if (await pathExists(path.join(root, rootScoped.relPath))) {
        return true;
      }
    }
  }

  const cwdRelativePath = path.resolve(cwd, normalizedPath);
  if (await pathExists(cwdRelativePath)
    && window.roots.some((root) => isPathWithinRoot(cwdRelativePath, root))) {
    return true;
  }

  for (const root of window.roots) {
    if (await pathExists(path.join(root, normalizedPath))) {
      return true;
    }
  }
  return false;
}

export interface FindRecoveryWindowBySelectionPathsResult {
  window: RpWindow | null;
  ambiguous: boolean;
  matches: RpWindow[];
}

export async function findRecoveryWindowBySelectionPaths(
  windows: RpWindow[],
  selectionPaths: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<FindRecoveryWindowBySelectionPathsResult> {
  signal?.throwIfAborted();
  const requiredPaths = [...new Set(selectionPaths.map((item) => item.trim()).filter(Boolean))];
  if (requiredPaths.length === 0) {
    return { window: null, ambiguous: false, matches: [] };
  }

  const matches: RpWindow[] = [];
  for (const window of windows) {
    const compatibility = await Promise.all(
      requiredPaths.map((selectionPath) => windowContainsSelectionPath(window, selectionPath, cwd))
    );
    signal?.throwIfAborted();
    if (compatibility.every(Boolean)) {
      matches.push(window);
    }
  }

  if (matches.length === 1) {
    return { window: matches[0], ambiguous: false, matches };
  }
  if (matches.length > 1) {
    const cwdMatch = findMatchingWindow(matches, cwd);
    return cwdMatch.window && !cwdMatch.ambiguous
      ? { window: cwdMatch.window, ambiguous: false, matches }
      : { window: null, ambiguous: true, matches };
  }

  const unavailable = windows.filter((window) => window.rootsUnavailableDiagnostic);
  if (unavailable.length > 0) {
    throw new Error(
      `RepoPrompt roots unavailable for windows ${unavailable.map((window) => window.id).join(", ")}`
    );
  }
  return { window: null, ambiguous: false, matches: [] };
}

export interface WindowMatch {
  window: RpWindow;
  root: string;
  rootDepth: number;
}

export interface FindMatchingWindowResult {
  window: RpWindow | null;
  root: string | null;
  ambiguous: boolean;
  matches: WindowMatch[];
  rootsUnavailableWindowIds?: number[];
}

export function findMatchingWindow(windows: RpWindow[], cwd: string): FindMatchingWindowResult {
  const canonicalCwd = canonicalizePathForMatching(cwd);
  const cwdDepth = canonicalCwd.split(path.sep).filter(Boolean).length;
  const matches: WindowMatch[] = [];

  for (const window of windows) {
    let bestRoot: string | null = null;
    let bestRootDepth = -1;
    for (const root of window.roots) {
      if (!isPathWithinRoot(cwd, root)) {
        continue;
      }
      const rootDepth = canonicalizePathForMatching(root).split(path.sep).filter(Boolean).length;
      if (rootDepth > bestRootDepth && rootDepth <= cwdDepth) {
        bestRoot = root;
        bestRootDepth = rootDepth;
      }
    }
    if (bestRoot) {
      matches.push({ window, root: bestRoot, rootDepth: bestRootDepth });
    }
  }

  if (matches.length === 0) {
    const rootsUnavailableWindowIds = windows
      .filter((window) => window.rootsUnavailableDiagnostic)
      .map((window) => window.id);
    return {
      window: null,
      root: null,
      ambiguous: false,
      matches: [],
      ...(rootsUnavailableWindowIds.length > 0 ? { rootsUnavailableWindowIds } : {}),
    };
  }

  matches.sort((left, right) => right.rootDepth - left.rootDepth);
  const best = matches[0];
  const tied = matches.filter((match) => match.rootDepth === best.rootDepth);
  return tied.length > 1
    ? { window: null, root: null, ambiguous: true, matches }
    : { window: best.window, root: best.root, ambiguous: false, matches };
}

function findLiveTab(tabs: readonly NormalizedTab[], reference: string | undefined): NormalizedTab | null {
  return reference
    ? tabs.find((tab) => tab.contextId === reference || tab.name === reference) ?? null
    : null;
}

function orderReusableTabCandidates(tabs: readonly NormalizedTab[]): NormalizedTab[] {
  const ordered = [
    ...tabs.filter((tab) => tab.isBound === true),
    ...tabs.filter((tab) => tab.isBound !== true && tab.isActive === true),
    ...tabs.filter((tab) => tab.isBound !== true && tab.isActive !== true),
  ];
  return ordered.filter(
    (tab, index) => ordered.findIndex((candidate) => candidate.contextId === tab.contextId) === index
  );
}

function parseOracleSessionTabPrefixes(text: string): Set<string> {
  const prefixes = new Set<string>();
  for (const match of text.matchAll(/\btab=([A-F0-9-]{6,})(?:…|\b)/gi)) {
    prefixes.add(match[1].trim().toUpperCase());
  }
  return prefixes;
}

async function fetchOracleSessionTabPrefixes(
  windowId: number,
  client: RoutingInventoryClient,
  signal?: AbortSignal
): Promise<Set<string> | null> {
  const oracleUtilsToolName = resolveToolName([...client.tools], "oracle_utils");
  if (!oracleUtilsToolName) {
    return null;
  }
  const result = await client.callTool(oracleUtilsToolName, {
    op: "sessions",
    limit: 200,
    _windowID: windowId,
  }, undefined, signal);
  return result.isError ? null : parseOracleSessionTabPrefixes(extractTextContent(result.content));
}

async function hasEmptySelection(
  windowId: number,
  tab: NormalizedTab,
  client: RoutingInventoryClient,
  signal?: AbortSignal
): Promise<boolean> {
  signal?.throwIfAborted();
  if (tab.selectedFileCount !== undefined) {
    return tab.selectedFileCount === 0;
  }
  const manageSelectionToolName = resolveToolName([...client.tools], "manage_selection");
  if (!manageSelectionToolName) {
    return false;
  }
  const result = await client.callTool(manageSelectionToolName, {
    op: "get",
    view: "summary",
    _windowID: windowId,
    context_id: tab.contextId,
  }, undefined, signal);
  return !result.isError && /\b0 total tokens\b/i.test(extractTextContent(result.content));
}

async function findReusableSafeTab(
  windowId: number,
  tabs: readonly NormalizedTab[],
  client: RoutingInventoryClient,
  signal?: AbortSignal
): Promise<NormalizedTab | null> {
  const sessionPrefixes = await fetchOracleSessionTabPrefixes(windowId, client, signal);
  for (const tab of orderReusableTabCandidates(tabs)) {
    signal?.throwIfAborted();
    const normalizedContextId = tab.contextId.toUpperCase();
    if ([...(sessionPrefixes ?? [])].some((prefix) => normalizedContextId.startsWith(prefix))) {
      continue;
    }
    if (await hasEmptySelection(windowId, tab, client, signal)) {
      return tab;
    }
  }
  return null;
}

function requireBoundTab(
  inventory: RoutingInventory,
  expectedContextId: string
): { window: NormalizedWindow; tab: NormalizedTab } {
  if (inventory.connectionBinding.kind !== "bound"
    || inventory.connectionBinding.contextId !== expectedContextId) {
    throw new Error(`RepoPrompt connection did not confirm bound context ${expectedContextId}`);
  }

  const bound = findInventoryTab(
    inventory,
    inventory.connectionBinding.windowId,
    inventory.connectionBinding.contextId
  );
  if (!bound) {
    throw new Error(
      `RepoPrompt context ${expectedContextId} is absent from observed window ` +
      `${inventory.connectionBinding.windowId}`
    );
  }
  return bound;
}

async function selectTab(
  pi: ExtensionAPI,
  windowId: number,
  tabId: string,
  config: RpConfig,
  client: RoutingInventoryClient,
  signal?: AbortSignal,
  autoDetected = false,
  issuanceGuard?: RoutingMutationIssuanceGuard
): Promise<RpBinding> {
  const toolName = resolveToolName([...client.tools], "bind_context");
  if (!toolName) {
    throw new Error("RepoPrompt bind_context tool not available");
  }
  const contract = targetContractForApp(activeAppFromConfig(config));
  const execution = await executeRoutingMutationWithinCoordinator({
    operationLabel: `bind_context bind for context ${tabId}`,
    operationClass: "routing_mutation",
    config,
    client,
    signal,
    issuanceGuard,
    expectedBoundContext: { contextId: tabId },
    dispatch: () => client.callTool(
      toolName,
      { ...contract.bindArgs(tabId, windowId) },
      undefined,
      signal
    ),
    reconcile: (inventory) => {
      const confirmed = requireBoundTab(inventory, tabId);
      return publishVerifiedTab(
        pi,
        config,
        confirmed.window,
        confirmed.tab,
        autoDetected,
        signal
      );
    },
  });
  if (execution.kind === "blocked") {
    throw new RoutingMutationBlockedError(execution.error, execution.diagnostic);
  }
  if (execution.kind === "superseded" || execution.kind === "quarantined") {
    throw new Error(execution.diagnostic);
  }
  if (execution.kind === "failed") {
    throw new Error(
      extractTextContent(execution.result.content) || `Failed to bind RepoPrompt tab ${tabId}`
    );
  }
  if (!execution.value) {
    throw new Error(`RepoPrompt bind for context ${tabId} produced no verified route`);
  }
  return execution.value;
}

function publishVerifiedTab(
  pi: ExtensionAPI,
  config: RpConfig,
  window: NormalizedWindow,
  tab: NormalizedTab,
  autoDetected = false,
  signal?: AbortSignal
): RpBinding {
  signal?.throwIfAborted();
  const binding: RpBinding = {
    app: activeAppFromConfig(config),
    windowId: window.id,
    tab: tab.contextId,
    ...(window.workspace ? { workspace: window.workspace } : {}),
    autoDetected,
  };
  persistBinding(pi, binding, config, tab.name);
  return binding;
}

export async function bindToTab(
  pi: ExtensionAPI,
  windowId: number,
  tabReference: string,
  config: RpConfig,
  client: RoutingInventoryClient = getRpClient(),
  signal?: AbortSignal,
  issuanceGuard?: RoutingMutationIssuanceGuard
): Promise<RpBinding> {
  return await runRouteChange(async () => {
    let inventory = await observeInventory(config, client, signal);
    const window = windowFromInventory(inventory, windowId);
    if (!window) {
      throw new Error(`RepoPrompt window ${windowId} not found`);
    }
    const tab = findLiveTab(window.tabs, tabReference);
    if (!tab) {
      throw new Error(`RepoPrompt tab ${JSON.stringify(tabReference)} not found in window ${windowId}`);
    }

    if (inventory.connectionBinding.kind !== "bound"
      || inventory.connectionBinding.contextId !== tab.contextId) {
      return await selectTab(
        pi,
        windowId,
        tab.contextId,
        config,
        client,
        signal,
        false,
        issuanceGuard
      );
    }
    const confirmed = requireBoundTab(inventory, tab.contextId);
    return publishVerifiedTab(pi, config, confirmed.window, confirmed.tab, false, signal);
  }, signal);
}

async function createBoundTab(
  pi: ExtensionAPI,
  windowId: number,
  config: RpConfig,
  client: RoutingInventoryClient,
  signal?: AbortSignal,
  autoDetected = false,
  issuanceGuard?: RoutingMutationIssuanceGuard
): Promise<RpBinding> {
  const before = await observeInventory(config, client, signal);
  const windowBefore = windowFromInventory(before, windowId);
  if (!windowBefore) {
    throw new Error(`RepoPrompt window ${windowId} not found`);
  }

  const toolName = resolveToolName([...client.tools], "manage_workspaces");
  if (!toolName) {
    throw new Error("RepoPrompt manage_workspaces tool not available");
  }
  const previousIds = new Set(windowBefore.tabs.map((tab) => tab.contextId));
  const execution = await executeRoutingMutationWithinCoordinator({
    operationLabel: `manage_workspaces create_tab in window ${windowId}`,
    operationClass: "workspace_routing_mutation",
    config,
    client,
    signal,
    issuanceGuard,
    expectedCreatedTab: { windowId, previousContextIds: previousIds },
    dispatch: () => client.callTool(toolName, {
      action: "create_tab",
      window_id: windowId,
      bind: true,
      focus: false,
    }, undefined, signal),
    reconcile: (inventory) => {
      if (inventory.connectionBinding.kind !== "bound") {
        throw new Error("RepoPrompt did not report the created tab as connection-bound");
      }
      const confirmed = requireBoundTab(
        inventory,
        inventory.connectionBinding.contextId
      );
      return publishVerifiedTab(
        pi,
        config,
        confirmed.window,
        confirmed.tab,
        autoDetected,
        signal
      );
    },
  });
  if (execution.kind === "blocked") {
    throw new RoutingMutationBlockedError(execution.error, execution.diagnostic);
  }
  if (execution.kind === "superseded" || execution.kind === "quarantined") {
    throw new Error(execution.diagnostic);
  }
  if (execution.kind === "failed") {
    throw new Error(extractTextContent(execution.result.content) || "Failed to create RepoPrompt tab");
  }
  if (!execution.value) {
    throw new Error("RepoPrompt create_tab produced no verified route");
  }
  return execution.value;
}

export async function createAndBindTab(
  pi: ExtensionAPI,
  windowId: number,
  config: RpConfig,
  client: RoutingInventoryClient = getRpClient(),
  signal?: AbortSignal,
  issuanceGuard?: RoutingMutationIssuanceGuard
): Promise<RpBinding> {
  return await runRouteChange(
    () => createBoundTab(pi, windowId, config, client, signal, false, issuanceGuard),
    signal
  );
}

function mostRecentHistoricalIntentForWindow(
  ctx: ExtensionContext,
  app: RpAppId,
  windowId: number,
  workspace?: string
): PersistedRouteIntent | null {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== BINDING_ENTRY_TYPE) {
      continue;
    }
    const intent = persistedIntentFromBindingEntry(entry.data, app);
    if (!intent || intent.windowId !== windowId || !intent.tabContextId) {
      continue;
    }
    if (workspace && intent.workspace && intent.workspace !== workspace) {
      continue;
    }
    return intent;
  }
  return findMostRecentAutoSelectionIntent(entries, app, windowId, workspace);
}

export async function ensureBindingHasTab(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: RpConfig,
  client: RoutingInventoryClient = getRpClient(),
  options: { createIfMissing?: boolean; recoverIfMissing?: boolean; reuseSoleEmptyTab?: boolean } = {},
  signal?: AbortSignal,
  issuanceGuard?: RoutingMutationIssuanceGuard
): Promise<RpBinding | null> {
  return await runRouteChange(async () => {
    const issuance = issuanceGuard?.validate();
    if (issuance?.kind === "blocked") {
      throw new RoutingMutationBlockedError(issuance.error, issuance.diagnostic);
    }

    const identity = displayIdentityFor(routeStore.statusSnapshot());
    if (!identity) {
      return null;
    }

    let inventory = await observeInventory(config, client, signal);
    const window = windowFromInventory(inventory, identity.windowId);
    if (!window) {
      routeStore.quarantine("route_disappeared", `RepoPrompt window ${identity.windowId} is absent`);
      throw new Error(`RepoPrompt window ${identity.windowId} not found`);
    }

    const requestedTab = findLiveTab(window.tabs, identity.tabContextId);
    if (requestedTab) {
      if (inventory.connectionBinding.kind !== "bound"
        || inventory.connectionBinding.contextId !== requestedTab.contextId) {
        return await selectTab(
          pi,
          window.id,
          requestedTab.contextId,
          config,
          client,
          signal,
          identity.autoDetected,
          issuanceGuard
        );
      }
      const confirmed = requireBoundTab(inventory, requestedTab.contextId);
      return publishVerifiedTab(
        pi,
        config,
        confirmed.window,
        confirmed.tab,
        identity.autoDetected,
        signal
      );
    }

    const historicalIntent = mostRecentHistoricalIntentForWindow(
      ctx,
      identity.app,
      window.id,
      identity.workspace
    );
    const historicalTab = findLiveTab(window.tabs, historicalIntent?.tabContextId);
    if (historicalTab) {
      return await selectTab(
        pi,
        window.id,
        historicalTab.contextId,
        config,
        client,
        signal,
        identity.autoDetected,
        issuanceGuard
      );
    }

    const shouldFindReusable = options.reuseSoleEmptyTab === true
      || options.recoverIfMissing === true;
    if (shouldFindReusable) {
      const reusable = await findReusableSafeTab(window.id, window.tabs, client, signal);
      if (reusable) {
        return await selectTab(
          pi,
          window.id,
          reusable.contextId,
          config,
          client,
          signal,
          identity.autoDetected,
          issuanceGuard
        );
      }
    }

    const createIfMissing = options.createIfMissing !== false;
    if (!createIfMissing && !(options.recoverIfMissing === true && identity.tabContextId)) {
      return getVerifiedBinding();
    }

    return await createBoundTab(
      pi,
      window.id,
      config,
      client,
      signal,
      identity.autoDetected,
      issuanceGuard
    );
  }, signal);
}

export type AutoDetectAndBindResult =
  | {
      readonly kind: "completed";
      readonly binding: RpBinding;
      readonly windows: RpWindow[];
      readonly publicationGeneration: number;
    }
  | {
      readonly kind: "completed";
      readonly binding: null;
      readonly windows: RpWindow[];
      readonly ambiguity?: { readonly candidates: RpWindow[] };
      readonly rootsUnavailableWindowIds?: number[];
    }
  | {
      readonly kind: "superseded";
      readonly binding: null;
      readonly windows: RpWindow[];
    };

export async function autoDetectAndBind(
  pi: ExtensionAPI,
  config: RpConfig,
  signal?: AbortSignal,
  client: RoutingInventoryClient = getRpClient(),
  expectedPublicationGeneration?: number
): Promise<AutoDetectAndBindResult> {
  const inventory = await observeInventory(config, client, signal);
  const windows = await windowsFromInventory(inventory, config, client, signal);
  if (windows.length === 0) {
    return { kind: "completed", binding: null, windows: [] };
  }

  const match = findMatchingWindow(windows, process.cwd());
  if (match.ambiguous) {
    const bestRootDepth = match.matches[0]?.rootDepth;
    return {
      kind: "completed",
      binding: null,
      windows,
      ambiguity: {
        candidates: match.matches
          .filter((candidate) => candidate.rootDepth === bestRootDepth)
          .map((candidate) => candidate.window),
      },
    };
  }
  if (!match.window) {
    return {
      kind: "completed",
      binding: null,
      windows,
      ...(match.rootsUnavailableWindowIds
        ? { rootsUnavailableWindowIds: match.rootsUnavailableWindowIds }
        : {}),
    };
  }

  if (inventory.connectionBinding.kind === "bound") {
    if (expectedPublicationGeneration !== undefined
      && !routeStore.ownsPublicationGeneration(expectedPublicationGeneration)) {
      return { kind: "superseded", binding: null, windows };
    }
    const confirmed = requireBoundTab(
      inventory,
      inventory.connectionBinding.contextId
    );
    const binding = publishVerifiedTab(pi, config, confirmed.window, confirmed.tab, true, signal);
    return {
      kind: "completed",
      binding,
      windows,
      publicationGeneration: routeStore.snapshotPublicationGeneration(),
    };
  }
  if (inventory.connectionBinding.kind === "window"
    && inventory.connectionBinding.windowId !== match.window.id) {
    throw new Error(
      `Auto-detected window ${match.window.id} conflicts with connection-bound window ` +
      `${inventory.connectionBinding.windowId}`
    );
  }

  const binding: RpBinding = {
    app: activeAppFromConfig(config),
    windowId: match.window.id,
    ...(match.window.workspace ? { workspace: match.window.workspace } : {}),
    autoDetected: true,
  };
  signal?.throwIfAborted();
  if (expectedPublicationGeneration !== undefined
    && !routeStore.ownsPublicationGeneration(expectedPublicationGeneration)) {
    return { kind: "superseded", binding: null, windows };
  }
  routeStore.restoreIntent({
    app: binding.app,
    windowId: binding.windowId,
    ...(binding.workspace ? { workspace: binding.workspace } : {}),
    autoDetected: true,
  });
  return {
    kind: "completed",
    binding,
    windows,
    publicationGeneration: routeStore.snapshotPublicationGeneration(),
  };
}

export async function bindToWindow(
  pi: ExtensionAPI,
  windowId: number,
  tab: string | undefined,
  config: RpConfig,
  client: RoutingInventoryClient = getRpClient(),
  signal?: AbortSignal,
  ctx?: ExtensionContext,
  issuanceGuard?: RoutingMutationIssuanceGuard
): Promise<RpBinding> {
  if (tab) {
    return await bindToTab(pi, windowId, tab, config, client, signal, issuanceGuard);
  }

  return await runRouteChange(async () => {
    const inventory = await observeInventory(config, client, signal);
    const window = windowFromInventory(inventory, windowId);
    if (!window) {
      throw new Error(`RepoPrompt window ${windowId} not found`);
    }

    const historicalIntent = ctx
      ? mostRecentHistoricalIntentForWindow(
          ctx,
          activeAppFromConfig(config),
          window.id,
          window.workspace
        )
      : null;
    const historicalTab = findLiveTab(window.tabs, historicalIntent?.tabContextId);
    const selectedTab = historicalTab
      ?? await findReusableSafeTab(window.id, window.tabs, client, signal);

    if (selectedTab) {
      if (inventory.connectionBinding.kind === "bound"
        && inventory.connectionBinding.contextId === selectedTab.contextId) {
        const confirmed = requireBoundTab(inventory, selectedTab.contextId);
        return publishVerifiedTab(pi, config, confirmed.window, confirmed.tab, false, signal);
      }
      return await selectTab(
        pi,
        window.id,
        selectedTab.contextId,
        config,
        client,
        signal,
        false,
        issuanceGuard
      );
    }

    return await createBoundTab(pi, window.id, config, client, signal, false, issuanceGuard);
  }, signal);
}

export function reconcileObservedInventoryRoute(
  pi: ExtensionAPI,
  config: RpConfig,
  inventory: RoutingInventory,
  signal?: AbortSignal
): RpBinding | null {
  signal?.throwIfAborted();
  if (inventory.connectionBinding.kind === "unbound") {
    routeStore.clear();
    return null;
  }
  if (inventory.connectionBinding.kind === "window") {
    const window = windowFromInventory(inventory, inventory.connectionBinding.windowId);
    if (!window) {
      throw new Error(`Bound window ${inventory.connectionBinding.windowId} is absent from inventory`);
    }
    return persistWindowIntent(pi, window, config, signal);
  }

  const confirmed = requireBoundTab(
    inventory,
    inventory.connectionBinding.contextId
  );
  return publishVerifiedTab(pi, config, confirmed.window, confirmed.tab, false, signal);
}

export type StickyRouteAdoptionResult =
  | { readonly kind: "adopted"; readonly binding: RpBinding }
  | { readonly kind: "intent"; readonly binding: RpBinding; readonly diagnostic: string }
  | { readonly kind: "conflict"; readonly diagnostic: string }
  | { readonly kind: "unbound" };

export async function adoptObservedStickyRoute(
  pi: ExtensionAPI,
  config: RpConfig,
  client: RoutingInventoryClient = getRpClient(),
  signal?: AbortSignal
): Promise<StickyRouteAdoptionResult> {
  return await runRouteChange(async () => {
    const inventory = await observeInventory(config, client, signal);
    if (inventory.connectionBinding.kind === "unbound") {
      return { kind: "unbound" };
    }

    const state = routeStore.snapshot();
    if (state.kind === "intent") {
      const conflict = intentConflictsWithObservedBinding(state.intent, inventory);
      if (conflict) {
        return { kind: "conflict", diagnostic: conflict };
      }
    }

    if (inventory.connectionBinding.kind === "window") {
      const window = windowFromInventory(inventory, inventory.connectionBinding.windowId);
      if (!window) {
        throw new Error(`Bound window ${inventory.connectionBinding.windowId} is absent from inventory`);
      }
      const binding: RpBinding = {
        app: activeAppFromConfig(config),
        windowId: window.id,
        ...(window.workspace ? { workspace: window.workspace } : {}),
      };
      signal?.throwIfAborted();
      routeStore.restoreIntent({
        app: binding.app,
        windowId: binding.windowId,
        ...(binding.workspace ? { workspace: binding.workspace } : {}),
      });
      return {
        kind: "intent",
        binding,
        diagnostic: `RepoPrompt is bound only to window ${window.id}; bind a concrete tab for dispatch`,
      };
    }

    const binding = reconcileObservedInventoryRoute(pi, config, inventory, signal);
    if (!binding) {
      return { kind: "unbound" };
    }
    return { kind: "adopted", binding };
  }, signal);
}

export async function reconcileFailedRouteDependentCall(
  priorBinding: RpBinding & { readonly tab: string },
  config: RpConfig,
  client: RoutingInventoryClient = getRpClient(),
  signal?: AbortSignal,
  lease?: RouteDispatchLease
): Promise<void> {
  const quarantineIfOwned = (cause: QuarantineCause, diagnostic: string): void => {
    if (!lease || routeStore.ownsDispatchLease(lease)) {
      quarantineRoute(cause, diagnostic);
    }
  };
  if (lease && !routeStore.ownsDispatchLease(lease)) {
    return;
  }

  try {
    const inventory = await observeInventory(config, client, signal);
    const live = findInventoryTab(inventory, priorBinding.windowId, priorBinding.tab);
    if (!live) {
      quarantineIfOwned(
        "route_disappeared",
        `Verified context ${priorBinding.tab} disappeared after a failed route-dependent call`
      );
      return;
    }
    if (inventory.connectionBinding.kind !== "bound"
      || inventory.connectionBinding.windowId !== priorBinding.windowId
      || inventory.connectionBinding.contextId !== priorBinding.tab) {
      quarantineIfOwned(
        "route_conflict",
        `Verified context ${priorBinding.tab} no longer matches the RepoPrompt connection binding`
      );
    }
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    quarantineIfOwned(
      "observation_failed",
      `Failed to observe the verified route after a route-dependent call failed: ${diagnostic}`
    );
  }
}

export async function executeLeasedRouteDependentCall(
  lease: RouteDispatchLease,
  config: RpConfig,
  client: RoutingInventoryClient,
  dispatch: () => Promise<McpToolResult>
): Promise<McpToolResult> {
  const reconcileFailure = async (): Promise<void> => {
    await runRouteChange(async () => {
      await reconcileFailedRouteDependentCall(
        routeDispatchLeaseBinding(lease),
        config,
        client,
        undefined,
        lease
      );
    });
  };

  let result: McpToolResult;
  try {
    result = await dispatch();
  } catch (error) {
    await reconcileFailure();
    throw error;
  }

  if (result?.isError === true) {
    await reconcileFailure();
  }
  return result;
}
