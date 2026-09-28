// Test fixture: rewrites an earlier user message through Pi's own
// `context_edit` session entry (Pi 0.87+). The edit replaces the message's
// model-visible content in place, so the history keeps its length and Pi fires
// no session_tree/session_compact event.
//
// Once per process: when a run settles and a user message contains
// CONTEXT_EDIT_FROM, it is replaced with the same text using CONTEXT_EDIT_TO.

// The bridge type-checks against Pi 0.86 declarations, which predate the
// boundary events; this is the slice of Pi 0.87's API the fixture uses.
interface SettleEvent {
	context: { contextEntries: Array<{ sourceEntry: unknown }> };
}
interface BoundaryApi {
	on(event: "agent_before_settle", handler: (event: SettleEvent) => unknown): void;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (block as { type?: string; text?: string }).type === "text" ? (block as { text?: string }).text ?? "" : "").join("");
}

export default function contextEditFixture(pi: BoundaryApi) {
	const from = process.env.CONTEXT_EDIT_FROM;
	const to = process.env.CONTEXT_EDIT_TO;
	let done = false;
	pi.on("agent_before_settle", (event) => {
		if (done || !from || !to) return undefined;
		for (const entry of event.context.contextEntries) {
			const source = entry.sourceEntry as { type: string; id: string; message?: { role?: string; content?: unknown } };
			if (source.type !== "message" || source.message?.role !== "user") continue;
			const text = messageText(source.message.content);
			if (!text.includes(from)) continue;
			done = true;
			return { entries: [{ type: "context_edit", targetId: source.id, replacement: { content: text.split(from).join(to) } }] };
		}
		return undefined;
	});
}
