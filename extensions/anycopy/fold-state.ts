import type { SessionEntry } from "@mariozechner/pi-coding-agent";

export const ANYCOPY_FOLD_STATE_CUSTOM_TYPE = "anycopy-fold-state";
const FOLD_STATE_SCHEMA_VERSION = 1;

type TreeSelectorLike = {
	getTreeList(): unknown;
};

type TreeListInternals = {
	foldedNodes?: Set<string>;
	flatNodes?: Array<{ node?: { entry?: { id?: string } } }>;
	applyFilter?: () => void;
	isFoldable?: (entryId: string) => boolean;
};

export type AnycopyFoldStateEntryData = {
	v: 1;
	foldedNodeIds: string[];
};

type MergeExplicitFoldMutationArgs = {
	durableFoldedNodeIds: Iterable<string>;
	beforeTransientFoldedNodeIds: Iterable<string>;
	afterTransientFoldedNodeIds: Iterable<string>;
	validNodeIds?: ReadonlySet<string>;
};

export const normalizeFoldedNodeIds = (
	nodeIds: Iterable<unknown>,
	validNodeIds?: ReadonlySet<string>,
): string[] => {
	const uniqueNodeIds = new Set<string>();
	for (const nodeId of nodeIds) {
		if (typeof nodeId !== "string" || nodeId.length === 0) continue;
		if (validNodeIds && !validNodeIds.has(nodeId)) continue;
		uniqueNodeIds.add(nodeId);
	}
	return [...uniqueNodeIds].sort();
};

export const foldStateNodeIdListsEqual = (left: readonly string[], right: readonly string[]): boolean =>
	left.length === right.length && left.every((value, index) => value === right[index]);

export const createFoldStateEntryData = (
	foldedNodeIds: Iterable<string>,
	validNodeIds?: ReadonlySet<string>,
): AnycopyFoldStateEntryData => ({
	v: FOLD_STATE_SCHEMA_VERSION,
	foldedNodeIds: normalizeFoldedNodeIds(foldedNodeIds, validNodeIds),
});

export const parseFoldStateEntryData = (
	data: unknown,
	validNodeIds?: ReadonlySet<string>,
): AnycopyFoldStateEntryData | null => {
	if (!data || typeof data !== "object") return null;

	const candidate = data as { v?: unknown; foldedNodeIds?: unknown };
	if (candidate.v !== FOLD_STATE_SCHEMA_VERSION || !Array.isArray(candidate.foldedNodeIds)) {
		return null;
	}

	return createFoldStateEntryData(candidate.foldedNodeIds, validNodeIds);
};

const getTreeListInternals = (selector: TreeSelectorLike): TreeListInternals | null => {
	const treeList = selector.getTreeList();
	if (!treeList || typeof treeList !== "object") return null;
	return treeList as TreeListInternals;
};

export const getSelectorFoldedNodeIds = (selector: TreeSelectorLike): string[] => {
	const internals = getTreeListInternals(selector);
	if (!internals?.foldedNodes) return [];
	return normalizeFoldedNodeIds(internals.foldedNodes);
};

export const setSelectorFoldedNodeIds = (selector: TreeSelectorLike, entryIds: Iterable<string>): string[] => {
	const internals = getTreeListInternals(selector);
	if (!internals?.foldedNodes || !internals.applyFilter || !Array.isArray(internals.flatNodes)) {
		return [];
	}

	const validNodeIds = new Set(
		internals.flatNodes
			.map((flatNode) => flatNode.node?.entry?.id)
			.filter((entryId): entryId is string => typeof entryId === "string"),
	);

	internals.foldedNodes.clear();
	internals.applyFilter();

	for (const entryId of normalizeFoldedNodeIds(entryIds, validNodeIds)) {
		if (!internals.isFoldable || internals.isFoldable(entryId)) {
			internals.foldedNodes.add(entryId);
		}
	}

	internals.applyFilter();
	return normalizeFoldedNodeIds(internals.foldedNodes);
};

export const loadLatestFoldStateFromEntries = (
	entries: Iterable<SessionEntry>,
	validNodeIds?: ReadonlySet<string>,
): AnycopyFoldStateEntryData | null => {
	const sessionEntries = [...entries];
	for (let index = sessionEntries.length - 1; index >= 0; index -= 1) {
		const entry = sessionEntries[index];
		if (entry.type !== "custom" || entry.customType !== ANYCOPY_FOLD_STATE_CUSTOM_TYPE) {
			continue;
		}

		const parsedEntry = parseFoldStateEntryData(entry.data, validNodeIds);
		if (parsedEntry) {
			return parsedEntry;
		}
	}

	return null;
};

export const mergeExplicitFoldMutation = ({
	durableFoldedNodeIds,
	beforeTransientFoldedNodeIds,
	afterTransientFoldedNodeIds,
	validNodeIds,
}: MergeExplicitFoldMutationArgs): string[] => {
	const normalizedDurableFoldedNodeIds = normalizeFoldedNodeIds(durableFoldedNodeIds, validNodeIds);
	const normalizedBeforeTransientFoldedNodeIds = normalizeFoldedNodeIds(beforeTransientFoldedNodeIds, validNodeIds);
	const normalizedAfterTransientFoldedNodeIds = normalizeFoldedNodeIds(afterTransientFoldedNodeIds, validNodeIds);

	const removedNodeIds = new Set(
		normalizedBeforeTransientFoldedNodeIds.filter((nodeId) => !normalizedAfterTransientFoldedNodeIds.includes(nodeId)),
	);
	const addedNodeIds = new Set(
		normalizedAfterTransientFoldedNodeIds.filter((nodeId) => !normalizedBeforeTransientFoldedNodeIds.includes(nodeId)),
	);
	const nextDurableFoldedNodeIds = normalizedDurableFoldedNodeIds.filter((nodeId) => !removedNodeIds.has(nodeId));
	for (const nodeId of addedNodeIds) {
		nextDurableFoldedNodeIds.push(nodeId);
	}

	return normalizeFoldedNodeIds(nextDurableFoldedNodeIds, validNodeIds);
};
