// Pi's REAL consumers of a provider's assistant event stream, for tests that
// must hold the bridge to Pi's actual contract instead of a handwritten model:
//
// - pi-ai's AssistantMessageFrameEncoder, which coding-agent's
//   openAssistantResponse runs on every event. It reads `event.partial` WHEN
//   THE EVENT IS CONSUMED, and the consumer lags the producer (it awaits
//   session writes between events), so every queued event must still make
//   sense against the live partial as it is later.
// - pi-ai's reduceAssistantMessageFrames, which rebuilds streaming snapshots
//   and interrupted-response recovery from those frames. It is append-only:
//   every start must be at the current content length.
// - coding-agent's toJsonEvent (RPC/JSON mode), which reads the partial's
//   block for every toolcall_start.
//
// The persisted message is the done message (stream.result()); frames only
// feed snapshots and recovery.
import { AssistantMessageFrameEncoder, reduceAssistantMessageFrames } from "@earendil-works/pi-ai";

const codingAgentEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { toJsonEvent } = await import(new URL("./modes/json-event.js", codingAgentEntry).href);

const UPDATE_TYPES = new Set([
	"text_start", "text_delta", "text_end",
	"thinking_start", "thinking_delta", "thinking_end",
	"toolcall_start", "toolcall_delta", "toolcall_end",
]);

/** Encode `events` exactly as Pi does, in order. Throws where Pi would. */
export function encodeLikePi(events) {
	const encoder = new AssistantMessageFrameEncoder();
	const frames = [];
	for (const event of events) {
		const frame = encoder.encode(event);
		if (frame !== undefined) frames.push(frame);
		if (UPDATE_TYPES.has(event.type)) {
			toJsonEvent({ type: "message_update", message: { ...event.partial }, assistantMessageEvent: event });
		}
	}
	return { frames, snapshot: reduceAssistantMessageFrames(frames) };
}

/** A Pi-like consumer of a live provider stream: encodes each event as it is
 *  consumed (after an await, like Pi), so it sees whatever the provider has
 *  done to the partial since. Returns the events, the frames of both the
 *  as-consumed and the maximum-lag (everything encoded after the stream
 *  ended) orders, and the final (persisted) message. */
export async function consumeLikePi(stream) {
	const events = [];
	const eagerEncoder = new AssistantMessageFrameEncoder();
	const eagerFrames = [];
	for await (const event of stream) {
		events.push(event);
		await Promise.resolve();
		const frame = eagerEncoder.encode(event);
		if (frame !== undefined) eagerFrames.push(frame);
		if (UPDATE_TYPES.has(event.type)) {
			toJsonEvent({ type: "message_update", message: { ...event.partial }, assistantMessageEvent: event });
		}
	}
	const eagerSnapshot = reduceAssistantMessageFrames(eagerFrames);
	const lagged = encodeLikePi(events);
	const final = await stream.result?.();
	return { events, eagerFrames, eagerSnapshot, laggedFrames: lagged.frames, laggedSnapshot: lagged.snapshot, final };
}
