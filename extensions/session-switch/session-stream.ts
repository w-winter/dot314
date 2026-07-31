import type { SessionInfo } from "@earendil-works/pi-coding-agent";

import {
	discoverSessionFiles,
	isSessionScanCancellation,
	scanSessionFiles,
	sessionMatchesDiscoveryTarget,
	type ScannedSession,
	type SessionDiscoveryTarget,
	type SessionFileCandidate,
} from "./session-scanner.ts";

export interface SessionListPort {
	setSessions(sessions: SessionInfo[], showCwd: boolean): void;
}

export type SessionStreamScope = "current" | "all";

export interface SessionStreamBackend {
	discover(target: SessionDiscoveryTarget, signal: AbortSignal): Promise<SessionFileCandidate[]>;
	scan(
		candidates: readonly SessionFileCandidate[],
		options: {
			signal: AbortSignal;
			onFileScanned?: (loaded: number, total: number) => void;
		},
	): Promise<ScannedSession[]>;
	yieldControl(): Promise<void>;
}

export interface SessionStreamProgress {
	readonly loaded: number;
	readonly total: number;
}

interface CachedSession {
	mtimeMs: number;
	session: ScannedSession;
}

interface ScopeState {
	sequence: number;
	abortController: AbortController;
	sessions: ScannedSession[];
	cache: Map<string, CachedSession>;
	progress: SessionStreamProgress | null;
	status: string | null;
}

interface AttachedSessionList {
	port: SessionListPort;
	originalSetSessions: SessionListPort["setSessions"];
	wrappedSetSessions: SessionListPort["setSessions"];
}

const INITIAL_SESSION_COUNT = 30;
const BACKGROUND_SCAN_CHUNK_SIZE = 30;
const CURRENT_PUBLICATION_START = 30;
const ALL_PUBLICATION_START = 120;

const defaultBackend: SessionStreamBackend = {
	discover: discoverSessionFiles,
	scan: scanSessionFiles,
	yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
};

function cancellationError(): Error {
	const error = new Error("Session stream cancelled");
	error.name = "AbortError";
	return error;
}

export class SessionStreamController {
	private readonly targets: Record<SessionStreamScope, SessionDiscoveryTarget>;
	private readonly syncSessions: (sessions: readonly ScannedSession[]) => void;
	private readonly requestRender: () => void;
	private readonly backend: SessionStreamBackend;
	private readonly states: Partial<Record<SessionStreamScope, ScopeState>> = {};
	private readonly sequences: Record<SessionStreamScope, number> = { current: 0, all: 0 };
	private readonly pendingControllers: Partial<Record<SessionStreamScope, AbortController>> = {};
	private scanQueue: Promise<void> = Promise.resolve();
	private visibleScope: SessionStreamScope = "current";
	private attached: AttachedSessionList | null = null;
	private disposed = false;

	constructor(options: {
		targets: Record<SessionStreamScope, SessionDiscoveryTarget>;
		syncSessions: (sessions: readonly ScannedSession[]) => void;
		requestRender: () => void;
		backend?: SessionStreamBackend;
	}) {
		this.targets = options.targets;
		this.syncSessions = options.syncSessions;
		this.requestRender = options.requestRender;
		this.backend = options.backend ?? defaultBackend;
	}

