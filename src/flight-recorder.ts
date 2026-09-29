// Flight recorder: the last FLIGHT_RECORDER_SIZE events of one query, kept so
// an incident can show the order in which things happened. Always on, so it
// sits on the stream's hot path: record() does no I/O and no formatting, and
// allocates at most the one small record. Records carry metadata only (a kind
// constant, a tool or block id, a block index, a count), never content.

import { performance } from "node:perf_hooks";

export const FLIGHT_RECORDER_SIZE = 256;

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
const COALESCED_KINDS = new Set(["content_block_delta"]);

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

	record(kind: string, id?: string, index?: number, n?: number): void {
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

const prefixedKinds = new Map<string, Map<string, string>>();

/** `${prefix}_${name}` for an SDK enum value, built once per distinct value so
 *  the stream loop formats nothing after the first occurrence. */
export function prefixedKind(prefix: string, name: unknown): string {
	if (typeof name !== "string" || name.length === 0 || name.length > 64) return prefix;
	let byName = prefixedKinds.get(prefix);
	if (byName === undefined) {
		byName = new Map();
		prefixedKinds.set(prefix, byName);
	}
	let kind = byName.get(name);
	if (kind === undefined) {
		kind = `${prefix}_${name}`;
		byName.set(name, kind);
	}
	return kind;
}
