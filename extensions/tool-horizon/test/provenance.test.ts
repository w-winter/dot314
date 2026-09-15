import { describe, expect, test } from "bun:test";

import {
	TOOL_HORIZON_CHECKPOINT_ABSENCE_STATE,
	TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE,
	TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
	buildCheckpointState,
	detectFileProvenance,
	loadCheckpointDecisionForLatestBoundary,
	normalizeCheckpointState,
	removeCheckpointMessages,
	removeCheckpointMessagesAndRemapIndex,
	renderCheckpointMessage,
} from "../provenance.ts";
import { TOOL_HORIZON_STATE_CUSTOM_TYPE, collectCompactedAwayMessages, type EventMessage } from "../core.ts";

const CWD = "/Users/example/project";

/**
 * Build an assistant tool call paired with its successful tool result

 * Args:
 *     id (string): Tool call id linking the call to its result
 *     name (string): Tool name as it appears in the payload
 *     args (Record<string, unknown>): Tool arguments
 *     result (object): Optional result content, details, and error flag

 * Returns:
 *     The two messages that record one completed tool call
 */
function toolCall(
	id: string,
	name: string,
	args: Record<string, unknown>,
	result: { text?: string; details?: unknown; isError?: boolean } = {},
): EventMessage[] {
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } as unknown as EventMessage,
		{
			role: "toolResult",
			toolCallId: id,
			content: [{ type: "text", text: result.text ?? "ok" }],
			...(result.details === undefined ? {} : { details: result.details }),
			...(result.isError === undefined ? {} : { isError: result.isError }),
		} as unknown as EventMessage,
	];
}

function applyPatchDetails(
	status: "success" | "partial_failure",
	result: Partial<{
		changedFiles: string[];
		createdFiles: string[];
		deletedFiles: string[];
		movedFiles: string[];
	}> = {},
): Record<string, unknown> {
	return {
		status,
		result: {
			changedFiles: [],
			createdFiles: [],
			deletedFiles: [],
			movedFiles: [],
			fuzz: 0,
			...result,
		},
	};
}

test("test_provider_wire_tool_id_aliases_are_not_session_tool_ids", () => {
	const messages: EventMessage[] = [
		{
			role: "assistant",
			content: [{ type: "toolCall", tool_call_id: "wire-id", name: "edit", arguments: { path: "src/model.ts" } }],
		},
		{
			role: "toolResult",
			tool_use_id: "wire-id",
			content: [{ type: "text", text: "ok" }],
		},
	];

	expect(detectFileProvenance(messages, CWD)).toEqual({
		read: [],
		modified: [],
		created: [],
		deleted: [],
		moved: [],
	});
});

test("nested file records and historical traces feed the provenance checkpoint", () => {
	const messages: EventMessage[] = [{ role: "toolResult", details: {
		codeMode: true, cellId: "cell", status: "result", traces: [],
		filesTouched: { version: 1, incomplete: false, calls: [
			{ toolCallId: "patch", actions: [{ kind: "touch", path: `${CWD}/created.ts`, operation: "create" }] },
		] },
	} }, { role: "toolResult", details: {
		codeMode: true, cellId: "other", status: "result", traces: [{
			id: "rp", name: "rp", input: { call: "apply_edits", args: { path: `${CWD}/edited.ts` } },
			status: "done", result: { content: [{ type: "text", text: "✅ Applied 1 edit" }] },
		}, {
			id: "rp-create", name: "rp", input: { call: "file_actions", args: { action: "create", path: `${CWD}/rp-created.ts` } },
			status: "done", result: { content: [{ type: "text", text: "## File Actions ✅" }] },
		}],
	} }];
	expect(detectFileProvenance(messages, CWD)).toEqual({
		read: [], modified: ["edited.ts"], created: ["created.ts", "rp-created.ts"], deleted: [], moved: [],
	});
});

