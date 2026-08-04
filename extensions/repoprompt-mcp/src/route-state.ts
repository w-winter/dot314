import type { AutoSelectionEntryData, BindingEntryData, RpAppId } from "./types.js";

export interface RouteIdentity {
  readonly app: RpAppId;
  readonly windowId: number;
  readonly workspace?: string;
  readonly autoDetected?: boolean;
}

export interface PersistedRouteIntent extends RouteIdentity {
  readonly tabContextId?: string;
}

export interface VerifiedRoute {
  readonly kind: "tab";
  readonly identity: RouteIdentity;
  readonly contextId: string;
  readonly tabName: string;
}

export type QuarantineCause =
  | "post_mutation_observation_failed"
  | "ambiguous_mutation_result"
  | "route_disappeared"
  | "route_conflict"
  | "observation_failed";

export type RouteState =
  | { readonly kind: "unbound" }
  | { readonly kind: "intent"; readonly intent: PersistedRouteIntent }
  | { readonly kind: "verified"; readonly route: VerifiedRoute }
  | {
      readonly kind: "quarantined";
      readonly intent?: PersistedRouteIntent;
      readonly cause: QuarantineCause;
      readonly diagnostic: string;
    };

export const ROUTE_SELECTOR_KEYS = ["_windowID", "context_id"] as const;

export type SelectorDecision =
  | { readonly kind: "selectors"; readonly args: Readonly<Record<string, unknown>> }
  | { readonly kind: "blocked"; readonly diagnostic: string }
  | { readonly kind: "conflict"; readonly diagnostic: string };

export interface RouteDispatchLease {
  readonly kind: "lease";
  readonly route: VerifiedRoute;
  readonly selectors: Readonly<Record<string, unknown>>;
  readonly publicationGeneration: number;
}

export type RouteDispatchLeaseDecision =
  | RouteDispatchLease
  | Extract<SelectorDecision, { readonly kind: "blocked" | "conflict" }>;

export type RouteDispatchIssue<T> =
  | { readonly kind: "issued"; readonly lease: RouteDispatchLease; readonly request: T }
  | Extract<SelectorDecision, { readonly kind: "blocked" | "conflict" }>;

export interface RouteDisplayIdentity extends RouteIdentity {
  readonly stateKind: Exclude<RouteState["kind"], "unbound">;
  readonly verifiedKind?: VerifiedRoute["kind"];
  readonly tabContextId?: string;
  readonly tabName?: string;
  readonly quarantineCause?: QuarantineCause;
  readonly quarantineDiagnostic?: string;
  readonly persistenceDiagnostic?: string;
}

export type RoutePublicationResult =
  | { readonly kind: "published"; readonly persistence: "persisted" | "skipped" }
  | { readonly kind: "published"; readonly persistence: "degraded"; readonly diagnostic: string };

export interface RouteStatusSnapshot {
  readonly state: RouteState;
  readonly persistenceDiagnostic?: string;
}

export interface SelectorDecisionOptions {
  readonly callerArgs?: Readonly<Record<string, unknown>>;
}

function copyIdentity(identity: RouteIdentity): RouteIdentity {
  return {
    app: identity.app,
    windowId: identity.windowId,
    ...(identity.workspace !== undefined ? { workspace: identity.workspace } : {}),
    ...(identity.autoDetected !== undefined ? { autoDetected: identity.autoDetected } : {}),
  };
}

function copyIntent(intent: PersistedRouteIntent): PersistedRouteIntent {
  return {
    ...copyIdentity(intent),
    ...(intent.tabContextId !== undefined ? { tabContextId: intent.tabContextId } : {}),
  };
}

function copyVerifiedRoute(route: VerifiedRoute): VerifiedRoute {
  return {
    kind: "tab",
    identity: copyIdentity(route.identity),
    contextId: route.contextId,
    tabName: route.tabName,
  };
}

function intentFromVerifiedRoute(route: VerifiedRoute): PersistedRouteIntent {
  return {
    ...copyIdentity(route.identity),
    tabContextId: route.contextId,
  };
}

function parseRouteIdentity(value: unknown, app: RpAppId): RouteIdentity | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const data = value as Record<string, unknown>;
  if (data.app !== app || !Number.isInteger(data.windowId) || (data.windowId as number) < 0) {
    return null;
  }
  if (data.workspace !== undefined && typeof data.workspace !== "string") {
    return null;
  }

  return {
    app,
    windowId: data.windowId as number,
    ...(typeof data.workspace === "string" ? { workspace: data.workspace } : {}),
  };
}

export function persistedIntentFromBindingEntry(
  value: BindingEntryData | unknown,
  app: RpAppId
): PersistedRouteIntent | null {
  const identity = parseRouteIdentity(value, app);
  if (!identity) {
    return null;
  }

  const tab = (value as Record<string, unknown>).tab;
  if (tab !== undefined && (typeof tab !== "string" || tab.length === 0)) {
    return null;
  }

  return {
    ...identity,
    ...(typeof tab === "string" ? { tabContextId: tab } : {}),
  };
}

