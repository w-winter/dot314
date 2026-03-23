import assert from "node:assert/strict";
import test from "node:test";

import { runAnycopyEnterNavigation } from "../enter-navigation.ts";

type SummaryChoice = "No summary" | "Summarize" | "Summarize with custom prompt";


function createHarness(options?: {
	selectResults?: Array<SummaryChoice | undefined>;
	editorResults?: Array<string | undefined>;
	navigateResult?: { cancelled: boolean; aborted?: boolean };
	navigateError?: Error;
	effectiveLeafIdForNoop?: string | null;
	skipSummaryPrompt?: boolean;
}) {
	const selectQueue = [...(options?.selectResults ?? [])];
	const editorQueue = [...(options?.editorResults ?? [])];
	const calls = {
		close: 0,
		reopen: [] as Array<{ initialSelectedId: string }>,
		navigate: [] as Array<{ targetId: string; options?: { summarize?: boolean; customInstructions?: string } }>,
		statuses: [] as Array<{ source: string; message: string }>,
		working: [] as Array<string | undefined>,
		notifications: [] as Array<{ message: string; level: "error" }>,
		selects: [] as Array<{ title: string; options: SummaryChoice[] }>,
		editors: [] as string[],
	};

	return {
		calls,
		run: () =>
			runAnycopyEnterNavigation({
				entryId: "target-node",
				effectiveLeafIdForNoop: options?.effectiveLeafIdForNoop ?? "current-node",
				skipSummaryPrompt: options?.skipSummaryPrompt ?? false,
				close: () => {
					calls.close += 1;
				},
				reopen: (reopenOptions) => {
					calls.reopen.push(reopenOptions);
				},
				navigateTree: async (targetId, navigateOptions) => {
					calls.navigate.push({ targetId, options: navigateOptions });
					if (options?.navigateError) {
						throw options.navigateError;
					}
					return options?.navigateResult ?? { cancelled: false };
				},
				ui: {
					select: async (title, selectOptions) => {
						calls.selects.push({ title, options: selectOptions });
						return selectQueue.shift();
					},
					editor: async (title) => {
						calls.editors.push(title);
						return editorQueue.shift();
					},
					setStatus: (source, message) => {
						calls.statuses.push({ source, message });
					},
					setWorkingMessage: (message) => {
						calls.working.push(message);
					},
					notify: (message, level) => {
						calls.notifications.push({ message, level });
					},
				},
			}),
	};
}

test("runAnycopyEnterNavigation closes with already-at-point status on noop", async () => {
	const harness = createHarness({ effectiveLeafIdForNoop: "target-node" });

	const result = await harness.run();

	assert.equal(result, "closed");
	assert.equal(harness.calls.close, 1);
	assert.deepEqual(harness.calls.statuses, [{ source: "anycopy", message: "Already at this point" }]);
	assert.deepEqual(harness.calls.navigate, []);
	assert.deepEqual(harness.calls.selects, []);
});

test("runAnycopyEnterNavigation reopens when summary selector is escaped", async () => {
	const harness = createHarness({ selectResults: [undefined] });

	const result = await harness.run();

	assert.equal(result, "reopen");
	assert.equal(harness.calls.close, 1);
	assert.deepEqual(harness.calls.navigate, []);
	assert.deepEqual(harness.calls.reopen, [{ initialSelectedId: "target-node" }]);
});

test("runAnycopyEnterNavigation loops back when custom prompt editor is cancelled", async () => {
	const harness = createHarness({
		selectResults: ["Summarize with custom prompt", "Summarize"],
		editorResults: [undefined],
	});

	const result = await harness.run();

	assert.equal(result, "closed");
	assert.equal(harness.calls.selects.length, 2);
	assert.deepEqual(harness.calls.editors, ["Custom summarization instructions"]);
	assert.deepEqual(harness.calls.navigate, [
		{ targetId: "target-node", options: { summarize: true, customInstructions: undefined } },
	]);
});

test("runAnycopyEnterNavigation navigates without summary when selected", async () => {
	const harness = createHarness({ selectResults: ["No summary"] });

	const result = await harness.run();

	assert.equal(result, "closed");
	assert.deepEqual(harness.calls.navigate, [
		{ targetId: "target-node", options: { summarize: false, customInstructions: undefined } },
	]);
});

test("runAnycopyEnterNavigation skips the summary prompt when configured", async () => {
	const harness = createHarness({ skipSummaryPrompt: true });

	const result = await harness.run();

	assert.equal(result, "closed");
	assert.deepEqual(harness.calls.selects, []);
	assert.deepEqual(harness.calls.navigate, [
		{ targetId: "target-node", options: { summarize: false, customInstructions: undefined } },
	]);
});

test("runAnycopyEnterNavigation navigates with summary when selected", async () => {
	const harness = createHarness({ selectResults: ["Summarize"] });

	const result = await harness.run();

	assert.equal(result, "closed");
	assert.deepEqual(harness.calls.navigate, [
		{ targetId: "target-node", options: { summarize: true, customInstructions: undefined } },
	]);
});

test("runAnycopyEnterNavigation navigates with custom summary instructions", async () => {
	const harness = createHarness({
		selectResults: ["Summarize with custom prompt"],
		editorResults: ["keep the repo context"],
	});

	const result = await harness.run();

	assert.equal(result, "closed");
	assert.deepEqual(harness.calls.navigate, [
		{ targetId: "target-node", options: { summarize: true, customInstructions: "keep the repo context" } },
	]);
});

test("runAnycopyEnterNavigation reports summarization cancellation and reopens", async () => {
	const harness = createHarness({
		selectResults: ["Summarize"],
		navigateResult: { cancelled: true },
	});

	const result = await harness.run();

	assert.equal(result, "reopen");
	assert.deepEqual(harness.calls.statuses, [{ source: "anycopy", message: "Branch summarization cancelled" }]);
	assert.deepEqual(harness.calls.reopen, [{ initialSelectedId: "target-node" }]);
});

test("runAnycopyEnterNavigation reports non-summary cancellation without reopening", async () => {
	const harness = createHarness({
		selectResults: ["No summary"],
		navigateResult: { cancelled: true },
	});

	const result = await harness.run();

	assert.equal(result, "closed");
	assert.deepEqual(harness.calls.statuses, [{ source: "anycopy", message: "Navigation cancelled" }]);
	assert.deepEqual(harness.calls.reopen, []);
});

test("runAnycopyEnterNavigation notifies on thrown navigation error", async () => {
	const harness = createHarness({
		selectResults: ["No summary"],
		navigateError: new Error("No model available for summarization"),
	});

	const result = await harness.run();

	assert.equal(result, "closed");
	assert.deepEqual(harness.calls.notifications, [
		{ message: "No model available for summarization", level: "error" },
	]);
	assert.deepEqual(harness.calls.reopen, []);
});

test("runAnycopyEnterNavigation sets and clears working message around navigation", async () => {
	const harness = createHarness({ selectResults: ["No summary"] });

	await harness.run();

	assert.deepEqual(harness.calls.working, ["Navigating tree…", undefined]);
});