	async load(
		scope: SessionStreamScope,
		onProgress?: (loaded: number, total: number) => void,
	): Promise<SessionInfo[]> {
		if (this.disposed) throw cancellationError();
		const existing = this.states[scope];
		if (existing) {
			this.startWarmReconciliation(scope, existing);
			return existing.sessions;
		}

		this.pendingControllers[scope]?.abort();
		const sequence = ++this.sequences[scope];
		const abortController = new AbortController();
		this.pendingControllers[scope] = abortController;

		try {
			const candidates = await this.backend.discover(this.targets[scope], abortController.signal);
			this.assertPending(scope, sequence, abortController);
			const target = this.targets[scope];
			const initialSessions: ScannedSession[] = [];
			const initialScannedSessions: ScannedSession[] = [];
			let initialLoaded = 0;
			while (initialLoaded < candidates.length && initialSessions.length < INITIAL_SESSION_COUNT) {
				const batchStart = initialLoaded;
				const batch = candidates.slice(batchStart, batchStart + INITIAL_SESSION_COUNT);
				const sessions = await this.enqueueScan(
					batch,
					{
						signal: abortController.signal,
						onFileScanned: (loaded) => {
							if (
								abortController.signal.aborted ||
								this.sequences[scope] !== sequence ||
								this.pendingControllers[scope] !== abortController
							) return;
							initialLoaded = batchStart + loaded;
							onProgress?.(initialLoaded, candidates.length);
						},
					},
					() => this.assertPending(scope, sequence, abortController),
				);
				initialLoaded = batchStart + batch.length;
				initialScannedSessions.push(...sessions);
				initialSessions.push(...sessions.filter((session) => sessionMatchesDiscoveryTarget(session, target)));
				this.assertPending(scope, sequence, abortController);
			}
			if (initialLoaded < candidates.length && initialSessions.length > INITIAL_SESSION_COUNT) {
				initialSessions.length = INITIAL_SESSION_COUNT;
			}
			initialSessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());

			const cache = new Map<string, CachedSession>();
			const candidateByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
			for (const session of initialScannedSessions) {
				const candidate = candidateByPath.get(session.path);
				if (candidate) cache.set(session.path, { mtimeMs: candidate.priorityMtimeMs, session });
			}
			const state: ScopeState = {
				sequence,
				abortController,
				sessions: initialSessions,
				cache,
				progress: initialLoaded < candidates.length ? { loaded: initialLoaded, total: candidates.length } : null,
				status: null,
			};
			this.states[scope] = state;
			delete this.pendingControllers[scope];
			this.syncKnownSessions();
			if (initialLoaded < candidates.length) {
				void this.runCandidateSet(
					scope,
					state,
					sequence,
					abortController.signal,
					candidates,
					candidates.slice(initialLoaded),
				).catch((error) => this.handleBackgroundError(scope, state, sequence, candidates, error));
			}
			return state.sessions;
		} catch (error) {
			abortController.abort();
			if (this.sequences[scope] === sequence) delete this.pendingControllers[scope];
			throw error;
		}
	}

	attach(sessionList: SessionListPort): void {
		if (this.attached) throw new Error("Session stream controller is already attached");
		const originalSetSessions = sessionList.setSessions;
		const controller = this;
		const wrappedSetSessions: SessionListPort["setSessions"] = function (sessions, showCwd) {
			const scope: SessionStreamScope = showCwd ? "all" : "current";
			controller.visibleScope = scope;
			const state = controller.states[scope];
			if (state && sessions !== state.sessions) controller.adoptAndReconcile(scope, state, sessions as ScannedSession[]);
			controller.syncKnownSessions();
			originalSetSessions.call(sessionList, sessions, showCwd);
		};
		sessionList.setSessions = wrappedSetSessions;
		this.attached = { port: sessionList, originalSetSessions, wrappedSetSessions };
	}

	getVisibleProgress(): Readonly<SessionStreamProgress> | null {
		return this.states[this.visibleScope]?.progress ?? null;
	}

	getVisibleStatus(): string | null {
		return this.states[this.visibleScope]?.status ?? null;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.pendingControllers.current?.abort();
		this.pendingControllers.all?.abort();
		for (const scope of ["current", "all"] as const) {
			this.sequences[scope] += 1;
			const state = this.states[scope];
			state?.abortController.abort();
			state?.cache.clear();
			delete this.states[scope];
		}
		const attached = this.attached;
		if (attached && attached.port.setSessions === attached.wrappedSetSessions) {
			attached.port.setSessions = attached.originalSetSessions;
		}
		this.attached = null;
	}

	private assertPending(
		scope: SessionStreamScope,
		sequence: number,
		abortController: AbortController,
	): void {
		if (
			this.disposed ||
			abortController.signal.aborted ||
			this.sequences[scope] !== sequence ||
			this.pendingControllers[scope] !== abortController
		) {
			throw cancellationError();
		}
	}

	private async enqueueScan(
		candidates: readonly SessionFileCandidate[],
		options: { signal: AbortSignal; onFileScanned?: (loaded: number, total: number) => void },
		assertCurrent: () => void,
	): Promise<ScannedSession[]> {
		const previous = this.scanQueue;
		let release!: () => void;
		this.scanQueue = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try {
			assertCurrent();
			return await this.backend.scan(candidates, options);
		} finally {
			release();
		}
	}

	private isCurrent(scope: SessionStreamScope, state: ScopeState, sequence: number): boolean {
		return !this.disposed && this.states[scope] === state && state.sequence === sequence;
	}

	private startWarmReconciliation(scope: SessionStreamScope, state: ScopeState): void {
		state.abortController.abort();
		const sequence = ++this.sequences[scope];
		const abortController = new AbortController();
		state.sequence = sequence;
		state.abortController = abortController;
		state.progress = null;
		state.status = null;
		void this.reconcile(scope, state, sequence, abortController.signal);
	}

	private adoptAndReconcile(scope: SessionStreamScope, state: ScopeState, sessions: ScannedSession[]): void {
		state.abortController.abort();
		const sequence = ++this.sequences[scope];
		const abortController = new AbortController();
		state.sequence = sequence;
		state.abortController = abortController;
		state.sessions = sessions;
		state.status = null;
		this.syncKnownSessions();
		void this.reconcile(scope, state, sequence, abortController.signal);
	}

	private async reconcile(
		scope: SessionStreamScope,
		state: ScopeState,
		sequence: number,
		signal: AbortSignal,
	): Promise<void> {
		let candidates: readonly SessionFileCandidate[] | undefined;
		try {
			await this.backend.yieldControl();
			if (!this.isCurrent(scope, state, sequence)) return;
			candidates = await this.backend.discover(this.targets[scope], signal);
			if (!this.isCurrent(scope, state, sequence)) return;
			await this.runCandidateSet(scope, state, sequence, signal, candidates, candidates);
		} catch (error) {
			this.handleBackgroundError(scope, state, sequence, candidates, error);
		}
	}

	private async runCandidateSet(
		scope: SessionStreamScope,
		state: ScopeState,
		sequence: number,
		signal: AbortSignal,
		allCandidates: readonly SessionFileCandidate[],
		candidatesToScan: readonly SessionFileCandidate[],
	): Promise<void> {
		await this.backend.yieldControl();
		if (!this.isCurrent(scope, state, sequence)) return;

		const freshPaths = new Set(allCandidates.map((candidate) => candidate.path));
		for (const path of state.cache.keys()) {
			if (!freshPaths.has(path)) state.cache.delete(path);
		}
		const changedCandidates = candidatesToScan.filter((candidate) => {
			const cached = state.cache.get(candidate.path);
			return !cached || cached.mtimeMs !== candidate.priorityMtimeMs;
		});
		let loaded = allCandidates.length - changedCandidates.length;
		state.progress = loaded < allCandidates.length ? { loaded, total: allCandidates.length } : null;
		let nextPublication = scope === "all" ? ALL_PUBLICATION_START : CURRENT_PUBLICATION_START;
		let processedSincePublication = 0;

		for (let offset = 0; offset < changedCandidates.length; offset += BACKGROUND_SCAN_CHUNK_SIZE) {
			if (!this.isCurrent(scope, state, sequence)) return;
			const chunk = changedCandidates.slice(offset, offset + BACKGROUND_SCAN_CHUNK_SIZE);
			const sessions = await this.enqueueScan(chunk, { signal }, () => {
				if (!this.isCurrent(scope, state, sequence) || signal.aborted) throw cancellationError();
			});
			if (!this.isCurrent(scope, state, sequence)) return;
			const scannedByPath = new Map(sessions.map((session) => [session.path, session]));
			for (const candidate of chunk) {
				const session = scannedByPath.get(candidate.path);
				if (session) state.cache.set(candidate.path, { mtimeMs: candidate.priorityMtimeMs, session });
				else state.cache.delete(candidate.path);
			}
			loaded += chunk.length;
			processedSincePublication += chunk.length;
			state.progress = loaded < allCandidates.length ? { loaded, total: allCandidates.length } : null;
			if (processedSincePublication >= nextPublication) {
				this.materializeSessions(scope, state, allCandidates);
				this.publish(scope, state, sequence);
				processedSincePublication = 0;
				nextPublication *= 2;
			}
			await this.backend.yieldControl();
		}

		if (!this.isCurrent(scope, state, sequence)) return;
		this.materializeSessions(scope, state, allCandidates);
		state.progress = null;
		state.status = null;
		this.publish(scope, state, sequence);
	}

	private materializeSessions(
		scope: SessionStreamScope,
		state: ScopeState,
		candidates: readonly SessionFileCandidate[],
	): void {
		const target = this.targets[scope];
		const sessions = candidates
			.map((candidate) => state.cache.get(candidate.path)?.session)
			.filter((session): session is ScannedSession =>
				session !== undefined && sessionMatchesDiscoveryTarget(session, target))
			.sort((left, right) => right.modified.getTime() - left.modified.getTime());
		state.sessions.splice(0, state.sessions.length, ...sessions);
		this.syncKnownSessions();
	}

	private syncKnownSessions(): void {
		const sessionsByPath = new Map<string, ScannedSession>();
		const hiddenScope: SessionStreamScope = this.visibleScope === "current" ? "all" : "current";
		for (const scope of [hiddenScope, this.visibleScope]) {
			for (const session of this.states[scope]?.sessions ?? []) sessionsByPath.set(session.path, session);
		}
		this.syncSessions([...sessionsByPath.values()]);
	}

	private publish(scope: SessionStreamScope, state: ScopeState, sequence: number): void {
		if (!this.isCurrent(scope, state, sequence) || this.visibleScope !== scope || !this.attached) return;
		this.attached.originalSetSessions.call(this.attached.port, state.sessions, scope === "all");
		this.requestRender();
	}

	private handleBackgroundError(
		scope: SessionStreamScope,
		state: ScopeState,
		sequence: number,
		candidates: readonly SessionFileCandidate[] | undefined,
		error: unknown,
	): void {
		if (!this.isCurrent(scope, state, sequence) || isSessionScanCancellation(error)) return;
		state.abortController.abort();
		if (candidates) {
			const freshPaths = new Set(candidates.map((candidate) => candidate.path));
			for (const path of state.cache.keys()) {
				if (!freshPaths.has(path)) state.cache.delete(path);
			}
			this.materializeSessions(scope, state, candidates);
		}
		state.progress = null;
		state.status = `Session scan stopped: ${error instanceof Error ? error.message : String(error)}`;
		this.publish(scope, state, sequence);
	}
}