export function persistedIntentFromAutoSelectionEntry(
  value: AutoSelectionEntryData | unknown,
  app: RpAppId
): PersistedRouteIntent | null {
  const identity = parseRouteIdentity(value, app);
  if (!identity) {
    return null;
  }

  const tab = (value as Record<string, unknown>).tab;
  if (typeof tab !== "string" || tab.length === 0) {
    return null;
  }

  return { ...identity, tabContextId: tab };
}

function selectorArgsForRoute(route: VerifiedRoute): Readonly<Record<string, unknown>> {
  return { _windowID: route.identity.windowId, context_id: route.contextId };
}

function callerSelectorKeys(args: Readonly<Record<string, unknown>>): readonly string[] {
  return ROUTE_SELECTOR_KEYS.filter((key) => Object.hasOwn(args, key));
}

function selectorsMatch(
  route: VerifiedRoute,
  callerArgs: Readonly<Record<string, unknown>>
): boolean {
  const keys = callerSelectorKeys(callerArgs);
  if (keys.length === 0) {
    return true;
  }

  return keys.length === 2
    && callerArgs._windowID === route.identity.windowId
    && callerArgs.context_id === route.contextId;
}

export function displayIdentityFor(snapshot: RouteStatusSnapshot): RouteDisplayIdentity | null {
  const state = snapshot.state;
  switch (state.kind) {
    case "unbound":
      return null;
    case "intent":
      return {
        ...copyIdentity(state.intent),
        stateKind: "intent",
        ...(state.intent.tabContextId ? { tabContextId: state.intent.tabContextId } : {}),
      };
    case "quarantined":
      return state.intent
        ? {
            ...copyIdentity(state.intent),
            stateKind: "quarantined",
            quarantineCause: state.cause,
            quarantineDiagnostic: state.diagnostic,
            ...(state.intent.tabContextId ? { tabContextId: state.intent.tabContextId } : {}),
          }
        : null;
    case "verified":
      return {
        ...copyIdentity(state.route.identity),
        stateKind: "verified",
        verifiedKind: "tab",
        tabContextId: state.route.contextId,
        tabName: state.route.tabName,
        ...(snapshot.persistenceDiagnostic
          ? { persistenceDiagnostic: snapshot.persistenceDiagnostic }
          : {}),
      };
  }
}

function abortError(): Error {
  const error = new Error("Route publication wait was aborted");
  error.name = "AbortError";
  return error;
}

async function waitWithAbort(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await promise;
    return;
  }
  if (signal.aborted) {
    throw signal.reason ?? abortError();
  }

  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    await Promise.race([promise, aborted]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export class RouteChangeCoordinator {
  private publicationTail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const execution = this.publicationTail.then(async () => {
      signal?.throwIfAborted();
      return await operation();
    });
    this.publicationTail = execution.then(() => undefined, () => undefined);
    return execution;
  }

  issue<T>(operation: () => T, signal?: AbortSignal): Promise<T> {
    const execution = this.publicationTail.then(() => {
      signal?.throwIfAborted();
      return operation();
    });
    this.publicationTail = execution.then(() => undefined, () => undefined);
    return execution;
  }

  async waitForIdle(signal?: AbortSignal): Promise<void> {
    await waitWithAbort(this.publicationTail, signal);
  }
}

export class RouteStore {
  private state: RouteState = { kind: "unbound" };
  private persistenceDiagnostic: string | undefined;
  private coordinator = new RouteChangeCoordinator();
  private publicationGeneration = 0;

  private advancePublicationGeneration(): void {
    this.publicationGeneration += 1;
  }

  snapshot(): RouteState {
    switch (this.state.kind) {
      case "unbound":
        return this.state;
      case "intent":
        return { kind: "intent", intent: copyIntent(this.state.intent) };
      case "verified":
        return { kind: "verified", route: copyVerifiedRoute(this.state.route) };
      case "quarantined":
        return {
          kind: "quarantined",
          ...(this.state.intent ? { intent: copyIntent(this.state.intent) } : {}),
          cause: this.state.cause,
          diagnostic: this.state.diagnostic,
        };
    }
  }

  restoreIntent(intent: PersistedRouteIntent | null): void {
    this.state = intent
      ? { kind: "intent", intent: copyIntent(intent) }
      : { kind: "unbound" };
    this.persistenceDiagnostic = undefined;
    this.advancePublicationGeneration();
  }