describe("detectFileProvenance path canonicalization", () => {
	test("test_absolute_read_and_relative_edit_of_same_file_collapses_to_one_path", () => {
		const files = detectFileProvenance(
			[
				...toolCall("t1", "read", { path: `${CWD}/src/model.ts` }),
				...toolCall("t2", "rp", { call: "apply_edits", args: { path: "src/model.ts" } }),
			],
			CWD,
		);

		expect(files.modified).toEqual(["src/model.ts"]);
		expect(files.read).toEqual([]);
	});

	test("test_absolute_read_of_unmodified_file_under_cwd_is_relativized", () => {
		const files = detectFileProvenance([...toolCall("t1", "read", { path: `${CWD}/docs/guide.md` })], CWD);

		expect(files.read).toEqual(["docs/guide.md"]);
	});

	test("test_absolute_path_outside_cwd_stays_absolute", () => {
		const files = detectFileProvenance([...toolCall("t1", "read", { path: "/etc/hosts" })], CWD);

		expect(files.read).toEqual(["/etc/hosts"]);
	});

	test("test_read_of_genuinely_unmodified_file_survives_alongside_a_modified_one", () => {
		const files = detectFileProvenance(
			[
				...toolCall("t1", "read", { path: `${CWD}/src/reference.ts` }),
				...toolCall("t2", "edit", { path: "src/target.ts" }),
			],
			CWD,
		);

		expect(files.read).toEqual(["src/reference.ts"]);
		expect(files.modified).toEqual(["src/target.ts"]);
	});

	test("test_a_file_never_appears_in_both_read_and_modified", () => {
		const files = detectFileProvenance(
			[
				...toolCall("t1", "read", { path: `${CWD}/src/model.ts` }),
				...toolCall("t2", "rp", { call: "apply_edits", args: { path: "src/model.ts" } }),
				...toolCall("t3", "read", { path: "src/model.ts" }),
			],
			CWD,
		);

		const readSet = new Set(files.read);
		const overlap = files.modified.filter((path) => readSet.has(path));
		expect(overlap).toEqual([]);
	});

	test("test_root_prefixed_spelling_still_wins_over_cwd_relativization", () => {
		const files = detectFileProvenance(
			[
				...toolCall("t1", "rp", { call: "read_file", args: { path: "Project:src/model.ts" } }),
				...toolCall("t2", "read", { path: `${CWD}/src/model.ts` }),
			],
			CWD,
		);

		expect(files.read).toEqual(["Project:src/model.ts"]);
	});

	test("test_workspace_relative_paths_collapse_with_absolute_and_root_prefixed_spellings", () => {
		const workspaceRoot = "/Users/example/agent";
		const nestedCwd = `${workspaceRoot}/extensions/diligent-context`;
		const files = detectFileProvenance(
			[
				...toolCall("t1", "rp", {
					call: "file_actions",
					args: { action: "create", path: `${workspaceRoot}/extensions/tool-horizon/config.json` },
				}),
				...toolCall("t2", "rp", {
					call: "apply_edits",
					args: { path: "extensions/tool-horizon/config.json" },
				}),
				...toolCall("t3", "rp", { call: "read_file", args: { path: "agent/README.md" } }),
				...toolCall("t4", "rp", { call: "apply_edits", args: { path: "README.md" } }),
			],
			nestedCwd,
		);

		expect(files).toEqual({
			read: [],
			modified: ["agent:README.md"],
			created: ["agent:extensions/tool-horizon/config.json"],
			deleted: [],
			moved: [],
		});
	});

	test("test_cwd_and_workspace_relative_paths_remain_distinct_under_nested_cwd", () => {
		const workspaceRoot = "/Users/example/agent";
		const nestedCwd = `${workspaceRoot}/extensions/diligent-context`;
		const files = detectFileProvenance(
			[
				...toolCall("t1", "rp", {
					call: "file_actions",
					args: { action: "create", path: `${workspaceRoot}/extensions/tool-horizon/config.json` },
				}),
				...toolCall("t2", "rp", {
					call: "apply_edits",
					args: { path: "extensions/tool-horizon/config.json" },
				}),
				...toolCall("t3", "edit", { path: "notes.md" }),
				...toolCall("t4", "rp", { call: "apply_edits", args: { path: "notes.md" } }),
			],
			nestedCwd,
		);

		expect(files.modified).toEqual([
			"agent:extensions/diligent-context/notes.md",
			"agent:notes.md",
		]);
	});
});

