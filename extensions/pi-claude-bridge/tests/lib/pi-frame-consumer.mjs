// Pi's contract for a provider's assistant event stream, for tests that must
// hold the bridge to it:
//
// - Pi consumes each event after the provider produced it (it awaits session
//   writes between events), and coding-agent's toJsonEvent (RPC/JSON mode)
//   then reads the live partial's block at a toolcall_start's index. So every
//   queued event must still make sense against the live partial as it is
//   later: a block keeps its index and its type.
// - The stream is append-only: one start, each block starts once at the next
//   index, its deltas and end follow its start, and nothing follows done or
//   error. Pi 1.5 no longer checks this itself; pi-ai's frame encoder and
//   reducer, which did, are gone. piConsumer checks it and rebuilds the blocks
//   a consumer saw (the snapshot).
//
// The persisted message is the done message (stream.result()).
import assert from "node:assert/strict";

const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { toJsonEvent } = await import(new URL("./modes/json-event.js", codingAgentEntry).href);

const KINDS = { text: "text", thinking: "thinking", toolcall: "toolCall" };

/** Consumes events as Pi does and throws where the stream breaks Pi's
 *  contract. `snapshot.content` holds the blocks as consumed: a start copies
 *  the live block, deltas the live block did not yet hold are appended, and
 *  an end takes the event's final content. */
export function piConsumer() {
	const snapshot = { content: [] };
	const open = new Map();
	let started = false;
	let ended = false;
	return {
		snapshot,
		consume(event) {
			assert.ok(!ended, `${event.type} follows a terminal event`);
			if (event.type === "start") {
				assert.ok(!started, "more than one start event");
				started = true;
				return;
			}
			if (event.type === "done" || event.type === "error") {
				ended = true;
				return;
			}
			assert.ok(started, `${event.type} before start`);
			const [prefix, phase] = event.type.split("_");
			const kind = KINDS[prefix];
			const index = event.contentIndex;
			toJsonEvent({ type: "message_update", message: { ...event.partial }, assistantMessageEvent: event });
			const live = event.partial.content[index];
			assert.equal(live?.type, kind, `${event.type} points to a ${live?.type} block at index ${index}`);
			const field = kind === "text" ? "text" : "thinking";
			if (phase === "start") {
				assert.equal(index, snapshot.content.length, `block ${index} does not start at the next index`);
				snapshot.content.push(kind === "toolCall"
					? { type: kind, id: live.id, name: live.name, arguments: structuredClone(live.arguments) }
					: { type: kind, [field]: live[field] });
				open.set(index, { covered: kind === "toolCall" ? 0 : live[field].length, seen: 0 });
				return;
			}
			const state = open.get(index);
			assert.ok(state, `${event.type} at index ${index} has no open block`);
			const block = snapshot.content[index];
			if (phase === "delta") {
				if (kind === "toolCall") return;
				block[field] += event.delta.slice(Math.max(0, state.covered - state.seen));
				state.seen += event.delta.length;
				return;
			}
			open.delete(index);
			if (kind === "toolCall") Object.assign(block, { id: event.toolCall.id, name: event.toolCall.name, arguments: structuredClone(event.toolCall.arguments) });
			else block[field] = event.content;
		},
	};
}

/** Consume `events` in order, after the stream ended (maximum lag). */
export function encodeLikePi(events) {
	const consumer = piConsumer();
	for (const event of events) consumer.consume(event);
	return { snapshot: consumer.snapshot };
}

/** A Pi-like consumer of a live provider stream: consumes each event after
 *  an await, like Pi, so it sees whatever the provider has done to the
 *  partial since. Returns the events, the snapshots of both the as-consumed
 *  and the maximum-lag orders, and the final (persisted) message. */
export async function consumeLikePi(stream) {
	const events = [];
	const eager = piConsumer();
	for await (const event of stream) {
		events.push(event);
		await Promise.resolve();
		eager.consume(event);
	}
	const lagged = encodeLikePi(events);
	const final = await stream.result?.();
	return { events, eagerSnapshot: eager.snapshot, laggedSnapshot: lagged.snapshot, final };
}
