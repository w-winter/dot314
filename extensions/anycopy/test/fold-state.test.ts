import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@mariozechner/pi-coding-agent";

import {
	ANYCOPY_FOLD_STATE_CUSTOM_TYPE,
	createFoldStateEntryData,
	getSelectorFoldedNodeIds,
	loadLatestFoldStateFromEntries,
	mergeExplicitFoldMutation,
	normalizeFoldedNodeIds,
	setSelectorFoldedNodeIds,
} from "../fold-state.ts";

const VALID_NODE_IDS = new Set(["branch-a", "branch-b", "branch-c"]);

const createCustomEntry = (id: string, data: unknown, parentId: string | null = null): SessionEntry => ({
	type: "custom",
	customType: ANYCOPY_FOLD_STATE_CUSTOM_TYPE,
	data,
	id,
	parentId,
	timestamp: new Date().toISOString(),
});

const createUserEntry = (id: string, parentId: string | null = null): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date().toISOString(),
	message: { role: "user", content: id, timestamp: Date.now() },
});

test("normalizeFoldedNodeIds filters invalid ids, de-dupes, and sorts", () => {
	assert.deepEqual(
		normalizeFoldedNodeIds(["branch-b", "branch-a", "branch-b", "", 42, "missing"], VALID_NODE_IDS),
		["branch-a", "branch-b"],
	);
});

test("loadLatestFoldStateFromEntries ignores malformed newer entries", () => {
	const entries: SessionEntry[] = [
		createCustomEntry("fold-valid", createFoldStateEntryData(["branch-a"])),
		createCustomEntry("fold-invalid", { v: 999, foldedNodeIds: ["branch-b"] }),
	];

	assert.deepEqual(loadLatestFoldStateFromEntries(entries, VALID_NODE_IDS), createFoldStateEntryData(["branch-a"]));
});

test("loadLatestFoldStateFromEntries restores the latest global fold snapshot across branches", () => {
	const entries: SessionEntry[] = [
		createUserEntry("root"),
		createUserEntry("branch-a", "root"),
		createUserEntry("branch-b", "root"),
		createCustomEntry("fold-a", createFoldStateEntryData(["branch-a"]), "branch-a"),
	];

	assert.deepEqual(loadLatestFoldStateFromEntries(entries, VALID_NODE_IDS), createFoldStateEntryData(["branch-a"]));
});

test("loadLatestFoldStateFromEntries picks the newest snapshot even when it was saved from another branch", () => {
	const entries: SessionEntry[] = [
		createUserEntry("root"),
		createUserEntry("branch-a", "root"),
		createUserEntry("branch-b", "root"),
		createCustomEntry("fold-a", createFoldStateEntryData(["branch-a"]), "branch-a"),
		createCustomEntry("fold-b", createFoldStateEntryData(["branch-b", "branch-c"]), "branch-b"),
	];

	assert.deepEqual(
		loadLatestFoldStateFromEntries(entries, VALID_NODE_IDS),
		createFoldStateEntryData(["branch-b", "branch-c"]),
	);
});

test("mergeExplicitFoldMutation preserves durable folds through transient resets", () => {
	const nextDurableFoldedNodeIds = mergeExplicitFoldMutation({
		durableFoldedNodeIds: ["branch-a", "branch-b"],
		beforeTransientFoldedNodeIds: [],
		afterTransientFoldedNodeIds: ["branch-c"],
		validNodeIds: VALID_NODE_IDS,
	});

	assert.deepEqual(nextDurableFoldedNodeIds, ["branch-a", "branch-b", "branch-c"]);
});

test("mergeExplicitFoldMutation removes only explicitly unfolded ids", () => {
	const nextDurableFoldedNodeIds = mergeExplicitFoldMutation({
		durableFoldedNodeIds: ["branch-a", "branch-b", "branch-c"],
		beforeTransientFoldedNodeIds: ["branch-a", "branch-b"],
		afterTransientFoldedNodeIds: ["branch-b"],
		validNodeIds: VALID_NODE_IDS,
	});

	assert.deepEqual(nextDurableFoldedNodeIds, ["branch-b", "branch-c"]);
});

test("setSelectorFoldedNodeIds restores only valid foldable ids", () => {
	const treeList = {
		foldedNodes: new Set<string>(),
		flatNodes: [
			{ node: { entry: { id: "branch-a" } } },
			{ node: { entry: { id: "branch-b" } } },
			{ node: { entry: { id: "leaf-c" } } },
		],
		applyFilterCalls: 0,
		applyFilter() {
			this.applyFilterCalls += 1;
		},
		isFoldable(entryId: string) {
			return entryId !== "leaf-c";
		},
	};
	const selector = { getTreeList: () => treeList };

	assert.deepEqual(setSelectorFoldedNodeIds(selector, ["branch-b", "leaf-c", "missing", "branch-a"]), [
		"branch-a",
		"branch-b",
	]);
	assert.deepEqual(getSelectorFoldedNodeIds(selector), ["branch-a", "branch-b"]);
	assert.equal(treeList.applyFilterCalls, 2);
});