describe("detectFileProvenance Codex tools", () => {
	test("test_exec_command_actions_map_to_provenance_categories", () => {
		const files = detectFileProvenance(
			toolCall("t1", "exec_command", {
				cmd: [
					"cat docs/reference.md",
					"sed -i 's/old/new/' src/config.ts",
					"touch src/generated.ts",
					"rm src/removed.ts",
					"mv src/old.ts src/moved.ts",
				].join(" && "),
			}),
			CWD,
		);

		expect(files).toEqual({
			read: ["docs/reference.md"],
			modified: ["src/config.ts", "src/generated.ts"],
			created: [],
			deleted: ["src/removed.ts"],
			moved: [{ from: "src/old.ts", to: "src/moved.ts" }],
		});
	});

	test("test_exec_command_honors_workdir_failure_and_no_op_semantics", () => {
		const files = detectFileProvenance(
			[
				...toolCall(
					"t1",
					"exec_command",
					{ cmd: "cat src/index.ts", workdir: "packages/app" },
					{ details: { exit_code: 7 } },
				),
				...toolCall("t2", "exec_command", { cmd: "cat docs/failed.md" }, { isError: true }),
				...toolCall(
					"t3",
					"exec_command",
					{ cmd: "cat docs/kept.md && touch src/noop.ts" },
					{ text: "No changes applied" },
				),
			],
			CWD,
		);

		expect(files.read).toEqual(["packages/app/src/index.ts", "docs/kept.md"]);
		expect(files.modified).toEqual([]);
		expect(files.read).not.toContain("docs/failed.md");
	});

	test("test_exec_command_parent_traversal_clamps_to_checkpoint_root", () => {
		const files = detectFileProvenance(
			toolCall("t1", "exec_command", { cmd: "cat etc/hosts", workdir: ".." }),
			"/",
		);

		expect(files.read).toEqual(["etc/hosts"]);
	});

	test("test_apply_patch_actions_map_to_provenance_categories", () => {
		const patch = [
			"*** Begin Patch",
			"*** Add File: src/new.ts",
			"+new",
			"*** Add File: src/overwritten.ts",
			"+replacement",
			`*** Update File: ${CWD}/src/config.ts`,
			"@@",
			"-old",
			"+new",
			"*** Delete File: src/removed.ts",
			`*** Update File: ${CWD}/src/old.ts`,
			`*** Move to: ${CWD}/src/moved.ts`,
			"@@",
			" unchanged",
			"*** End Patch",
		].join("\n");
		const files = detectFileProvenance(
			toolCall(
				"t1",
				"apply_patch",
				{ input: patch },
				{
					details: applyPatchDetails("success", {
						changedFiles: [
							"src/new.ts",
							"src/overwritten.ts",
							"src/config.ts",
							"src/removed.ts",
							"src/old.ts",
							"src/moved.ts",
						],
						createdFiles: ["src/new.ts", "src/moved.ts"],
						deletedFiles: ["src/removed.ts", "src/old.ts"],
						movedFiles: ["src/old.ts -> src/moved.ts"],
					}),
				},
			),
			CWD,
		);

		expect(files).toEqual({
			read: [],
			modified: ["src/overwritten.ts", "src/config.ts"],
			created: ["src/new.ts"],
			deleted: ["src/removed.ts"],
			moved: [{ from: "src/old.ts", to: "src/moved.ts" }],
		});
	});

	test("test_partial_apply_patch_retains_only_completed_structured_effects", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/applied.ts",
			"@@",
			"-old",
			"+new",
			"*** Update File: src/failed.ts",
			"@@",
			"-old",
			"+new",
			"*** Update File: src/old.ts",
			"*** Move to: src/moved.ts",
			"@@",
			" unchanged",
			"*** End Patch",
		].join("\n");
		const files = detectFileProvenance(
			[
				...toolCall("t1", "apply_patch", { input: patch }, {
					text: "No changes applied",
					isError: true,
					details: applyPatchDetails("partial_failure", {
						changedFiles: ["src/applied.ts", "src/old.ts", "src/moved.ts"],
						createdFiles: ["src/moved.ts"],
						deletedFiles: ["src/old.ts"],
						movedFiles: ["src/old.ts -> src/moved.ts"],
					}),
				}),
				...toolCall("t2", "apply_patch", { input: patch }, { isError: true }),
			],
			CWD,
		);

		expect(files.modified).toEqual(["src/applied.ts"]);
		expect(files.modified).not.toContain("src/failed.ts");
		expect(files.moved).toEqual([{ from: "src/old.ts", to: "src/moved.ts" }]);
	});
});

