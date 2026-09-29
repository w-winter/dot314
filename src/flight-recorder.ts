// Flight recorder: the last FLIGHT_RECORDER_SIZE events of one query, kept so
// an incident can show the order in which things happened. Always on, so it
// sits on the stream's hot path: record() does no I/O and no formatting, and
// allocates at most the one small record. Records carry metadata only (a kind
// constant, a tool or block id, a block index, a count), never content.

import { performance } from "node:perf_hooks";
import {
	SDK_MESSAGE_TYPES, SDK_RESULT_SUBTYPES, SDK_STREAM_EVENT_TYPES, SDK_SYSTEM_SUBTYPES,
	type SdkMessageType, type SdkResultSubtype, type SdkStreamEventType, type SdkSystemSubtype,
} from "./incident-labels.js";

export const FLIGHT_RECORDER_SIZE = 256;

// The kinds the bridge records itself.
const BRIDGE_KINDS = [
	"query_start", "abort", "idle_timeout", "lane_quarantine", "continuation_start", "teardown", "handlers_drained",
	"turn_done", "turn_aborted", "turn_error", "turn_end_tool_use", "failure_held", "grace_elapsed",
	"tools_call", "tools_cancel", "tools_answer", "claim", "claim_unmatched", "claim_waiting", "claim_dead", "claim_answered",
	"claim_withdrawn", "claim_other_tool", "callback", "cursor", "steer_live",
	"result_taken_early", "result_queued", "result_delivered", "result_unmatched", "results_parked",
] as const;

// An SDK message type, subtype or stream event the bridge does not handle
// (incident-labels.ts): recorded under its type, never as its own text.
const UNKNOWN_SDK_KINDS = ["message_[unknown]", "system_[unknown]", "result_[unknown]", "stream_event_[unknown]"] as const;

type OtherSdkMessageType = Exclude<SdkMessageType, "system" | "result" | "stream_event">;

/** Every kind a flight record can have: the bridge's own, the SDK messages
 *  and stream events the bridge handles, and the unknown placeholders. */
export type RecorderKind =
	| typeof BRIDGE_KINDS[number]
	| OtherSdkMessageType
	| SdkStreamEventType
	| `system_${SdkSystemSubtype}`
	| `result_${SdkResultSubtype}`
	| typeof UNKNOWN_SDK_KINDS[number];

const OTHER_SDK_MESSAGE_TYPES = SDK_MESSAGE_TYPES.filter((type): type is OtherSdkMessageType => type !== "system" && type !== "result" && type !== "stream_event");
const SYSTEM_KINDS = new Map<unknown, RecorderKind>(SDK_SYSTEM_SUBTYPES.map((subtype) => [subtype, `system_${subtype}` as const]));
const RESULT_KINDS = new Map<unknown, RecorderKind>(SDK_RESULT_SUBTYPES.map((subtype) => [subtype, `result_${subtype}` as const]));
const STREAM_EVENT_KINDS = new Map<unknown, RecorderKind>(SDK_STREAM_EVENT_TYPES.map((type) => [type, type]));
const MESSAGE_KINDS = new Map<unknown, RecorderKind>(OTHER_SDK_MESSAGE_TYPES.map((type) => [type, type]));

export const RECORDER_KINDS: readonly RecorderKind[] = [
	...BRIDGE_KINDS,
	...MESSAGE_KINDS.values(),
	...STREAM_EVENT_KINDS.values(),
	...SYSTEM_KINDS.values(),
	...RESULT_KINDS.values(),
	...UNKNOWN_SDK_KINDS,
];

/** The recorder kind of an SDK message: its stream event type,
 *  `system_<subtype>`, `result_<subtype>` or its message type, when the bridge
 *  handles it; else `<type>_[unknown]` (`message_[unknown]` for a message
 *  type). A lookup, no formatting: it runs per streamed token. */
export function sdkRecorderKind(message: { type?: unknown; subtype?: unknown; event?: { type?: unknown } }): RecorderKind {
	switch (message.type) {
		case "stream_event": return STREAM_EVENT_KINDS.get(message.event?.type) ?? "stream_event_[unknown]";
		case "system": return SYSTEM_KINDS.get(message.subtype) ?? "system_[unknown]";
		case "result": return RESULT_KINDS.get(message.subtype) ?? "result_[unknown]";
		default: return MESSAGE_KINDS.get(message.type) ?? "message_[unknown]";
	}
}

export interface FlightRecord {
	/** ms since the query started. */
	t: number;
	kind: string;
	id?: string;
	index?: number;
	n?: number;
}

// A delta per streamed token would push everything else out of the ring:
// consecutive deltas of one block share a record and count up in `n`.
const COALESCED_KINDS: ReadonlySet<string> = new Set<RecorderKind>(["content_block_delta"]);

export class FlightRecorder {
	private readonly slots: Array<FlightRecord | undefined> = new Array(FLIGHT_RECORDER_SIZE);
	private next = 0;
	private size = 0;
	private start = performance.now();
	private last: FlightRecord | undefined;

	/** Starts a new query: forgets every record. */
	reset(): void {
		this.slots.fill(undefined);
		this.next = 0;
		this.size = 0;
		this.last = undefined;
		this.start = performance.now();
	}

	record(kind: RecorderKind, id?: string, index?: number, n?: number): void {
		const last = this.last;
		if (last !== undefined && last.kind === kind && last.index === index && COALESCED_KINDS.has(kind)) {
			last.n = (last.n ?? 1) + 1;
			return;
		}
		const entry: FlightRecord = { t: Math.round(performance.now() - this.start), kind };
		if (id !== undefined) entry.id = id;
		if (index !== undefined) entry.index = index;
		if (n !== undefined) entry.n = n;
		this.slots[this.next] = entry;
		this.next = (this.next + 1) % FLIGHT_RECORDER_SIZE;
		if (this.size < FLIGHT_RECORDER_SIZE) this.size += 1;
		this.last = entry;
	}

	/** The records, oldest first, as copies (a coalesced record keeps counting). */
	snapshot(): FlightRecord[] {
		const out: FlightRecord[] = [];
		const first = (this.next - this.size + FLIGHT_RECORDER_SIZE) % FLIGHT_RECORDER_SIZE;
		for (let i = 0; i < this.size; i++) {
			const entry = this.slots[(first + i) % FLIGHT_RECORDER_SIZE];
			if (entry) out.push({ ...entry });
		}
		return out;
	}
}