  publishIntent(intent: PersistedRouteIntent, persist?: () => void): RoutePublicationResult {
    this.state = { kind: "intent", intent: copyIntent(intent) };
    this.persistenceDiagnostic = undefined;
    this.advancePublicationGeneration();

    if (!persist) {
      return { kind: "published", persistence: "skipped" };
    }

    try {
      persist();
      return { kind: "published", persistence: "persisted" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.persistenceDiagnostic = `Route intent is live, but branch persistence failed: ${message}`;
      return {
        kind: "published",
        persistence: "degraded",
        diagnostic: this.persistenceDiagnostic,
      };
    }
  }

  publishVerified(route: VerifiedRoute, persist?: () => void): RoutePublicationResult {
    if (route.kind !== "tab") {
      throw new Error("A verified route requires a concrete tab");
    }
    this.state = { kind: "verified", route: copyVerifiedRoute(route) };
    this.persistenceDiagnostic = undefined;
    this.advancePublicationGeneration();

    if (!persist) {
      return { kind: "published", persistence: "skipped" };
    }

    try {
      persist();
      return { kind: "published", persistence: "persisted" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.persistenceDiagnostic = `Verified route is live, but branch persistence failed: ${message}`;
      return {
        kind: "published",
        persistence: "degraded",
        diagnostic: this.persistenceDiagnostic,
      };
    }
  }

  quarantine(cause: QuarantineCause, diagnostic: string, intent?: PersistedRouteIntent): void {
    const retainedIntent = intent
      ?? (this.state.kind === "verified" ? intentFromVerifiedRoute(this.state.route) : undefined)
      ?? (this.state.kind === "intent" ? this.state.intent : undefined)
      ?? (this.state.kind === "quarantined" ? this.state.intent : undefined);
    this.state = {
      kind: "quarantined",
      ...(retainedIntent ? { intent: copyIntent(retainedIntent) } : {}),
      cause,
      diagnostic,
    };
    this.persistenceDiagnostic = undefined;
    this.advancePublicationGeneration();
  }

  clear(): void {
    this.state = { kind: "unbound" };
    this.persistenceDiagnostic = undefined;
    this.advancePublicationGeneration();
  }

  snapshotVerified(): VerifiedRoute | null {
    return this.state.kind === "verified" ? copyVerifiedRoute(this.state.route) : null;
  }

  statusSnapshot(): RouteStatusSnapshot {
    return {
      state: this.snapshot(),
      ...(this.persistenceDiagnostic
        ? { persistenceDiagnostic: this.persistenceDiagnostic }
        : {}),
    };
  }

  selectorDecision(options: SelectorDecisionOptions): SelectorDecision {
    if (this.state.kind !== "verified") {
      return {
        kind: "blocked",
        diagnostic: `RepoPrompt route is ${this.state.kind}; verify or bind it before calling a route-dependent tool`,
      };
    }
    const callerArgs = options.callerArgs ?? {};
    if (!selectorsMatch(this.state.route, callerArgs)) {
      return {
        kind: "conflict",
        diagnostic: "Caller routing selectors must match the verified RepoPrompt route as one complete selector set",
      };
    }

    return { kind: "selectors", args: selectorArgsForRoute(this.state.route) };
  }

  runRouteChange<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.coordinator.run(operation, signal);
  }

  private createDispatchLease(options: SelectorDecisionOptions): RouteDispatchLeaseDecision {
    if (this.state.kind !== "verified") {
      return {
        kind: "blocked",
        diagnostic: `RepoPrompt route is ${this.state.kind}; verify or bind it before calling a route-dependent tool`,
      };
    }
    const callerArgs = options.callerArgs ?? {};
    if (!selectorsMatch(this.state.route, callerArgs)) {
      return {
        kind: "conflict",
        diagnostic: "Caller routing selectors must match the verified RepoPrompt route as one complete selector set",
      };
    }
    return {
      kind: "lease",
      route: copyVerifiedRoute(this.state.route),
      selectors: selectorArgsForRoute(this.state.route),
      publicationGeneration: this.publicationGeneration,
    };
  }

  issueDispatch<T>(
    options: SelectorDecisionOptions,
    dispatch: (lease: RouteDispatchLease) => T,
    signal?: AbortSignal
  ): Promise<RouteDispatchIssue<T>> {
    return this.coordinator.issue(() => {
      const decision = this.createDispatchLease(options);
      if (decision.kind !== "lease") {
        return decision;
      }
      return { kind: "issued", lease: decision, request: dispatch(decision) };
    }, signal);
  }

  ownsDispatchLease(lease: RouteDispatchLease): boolean {
    return this.state.kind === "verified"
      && this.publicationGeneration === lease.publicationGeneration;
  }

  snapshotPublicationGeneration(): number {
    return this.publicationGeneration;
  }

  ownsPublicationGeneration(generation: number): boolean {
    return this.publicationGeneration === generation;
  }

  waitForRoutePublication(signal?: AbortSignal): Promise<void> {
    return this.coordinator.waitForIdle(signal);
  }

  resetForTests(): void {
    this.state = { kind: "unbound" };
    this.persistenceDiagnostic = undefined;
    this.coordinator = new RouteChangeCoordinator();
    this.publicationGeneration = 0;
  }
}

export const routeStore = new RouteStore();