describe("renderCheckpointMessage", () => {
	test("test_unmodified_state_is_scoped_to_the_read_section", () => {
		const state = buildCheckpointState({
			messages: [
				...toolCall("t1", "read", { path: `${CWD}/docs/guide.md` }),
				...toolCall("t2", "edit", { path: "src/model.ts" }),
			],
			boundaryMode: "from-entry",
			boundarySignature: "test-boundary",
			cwd: CWD,
		});
		expect(state).not.toBeNull();
		const rendered = renderCheckpointMessage(state!);

		expect(rendered).toContain("<read state=\"unmodified\">");
		expect(rendered).not.toContain("state=\"read-and-unmodified\"");
		expect(rendered.split("\n")[0]).not.toContain("state=");
		expect(rendered).toContain(
			"<use>Use the current request and retained conversation to identify only the listed paths needed for remaining work; inspect their current state before relying on prior observations. Do not inspect paths merely because they appear here.</use>",
		);
		expect(rendered).toContain("docs/guide.md");
		expect(rendered).toContain("src/model.ts");
	});

	test("test_checkpoint_xml_escapes_paths_and_embedded_line_breaks", () => {
		const rendered = renderCheckpointMessage({
			version: 1,
			scope: "before-boundary",
			boundaryMode: "from-entry",
			boundarySignature: "test-boundary",
			generatedAt: 0,
			files: {
				read: ["src/</read><instructions>&\nattack"],
				modified: [],
				created: [],
				deleted: [],
				moved: [{ from: "old<&\rname", to: "new>\nname" }],
			},
		}, "Inspect <needed> paths & current state.\nDo not bulk-read.");

		expect(rendered).toContain("<use>Inspect &lt;needed&gt; paths &amp; current state.&#10;Do not bulk-read.</use>");
		expect(rendered).toContain("src/&lt;/read&gt;&lt;instructions&gt;&amp;&#10;attack");
		expect(rendered).toContain("old&lt;&amp;&#13;name => new&gt;&#10;name");
		expect(rendered).not.toContain("<instructions>");
		expect(rendered.split("\n")).toHaveLength(11);
	});
});

describe("checkpoint-free canonical payload", () => {
	const checkpoint = (boundarySignature: string) => buildCheckpointState({
		messages: toolCall("t1", "edit", { path: "src/model.ts" }),
		boundaryMode: "from-entry",
		boundarySignature,
		generatedAt: 1,
		cwd: CWD,
	})!;

	const checkpointMessage = (details: ReturnType<typeof checkpoint>): EventMessage => ({
		role: "custom",
		customType: TOOL_HORIZON_CHECKPOINT_MESSAGE_CUSTOM_TYPE,
		content: renderCheckpointMessage(details),
		details,
	} as EventMessage);

	test("test_noncanonical_checkpoint_message_type_is_preserved", () => {
		const formerCheckpoint = {
			role: "custom",
			customType: "context-checkpoint",
			content: "<checkpoint/>",
		} as EventMessage;
		const result = removeCheckpointMessages([formerCheckpoint]);

		expect(result.changed).toBe(false);
		expect(result.messages).toEqual([formerCheckpoint]);
	});

	test("test_checkpoint_removal_remaps_a_selected_duplicate_before_fingerprinting", () => {
		const oldCheckpoint = checkpointMessage(checkpoint("boundary-a"));
		const first = { role: "user", content: [{ type: "text", text: "repeat" }] } as EventMessage;
		const second = { role: "user", content: [{ type: "text", text: "repeat" }] } as EventMessage;

		const canonical = removeCheckpointMessagesAndRemapIndex([oldCheckpoint, first, second], 1);
		expect(canonical).not.toBeNull();
		expect(canonical?.rawIndex).toBe(0);
		expect(canonical?.messages).toEqual([first, second]);
	});
});

describe("normalizeCheckpointState on load", () => {
	const persisted = (files: Record<string, unknown>) => ({
		version: 1,
		scope: "before-boundary",
		boundaryMode: "from-entry",
		boundarySignature: "test-boundary",
		generatedAt: 0,
		files: { read: [], modified: [], created: [], deleted: [], moved: [], ...files },
	});

	test("test_mixed_absence_and_present_checkpoint_is_invalid", () => {
		const entries = [
			{
				id: "checkpoint",
				type: "custom",
				customType: TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
				data: { ...persisted({ modified: ["src/model.ts"] }), state: "absent" },
			},
			{ id: "boundary", type: "custom", customType: TOOL_HORIZON_STATE_CUSTOM_TYPE, data: { enabled: true } },
		];

		expect(loadCheckpointDecisionForLatestBoundary(entries as any, TOOL_HORIZON_STATE_CUSTOM_TYPE, CWD).kind).toBe("invalid");
	});

	test("test_absence_tombstone_with_extra_fields_is_invalid", () => {
		const entries = [
			{
				id: "checkpoint",
				type: "custom",
				customType: TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
				data: { ...TOOL_HORIZON_CHECKPOINT_ABSENCE_STATE, extra: true },
			},
			{ id: "boundary", type: "custom", customType: TOOL_HORIZON_STATE_CUSTOM_TYPE, data: { enabled: true } },
		];

		expect(loadCheckpointDecisionForLatestBoundary(entries as any, TOOL_HORIZON_STATE_CUSTOM_TYPE, CWD).kind).toBe("invalid");
	});

	test("test_checkpoint_with_former_anchor_fields_is_invalid", () => {
		const entries = [
			{
				id: "checkpoint",
				type: "custom",
				customType: TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE,
				data: {
					...persisted({ modified: ["src/model.ts"] }),
					anchorMode: "from-entry",
					anchorSignature: "former",
				},
			},
			{ id: "boundary", type: "custom", customType: TOOL_HORIZON_STATE_CUSTOM_TYPE, data: { enabled: true } },
		];

		expect(loadCheckpointDecisionForLatestBoundary(entries as any, TOOL_HORIZON_STATE_CUSTOM_TYPE, CWD).kind).toBe("invalid");
	});

	test("test_checkpoint_persisted_with_mixed_spellings_is_repaired_on_load", () => {
		const loaded = normalizeCheckpointState(
			persisted({ read: [`${CWD}/src/model.ts`], modified: ["src/model.ts"] }),
			CWD,
		);

		expect(loaded?.files.read).toEqual([]);
		expect(loaded?.files.modified).toEqual(["src/model.ts"]);
	});

	test("test_normalization_on_load_is_idempotent_for_current_checkpoints", () => {
		const original = buildCheckpointState({
			messages: [
				...toolCall("t1", "read", { path: `${CWD}/docs/guide.md` }),
				...toolCall("t2", "edit", { path: "src/model.ts" }),
			],
			boundaryMode: "from-entry",
			boundarySignature: "test-boundary",
			cwd: CWD,
		});
		const reloaded = normalizeCheckpointState(JSON.parse(JSON.stringify(original)), CWD);

		expect(reloaded?.files).toEqual(original!.files);
	});

	test("test_distinct_newline_paths_do_not_collide_in_move_deduplication", () => {
		const loaded = normalizeCheckpointState(persisted({
			moved: [
				{ from: "a\nb", to: "c" },
				{ from: "a", to: "b\nc" },
			],
		}), CWD);

		expect(loaded?.files.moved).toHaveLength(2);
		const rendered = renderCheckpointMessage(loaded!);
		expect(rendered).toContain("a&#10;b => c");
		expect(rendered).toContain("a => b&#10;c");
	});

	test("test_malformed_canonical_checkpoint_fields_are_rejected", () => {
		const canonical = persisted({ modified: ["src/model.ts"] });
		const invalidRecords = [
			{ ...canonical, generatedAt: "now" },
			{ ...canonical, files: { modified: ["src/model.ts"] } },
			{ ...canonical, files: { ...canonical.files, read: ["docs/guide.md", 42] } },
			{ ...canonical, files: { ...canonical.files, moved: [{ from: "old.ts" }] } },
			{ ...canonical, files: { ...canonical.files, moved: [{ from: "", to: "new.ts" }] } },
		];

		for (const record of invalidRecords) expect(normalizeCheckpointState(record, CWD)).toBeNull();
	});

	test("test_collapsing_the_read_bucket_never_discards_the_remaining_provenance", () => {
		const loaded = normalizeCheckpointState(
			persisted({ read: [`${CWD}/src/a.ts`, "src/a.ts"], modified: ["src/a.ts"] }),
			CWD,
		);

		expect(loaded).not.toBeNull();
		expect(loaded?.files.read).toEqual([]);
		expect(loaded?.files.modified).toEqual(["src/a.ts"]);
	});

	test("test_latest_boundary_consumes_only_its_immediately_preceding_checkpoint", () => {
		const checkpointA = { ...persisted({ modified: ["src/a.ts"] }), boundarySignature: "boundary-a" };
		const checkpointB = { ...persisted({ modified: ["src/b.ts"] }), boundarySignature: "boundary-b" };
		const entries = [
			{ id: "ca", type: "custom", customType: TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE, data: checkpointA },
			{ id: "aa", type: "custom", customType: TOOL_HORIZON_STATE_CUSTOM_TYPE, data: { enabled: true } },
			{ id: "cb", type: "custom", customType: TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE, data: checkpointB },
		];

		const decision = loadCheckpointDecisionForLatestBoundary(entries as any, TOOL_HORIZON_STATE_CUSTOM_TYPE, CWD);
		expect(decision.kind).toBe("present");
		if (decision.kind === "present") expect(decision.checkpoint.boundarySignature).toBe("boundary-a");
	});

	test("test_explicit_absence_is_distinct_from_an_invalid_pair", () => {
		const paired = [
			{ id: "absence", type: "custom", customType: TOOL_HORIZON_CHECKPOINT_STATE_CUSTOM_TYPE, data: TOOL_HORIZON_CHECKPOINT_ABSENCE_STATE },
			{ id: "boundary", type: "custom", customType: TOOL_HORIZON_STATE_CUSTOM_TYPE, data: { enabled: true } },
		];
		const missing = [
			{ id: "former", type: "custom", customType: "diligent-context-checkpoint-state", data: TOOL_HORIZON_CHECKPOINT_ABSENCE_STATE },
			{ id: "boundary", type: "custom", customType: TOOL_HORIZON_STATE_CUSTOM_TYPE, data: { enabled: true } },
		];

		expect(loadCheckpointDecisionForLatestBoundary(paired as any, TOOL_HORIZON_STATE_CUSTOM_TYPE, CWD).kind).toBe("absent");
		expect(loadCheckpointDecisionForLatestBoundary(missing as any, TOOL_HORIZON_STATE_CUSTOM_TYPE, CWD).kind).toBe("invalid");
	});
});
describe("provenance hidden by compaction", () => {
	const messageEntry = (id: string, message: unknown) => ({
		id,
		parentId: null,
		type: "message",
		timestamp: "2026-01-01T00:00:00.000Z",
		message,
	});

	const compactionEntry = (id: string, firstKeptEntryId: string | undefined) => ({
		id,
		parentId: null,
		type: "compaction",
		timestamp: "2026-01-01T00:00:00.000Z",
		summary: "summary",
		tokensBefore: 100,
		firstKeptEntryId,
	});

	const linearBranch = (entries: any[]): any[] => entries.map((entry, index) => ({
		...entry,
		parentId: index > 0 ? entries[index - 1].id : null,
	}));

	const compactedAway = (branch: any[]): EventMessage[] => (
		collectCompactedAwayMessages(branch, branch.at(-1)?.id ?? null)
	);

	/**
	 * Build a branch where one tool call is compacted away and another remains in the payload

	 * Returns:
	 *     Branch entries oldest first, with the compaction entry following the dropped range
	 */
	function branchWithCompaction(): any[] {
		const [droppedCall, droppedResult] = toolCall("t1", "edit", { path: "src/early.ts" });
		const [keptCall, keptResult] = toolCall("t2", "edit", { path: "src/late.ts" });
		return linearBranch([
			messageEntry("e1", droppedCall),
			messageEntry("e2", droppedResult),
			messageEntry("e3", keptCall),
			messageEntry("e4", keptResult),
			compactionEntry("c1", "e3"),
		]);
	}

	test("test_messages_hidden_by_compaction_are_recovered_from_the_branch", () => {
		expect(detectFileProvenance(compactedAway(branchWithCompaction()), CWD).modified).toEqual(["src/early.ts"]);
	});

	test("test_messages_kept_by_compaction_are_not_treated_as_hidden", () => {
		expect(detectFileProvenance(compactedAway(branchWithCompaction()), CWD).modified).not.toContain("src/late.ts");
	});

	test("test_branch_ending_at_the_compaction_entry_still_recovers_hidden_history", () => {
		const branch = branchWithCompaction();

		expect(detectFileProvenance(compactedAway(branch), CWD).modified).toEqual(["src/early.ts"]);
	});

	test("test_branch_without_compaction_hides_nothing", () => {
		const branch = linearBranch([messageEntry("e1", { role: "user", content: [] })]);
		expect(compactedAway(branch)).toEqual([]);
	});

	test("test_absent_first_kept_id_treats_the_whole_prefix_as_hidden", () => {
		const branch = linearBranch([
			...branchWithCompaction().slice(0, 4),
			compactionEntry("c1", undefined),
		]);

		expect(detectFileProvenance(compactedAway(branch), CWD).modified).toEqual([
			"src/early.ts",
			"src/late.ts",
		]);
	});

	test("test_latest_compaction_governs_and_earlier_hidden_work_is_retained", () => {
		const [firstCall, firstResult] = toolCall("t1", "edit", { path: "src/first.ts" });
		const [secondCall, secondResult] = toolCall("t2", "edit", { path: "src/second.ts" });
		const [thirdCall, thirdResult] = toolCall("t3", "edit", { path: "src/third.ts" });
		const branch = linearBranch([
			messageEntry("e1", firstCall),
			messageEntry("e2", firstResult),
			compactionEntry("c1", "e1"),
			messageEntry("e3", secondCall),
			messageEntry("e4", secondResult),
			messageEntry("e5", thirdCall),
			messageEntry("e6", thirdResult),
			compactionEntry("c2", "e5"),
		]);

		const hidden = detectFileProvenance(compactedAway(branch), CWD);
		expect(hidden.modified).toEqual(["src/first.ts", "src/second.ts"]);
		expect(hidden.modified).not.toContain("src/third.ts");
	});

	test("test_checkpoint_reports_work_hidden_before_the_compaction", () => {
		const state = buildCheckpointState({
			messages: toolCall("t9", "edit", { path: "src/late.ts" }),
			compactedAwayMessages: compactedAway(branchWithCompaction()),
			boundaryMode: "from-entry",
			boundarySignature: "test-boundary",
			cwd: CWD,
		});

		expect(state?.files.modified).toEqual(["src/early.ts", "src/late.ts"]);
	});

	test("test_file_read_before_compaction_and_edited_after_is_reported_as_modified_only", () => {
		const state = buildCheckpointState({
			messages: toolCall("t2", "edit", { path: "src/model.ts" }),
			compactedAwayMessages: toolCall("t1", "read", { path: `${CWD}/src/model.ts` }),
			boundaryMode: "from-entry",
			boundarySignature: "test-boundary",
			cwd: CWD,
		});

		expect(state?.files.modified).toEqual(["src/model.ts"]);
		expect(state?.files.read).toEqual([]);
	});

	test("test_root_prefixed_hidden_path_and_relative_current_path_collapse_to_one_identity", () => {
		// Detecting both ranges in one pass keeps the inferred root mappings available to every path,
		// which a merge of two separately normalized records could not do.
		const state = buildCheckpointState({
			messages: toolCall("t3", "edit", { path: "src/model.ts" }),
			compactedAwayMessages: [
				...toolCall("t1", "rp", { call: "read_file", args: { path: "Project:src/model.ts" } }),
				...toolCall("t2", "read", { path: `${CWD}/src/model.ts` }),
			],
			boundaryMode: "from-entry",
			boundarySignature: "test-boundary",
			cwd: CWD,
		});

		expect(state?.files.modified).toEqual(["Project:src/model.ts"]);
		expect(state?.files.read).toEqual([]);
	});

	test("test_checkpoint_exists_when_only_compacted_away_work_has_content", () => {
		const state = buildCheckpointState({
			messages: [],
			compactedAwayMessages: toolCall("t1", "edit", { path: "src/early.ts" }),
			boundaryMode: "from-entry",
			boundarySignature: "test-boundary",
			cwd: CWD,
		});

		expect(state?.files.modified).toEqual(["src/early.ts"]);
	});
});

describe("relativizeToCwd boundaries", () => {
	test("test_absolute_path_under_posix_root_cwd_is_relative", () => {
		expect(detectFileProvenance([...toolCall("t1", "read", { path: "/etc/hosts" })], "/").read).toEqual(["etc/hosts"]);
	});

	test("test_absolute_path_under_windows_drive_root_cwd_is_relative", () => {
		expect(detectFileProvenance([...toolCall("t1", "read", { path: "C:/src/a.ts" })], "C:/").read).toEqual(["src/a.ts"]);
	});

	test("test_windows_root_prefixed_and_absolute_paths_collapse_to_one_identity", () => {
		const files = detectFileProvenance(
			[
				...toolCall("t1", "rp", { call: "read_file", args: { path: "Project:src/model.ts" } }),
				...toolCall("t2", "edit", { path: "C:/work/src/model.ts" }),
			],
			"C:/work",
		);

		expect(files.read).toEqual([]);
		expect(files.modified).toEqual(["Project:src/model.ts"]);
	});

	test("test_known_root_at_posix_filesystem_root_collapses_to_one_identity", () => {
		const files = detectFileProvenance(
			[
				...toolCall("t1", "rp", { call: "read_file", args: { path: "Root:src/model.ts" } }),
				...toolCall("t2", "edit", { path: "/src/model.ts" }),
			],
			"/",
		);

		expect(files.read).toEqual([]);
		expect(files.modified).toEqual(["Root:src/model.ts"]);
	});

	test("test_known_root_at_windows_drive_root_collapses_to_one_identity", () => {
		const files = detectFileProvenance(
			[
				...toolCall("t1", "rp", { call: "read_file", args: { path: "Drive:src/model.ts" } }),
				...toolCall("t2", "edit", { path: "C:/src/model.ts" }),
			],
			"C:/",
		);

		expect(files.read).toEqual([]);
		expect(files.modified).toEqual(["Drive:src/model.ts"]);
	});

	test("test_windows_drive_letter_case_collapses_to_one_identity", () => {
		const files = detectFileProvenance(
			[
				...toolCall("t1", "read", { path: "C:/work/src/model.ts" }),
				...toolCall("t2", "edit", { path: "c:/work/src/model.ts" }),
			],
			"C:/work",
		);

		expect(files.read).toEqual([]);
		expect(files.modified).toEqual(["src/model.ts"]);
	});
});
