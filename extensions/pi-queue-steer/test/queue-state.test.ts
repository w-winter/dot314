import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import queueSteerExtension, {
	QUEUE_STEER_ACCEPTED_EVENT,
	QUEUE_STEER_ATTACHMENTS_EVENT,
	type QueueSteerAcceptedEventV1,
	type QueueSteerAttachmentsEventV1,
} from "../index.ts";
import { DeliveryQueue, QueueEditSession, type QueueLane } from "../queue-state.ts";

// Isolate queue-mode defaults from the developer's global Pi settings.
const DEFAULT_HARNESS_CWD = mkdtempSync(join(tmpdir(), "pi-queue-steer-default-"));
mkdirSync(join(DEFAULT_HARNESS_CWD, ".pi"));
writeFileSync(
	join(DEFAULT_HARNESS_CWD, ".pi", "settings.json"),
	JSON.stringify({ steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" }),
);
test.after(() => rmSync(DEFAULT_HARNESS_CWD, { recursive: true, force: true }));

test("keeps steering and follow-ups in independent FIFOs", () => {
	const queue = new DeliveryQueue<string>();
	queue.enqueue("followUp", "later one", ["one.png"]);
	queue.enqueue("steer", "steer one");
	queue.enqueue("followUp", "later two");
	queue.enqueue("steer", "steer two");

	assert.deepEqual(
		queue.snapshot().map((item) => [item.lane, item.text]),
		[
			["steer", "steer one"],
			["steer", "steer two"],
			["followUp", "later one"],
			["followUp", "later two"],
		],
	);
	assert.equal(queue.shift("steer")?.text, "steer one");
	assert.equal(queue.shift("followUp")?.text, "later one");
});

test("selects the globally most recent item before navigating spatially", () => {
	const queue = new DeliveryQueue();
	const firstSteer = queue.enqueue("steer", "steer one");
	const latestFollowUp = queue.enqueue("followUp", "later");
	const latestSteer = queue.enqueue("steer", "steer two");

	assert.equal(queue.mostRecentId(), latestSteer.id);
	assert.equal(queue.previousId(), latestSteer.id);
	assert.equal(queue.previousId(latestSteer.id), firstSteer.id);
	assert.equal(queue.nextId(latestSteer.id), latestFollowUp.id);
	assert.equal(queue.nextId(latestFollowUp.id), firstSteer.id);
});

test("edits a row without changing its stable lane position", () => {
	const queue = new DeliveryQueue();
	const first = queue.enqueue("steer", "first");
	queue.enqueue("steer", "second");

	assert.equal(queue.update(first.id, "first, edited"), true);
	assert.deepEqual(queue.laneSnapshot("steer").map((item) => item.text), ["first, edited", "second"]);
});

test("moves a steering row to the tail of the follow-up lane", () => {
	const queue = new DeliveryQueue<string>();
	const existingFollowUp = queue.enqueue("followUp", "already later");
	const steering = queue.enqueue("steer", "defer this", ["image.png"]);

	assert.equal(queue.moveToLane(steering.id, "followUp"), true);
	assert.deepEqual(queue.laneSnapshot("steer"), []);
	assert.deepEqual(
		queue.laneSnapshot("followUp").map((item) => [item.id, item.text, item.images]),
		[
			[existingFollowUp.id, "already later", []],
			[steering.id, "defer this", ["image.png"]],
		],
	);
});

test("restores failed batches at the front in their original order", () => {
	const queue = new DeliveryQueue();
	queue.enqueue("followUp", "first");
	queue.enqueue("followUp", "second");
	const failed = queue.shiftAll("followUp");
	queue.enqueue("followUp", "third");
	queue.prependMany(failed);

	assert.deepEqual(queue.laneSnapshot("followUp").map((item) => item.text), ["first", "second", "third"]);
});

test("edit sessions keep cross-lane drafts private until commit", () => {
	const queue = new DeliveryQueue();
	const steer = queue.enqueue("steer", "steer original");
	const followUp = queue.enqueue("followUp", "later original");
	const edit = new QueueEditSession(followUp, "composer draft");

	edit.select(steer, "later edited");
	assert.equal(edit.textFor(followUp.id), "later edited");
	assert.equal(queue.get(followUp.id)?.text, "later original");
	edit.commit(queue, "steer edited");

	assert.deepEqual(queue.snapshot().map((item) => item.text), ["steer edited", "later edited"]);
	assert.equal(edit.composerDraft, "composer draft");
});

test("empty drafts remove text-only rows but preserve image-only rows", () => {
	const queue = new DeliveryQueue<string>();
	const textOnly = queue.enqueue("steer", "delete me");
	const imageOnly = queue.enqueue("followUp", "", ["image.png"]);

	const deleteEdit = new QueueEditSession(textOnly, "");
	assert.deepEqual(deleteEdit.commit(queue, ""), { updated: 0, removed: 1 });
	const imageEdit = new QueueEditSession(imageOnly, "");
	assert.deepEqual(imageEdit.commit(queue, ""), { updated: 1, removed: 0 });
	assert.deepEqual(queue.get(imageOnly.id)?.images, ["image.png"]);
});

class MockEditor {
	private text = "";
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;

	getText(): string {
		return this.text;
	}

	setText(text: string): void {
		this.text = text;
		this.onChange?.(text);
	}

	handleInput(_data: string): void {}

	render(width: number): string[] {
		const border = "─".repeat(width);
		return [border, this.text.slice(0, width).padEnd(width), border];
	}

	invalidate(): void {}
}

function createHarness(options: { cwd?: string; projectTrusted?: boolean; failSend?: boolean } = {}) {
	type Handler = (event: any, context: any) => any;
	type UserMessageContent = string | (TextContent | ImageContent)[];
	interface DeliveryOptions {
		deliverAs?: QueueLane;
	}
	type HarnessEvent = QueueSteerAcceptedEventV1 | QueueSteerAttachmentsEventV1;
	type EventHandler = (event: HarnessEvent) => void;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Handler>();
	const sent: Array<{ content: UserMessageContent; options: DeliveryOptions | undefined }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const eventHandlers = new Map<string, EventHandler[]>();
	const emittedEvents: Array<{ channel: string; payload: QueueSteerAcceptedEventV1 }> = [];
	let sessionId = "queue-session-1";
	let idle = false;
	let pending = false;
	let aborted = false;
	let activeEditor = new MockEditor();
	let currentFactory: any = () => activeEditor;
	let widget: unknown;

	const keybindings = {
		matches(data: string, action: string): boolean {
			return (
				(data === "enter" && action === "tui.input.submit") ||
				(data === "alt-enter" && action === "app.message.followUp") ||
				(data === "alt-up" && action === "app.message.dequeue") ||
				(data === "escape" && action === "app.interrupt")
			);
		},
	};

	const ui = {
		getEditorComponent: () => currentFactory,
		setEditorComponent(factory: any) {
			currentFactory = factory;
			activeEditor = factory({}, {}, keybindings);
		},
		getEditorText: () => activeEditor.getText(),
		setEditorText: (text: string) => activeEditor.setText(text),
		setWidget(_id: string, value: unknown) {
			widget = value;
		},
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
	};

	const context = {
		mode: "tui",
		hasUI: true,
		cwd: options.cwd ?? DEFAULT_HARNESS_CWD,
		ui,
		isIdle: () => idle,
		isProjectTrusted: () => options.projectTrusted ?? true,
		hasPendingMessages: () => pending,
		sessionManager: {
			getSessionId: () => sessionId,
		},
		abort() {
			aborted = true;
		},
	};

	const pi = {
		events: {
			on(channel: string, handler: EventHandler) {
				const registered = eventHandlers.get(channel) ?? [];
				registered.push(handler);
				eventHandlers.set(channel, registered);
			},
			emit(channel: string, payload: HarnessEvent) {
				if (channel === QUEUE_STEER_ACCEPTED_EVENT) {
					if (!("producer" in payload)) throw new Error("Invalid accepted-steer event");
					emittedEvents.push({ channel, payload });
				}
				for (const handler of eventHandlers.get(channel) ?? []) handler(payload);
			},
		},
		on(name: string, handler: Handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerCommand(name: string, options: { handler: Handler }) {
			commands.set(name, options.handler);
		},
		sendUserMessage(content: UserMessageContent, deliveryOptions?: DeliveryOptions) {
			if (options.failSend) throw new Error("delivery failed");
			sent.push({ content, options: deliveryOptions });
			if (deliveryOptions) pending = true;
		},
	};

	queueSteerExtension(pi as any);

	const emit = async (name: string, event: any = {}): Promise<any[]> => {
		const results = [];
		for (const handler of handlers.get(name) ?? []) {
			results.push(await handler(event, context));
		}
		return results;
	};

	return {
		emit,
		invokeCommand(name: string, args: string) {
			return commands.get(name)?.(args, context);
		},
		sent,
		notifications,
		emittedEvents,
		get editor() {
			return activeEditor;
		},
		get widget() {
			return widget;
		},
		get aborted() {
			return aborted;
		},
		setIdle(value: boolean) {
			idle = value;
		},
		setSessionId(value: string) {
			sessionId = value;
		},
		onEvent(channel: string, handler: EventHandler) {
			const registered = eventHandlers.get(channel) ?? [];
			registered.push(handler);
			eventHandlers.set(channel, registered);
		},
		clearPending() {
			pending = false;
		},
		replaceEditor(editor = new MockEditor()) {
			ui.setEditorComponent(() => editor);
		},
	};
}

async function enqueue(
	harness: ReturnType<typeof createHarness>,
	lane: QueueLane,
	text: string,
): Promise<void> {
	await harness.emit("input", {
		source: "interactive",
		text,
		streamingBehavior: lane,
	});
}

test("emits one exact content-free event for a newly accepted steering row", async () => {
	assert.equal(QUEUE_STEER_ACCEPTED_EVENT, "pi-queue-steer:accepted-steer:v1");
	const harness = createHarness();
	await harness.emit("session_start");
	const privateText = "private steering text";
	await harness.emit("input", {
		source: "interactive",
		text: privateText,
		images: [{ type: "image", data: "private-image", mimeType: "image/png" }],
		streamingBehavior: "steer",
	});

	assert.equal(harness.emittedEvents.length, 1);
	const emitted = harness.emittedEvents[0];
	assert.ok(emitted);
	assert.equal(emitted.channel, QUEUE_STEER_ACCEPTED_EVENT);
	const { payload } = emitted;
	assert.deepEqual(Object.keys(payload).sort(), [
		"producer",
		"producerEpochId",
		"sequence",
		"sessionId",
		"version",
	]);
	assert.equal(payload.version, 1);
	assert.equal(payload.producer, "pi-queue-steer");
	assert.equal(payload.sessionId, "queue-session-1");
	assert.equal(payload.sequence, 1);
	assert.match(payload.producerEpochId, /^[0-9a-f-]+$/u);
	assert.doesNotMatch(JSON.stringify(payload), /private steering text|private-image/u);
});

test("follow-up edit deletion delivery and shutdown never emit a new accepted event", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "original");
	assert.equal(harness.emittedEvents.length, 1);

	await enqueue(harness, "followUp", "later");
	await harness.invokeCommand("followup", "command later");
	harness.editor.handleInput("alt-up");
	harness.editor.setText("edited later");
	harness.editor.handleInput("enter");
	harness.editor.handleInput("alt-up");
	harness.editor.setText("");
	harness.editor.handleInput("enter");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	await harness.emit("agent_end");
	await harness.emit("agent_settled");
	await harness.emit("session_shutdown");

	assert.equal(harness.emittedEvents.length, 1);
});

test("edit cancellation and failed restoration emit no accepted event", async () => {
	const cancelled = createHarness();
	await cancelled.emit("session_start");
	await enqueue(cancelled, "steer", "original");
	cancelled.editor.handleInput("alt-up");
	cancelled.editor.setText("discarded");
	cancelled.editor.handleInput("escape");
	assert.equal(cancelled.emittedEvents.length, 1);

	const restored = createHarness({ failSend: true });
	await restored.emit("session_start");
	await enqueue(restored, "steer", "restore me");
	await restored.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(restored.emittedEvents.length, 1);
	assert.match(renderWidget(restored), /restore me/u);
});

test("accepted event sequence increases and a new session starts a new producer epoch", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "first");
	await enqueue(harness, "steer", "second");
	const firstPayload = harness.emittedEvents[0]?.payload;
	const secondPayload = harness.emittedEvents[1]?.payload;
	assert.ok(firstPayload);
	assert.ok(secondPayload);
	assert.equal(firstPayload.sequence, 1);
	assert.equal(secondPayload.sequence, 2);
	assert.equal(firstPayload.producerEpochId, secondPayload.producerEpochId);

	harness.setSessionId("queue-session-2");
	await harness.emit("session_start");
	assert.equal(harness.emittedEvents.length, 2);
	await enqueue(harness, "steer", "third");
	const thirdPayload = harness.emittedEvents[2]?.payload;
	assert.ok(thirdPayload);
	assert.equal(thirdPayload.sessionId, "queue-session-2");
	assert.equal(thirdPayload.sequence, 1);
	assert.notEqual(thirdPayload.producerEpochId, firstPayload.producerEpochId);
});

function renderWidget(harness: ReturnType<typeof createHarness>, width = 76): string {
	const widgetFactory = harness.widget as (tui: unknown, theme: any) => { render(width: number): string[] };
	const component = widgetFactory({}, { fg: (_color: string, text: string) => text });
	return component.render(width).join("\n");
}

test("renders stacked lane boxes with steering above follow-ups", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "write the README");
	await enqueue(harness, "steer", "check the API first");

	const rendered = renderWidget(harness);
	const lines = rendered.split("\n");
	assert.equal(lines.filter((line) => line.startsWith("┌")).length, 2);
	assert.ok(rendered.indexOf("steering queue (1)") < rendered.indexOf("check the API first"));
	assert.ok(rendered.indexOf("check the API first") < rendered.indexOf("follow-ups (1)"));
	assert.ok(rendered.indexOf("follow-ups (1)") < rendered.indexOf("write the README"));
	assert.match(rendered, /next turn/);
	assert.match(rendered, /after this run/);
});

test("colors each lane's full box instead of only its row label", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "blue row");
	await enqueue(harness, "followUp", "yellow row");
	const calls: Array<[string, string]> = [];
	const widgetFactory = harness.widget as (tui: unknown, theme: any) => { render(width: number): string[] };
	const component = widgetFactory({}, {
		fg(color: string, text: string): string {
			calls.push([color, text]);
			return text;
		},
	});

	component.render(76);
	assert.ok(calls.some(([color, text]) => color === "accent" && text.startsWith("┌ steering queue")));
	assert.ok(calls.some(([color, text]) => color === "warning" && text.startsWith("┌ follow-ups")));
	assert.ok(calls.some(([color, text]) => color === "muted" && text === "blue row"));
	assert.ok(calls.some(([color, text]) => color === "muted" && text === "yellow row"));
});

test("keeps queued text aligned when its row becomes the live editor", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "aligned message");

	const queuedLine = renderWidget(harness).split("\n").find((line) => line.includes("aligned message"));
	harness.editor.handleInput("alt-up");
	const editingLine = renderWidget(harness).split("\n").find((line) => line.includes("aligned message"));

	assert.ok(queuedLine);
	assert.ok(editingLine);
	assert.equal(queuedLine.indexOf("aligned message"), editingLine.indexOf("aligned message"));
});

test("follow-up action converts the edited steering row to a follow-up", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "already later");
	await enqueue(harness, "steer", "defer this");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("defer this, edited");
	harness.editor.handleInput("alt-enter");

	const rendered = renderWidget(harness);
	assert.doesNotMatch(rendered, /steering queue/u);
	assert.ok(rendered.indexOf("already later") < rendered.indexOf("defer this, edited"));
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.sent.length, 0);
	await harness.emit("agent_end");
	assert.deepEqual(harness.sent[0], {
		content: "already later",
		options: { deliverAs: "followUp" },
	});
	assert.equal(harness.emittedEvents.length, 1);
});

test("follow-up action converts the edited follow-up row to steering", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "already steering");
	await enqueue(harness, "followUp", "send sooner");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("send sooner, edited");
	harness.editor.handleInput("alt-enter");

	const rendered = renderWidget(harness);
	assert.doesNotMatch(rendered, /follow-ups/u);
	assert.ok(rendered.indexOf("already steering") < rendered.indexOf("send sooner, edited"));
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent[0], {
		content: "already steering",
		options: { deliverAs: "steer" },
	});
});

test("/followup converts the edited steering row and strips the command prefix", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "already later");
	await enqueue(harness, "steer", "defer this");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("/followup defer this, edited");
	harness.editor.handleInput("enter");

	const rendered = renderWidget(harness);
	assert.doesNotMatch(rendered, /steering queue|\/followup/u);
	assert.ok(rendered.indexOf("already later") < rendered.indexOf("defer this, edited"));
});

test("empty /followup usage keeps the steering row open for editing", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "defer this");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("/followup   ");
	harness.editor.handleInput("enter");

	assert.equal(harness.editor.getText(), "/followup   ");
	assert.match(renderWidget(harness), /steering queue/u);
	assert.deepEqual(harness.notifications.at(-1), {
		message: "Usage: /followup <message>",
		level: "warning",
	});
});

test("/steer converts the edited follow-up row and strips the command prefix", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "already steering");
	await enqueue(harness, "followUp", "send sooner");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("/steer send sooner, edited");
	harness.editor.handleInput("enter");

	const rendered = renderWidget(harness);
	assert.doesNotMatch(rendered, /follow-ups|\/steer/u);
	assert.ok(rendered.indexOf("already steering") < rendered.indexOf("send sooner, edited"));
});

test("empty /steer usage keeps the follow-up row open for editing", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "send sooner");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("/steer   ");
	harness.editor.handleInput("enter");

	assert.equal(harness.editor.getText(), "/steer   ");
	assert.match(renderWidget(harness), /follow-ups/u);
	assert.deepEqual(harness.notifications.at(-1), {
		message: "Usage: /steer <message>",
		level: "warning",
	});
});

test("uses compact queue chrome at narrow terminal widths", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "a long steering row that needs clipping");
	await enqueue(harness, "followUp", "a long follow-up row that needs clipping");
	const widgetFactory = harness.widget as (tui: unknown, theme: any) => { render(width: number): string[] };
	const component = widgetFactory({}, { fg: (_color: string, text: string) => text });

	const narrow = component.render(30);
	assert.ok(
		narrow.every((line) => visibleWidth(line) <= 30),
		JSON.stringify(narrow.map((line) => [visibleWidth(line), line])),
	);
	assert.deepEqual(component.render(20), ["queued S1 F1"]);
});

test("injects one owned steering row at Pi's native turn boundary", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "first steer");
	await enqueue(harness, "steer", "second steer");

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent[0], { content: "first steer", options: { deliverAs: "steer" } });
	assert.match(renderWidget(harness), /second steer/);
	assert.doesNotMatch(renderWidget(harness), /first steer/);
});

test("injects follow-ups through Pi's native continuation queue at agent_end", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "later one");
	await enqueue(harness, "followUp", "later two");

	await harness.emit("agent_end");
	assert.deepEqual(harness.sent[0], { content: "later one", options: { deliverAs: "followUp" } });
	assert.match(renderWidget(harness), /later two/);
});

for (const submission of ["input", "command", "mixed"] as const) {
	test(`collects staged attachments independently for consecutive ${submission} follow-ups`, async () => {
		const harness = createHarness();
		const firstImage: ImageContent = { type: "image", data: "first", mimeType: "image/png" };
		const thirdImage: ImageContent = { type: "image", data: "third", mimeType: "image/png" };
		let stagedImages = [firstImage];
		harness.onEvent(QUEUE_STEER_ATTACHMENTS_EVENT, (value) => {
			if (!("attach" in value)) throw new Error("Invalid attachment request");
			value.attach(stagedImages);
			stagedImages = [];
		});
		await harness.emit("session_start");
		if (submission === "input") await enqueue(harness, "followUp", "first");
		else await harness.invokeCommand("followup", "first");
		if (submission === "command") await harness.invokeCommand("followup", "second");
		else await enqueue(harness, "followUp", "second");
		stagedImages = [thirdImage];
		if (submission === "command") await harness.invokeCommand("followup", "third");
		else await enqueue(harness, "followUp", "third");

		for (let index = 0; index < 3; index += 1) {
			await harness.emit("agent_end");
			harness.clearPending();
		}
		assert.deepEqual(harness.sent.map((message) => message.content), [
			[{ type: "text", text: "first" }, firstImage],
			"second",
			[{ type: "text", text: "third" }, thirdImage],
		]);
	});
}

test("/followup queues a visible follow-up without requiring Alt+Enter", async () => {
	const harness = createHarness();
	await harness.emit("session_start");

	await harness.invokeCommand("followup", "check the tests afterward");
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /check the tests afterward/);

	await harness.emit("agent_end");
	assert.deepEqual(harness.sent[0], {
		content: "check the tests afterward",
		options: { deliverAs: "followUp" },
	});
});

test("/followup rejects an empty message", async () => {
	const harness = createHarness();
	await harness.emit("session_start");

	await harness.invokeCommand("followup", "   ");
	assert.equal(harness.widget, undefined);
	assert.deepEqual(harness.notifications[0], {
		message: "Usage: /followup <message>",
		level: "warning",
	});
});

test("honours Pi all-mode settings and pins the whole edited lane", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-queue-steer-all-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({ steeringMode: "all", followUpMode: "all" }),
	);
	try {
		const steering = createHarness({ cwd, projectTrusted: true });
		await steering.emit("session_start");
		await enqueue(steering, "steer", "steer one");
		await enqueue(steering, "steer", "steer two");
		steering.editor.handleInput("alt-up");
		await steering.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
		assert.equal(steering.sent.length, 0);
		steering.editor.handleInput("enter");
		await steering.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
		assert.deepEqual(steering.sent.map((item) => item.content), ["steer one", "steer two"]);

		const followUps = createHarness({ cwd, projectTrusted: true });
		await followUps.emit("session_start");
		await enqueue(followUps, "followUp", "later one");
		await enqueue(followUps, "followUp", "later two");
		await followUps.emit("agent_end");
		assert.deepEqual(followUps.sent.map((item) => item.content), ["later one", "later two"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Alt+Up enters at the most recently enqueued row across both lanes", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "latest later");
	await enqueue(harness, "steer", "latest overall");
	await enqueue(harness, "followUp", "newest overall");

	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "newest overall");
	assert.match(renderWidget(harness), /› newest overall/);
});

test("Alt+Up and Alt+Down navigate spatially while retaining row drafts", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "steer one");
	await enqueue(harness, "steer", "steer two");
	await enqueue(harness, "followUp", "later one");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("later one edited");
	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "steer two");
	harness.editor.handleInput("\x1b[1;3B");
	assert.equal(harness.editor.getText(), "later one edited");
});

test("queue editing stashes and restores an unrelated composer draft", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "queued row");
	harness.editor.setText("unrelated composer draft");

	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "queued row");
	harness.editor.setText("queued row edited");
	harness.editor.handleInput("enter");
	assert.equal(harness.editor.getText(), "unrelated composer draft");
});

test("editing-mode Enter saves in place without changing the delivery lane", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "original");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("edited");
	harness.editor.handleInput("enter");
	assert.equal(harness.sent.length, 0);
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.deepEqual(harness.sent[0], { content: "edited", options: { deliverAs: "steer" } });
});

test("Escape rolls back an inline edit and releases its pin", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "steer", "original");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("discard me");
	harness.editor.handleInput("escape");
	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(harness.sent[0]?.content, "original");
});

test("editing a steering head pins it while editing a later row does not", async () => {
	const held = createHarness();
	await held.emit("session_start");
	await enqueue(held, "steer", "first");
	await enqueue(held, "steer", "second");
	held.editor.handleInput("alt-up");
	held.editor.handleInput("alt-up");
	await held.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(held.sent.length, 0);
	assert.match(renderWidget(held), /held while editing/);
	assert.match(renderWidget(held), /› first/);

	const later = createHarness();
	await later.emit("session_start");
	await enqueue(later, "steer", "first");
	await enqueue(later, "steer", "second");
	later.editor.handleInput("alt-up");
	await later.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
	assert.equal(later.sent[0]?.content, "first");
	assert.equal(later.editor.getText(), "second");
});

test("editing a later follow-up does not block its lane head", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "first");
	await enqueue(harness, "followUp", "second");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("second edited");
	await harness.emit("agent_end");
	assert.equal(harness.sent[0]?.content, "first");
	assert.equal(harness.editor.getText(), "second edited");
});

test("abort pauses both owned lanes and empty Enter explicitly resumes", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "do not auto-send");
	harness.editor.handleInput("escape");
	assert.equal(harness.aborted, true);

	await harness.emit("turn_end", { message: { role: "assistant", stopReason: "aborted" } });
	await harness.emit("agent_end");
	harness.setIdle(true);
	await harness.emit("agent_settled");
	assert.equal(harness.sent.length, 0);
	assert.match(renderWidget(harness), /paused/);

	harness.editor.handleInput("enter");
	assert.equal(harness.sent[0]?.content, "do not auto-send");
});

test("clearing a selected text-only row deletes it on save", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "delete this");

	harness.editor.handleInput("alt-up");
	harness.editor.setText("");
	harness.editor.handleInput("enter");
	assert.equal(harness.widget, undefined);
	assert.match(harness.notifications[0]?.message ?? "", /Removed 1 empty queued message/);
});

test("recomposes after another extension installs editor chrome on a later tick", async () => {
	const harness = createHarness();
	await harness.emit("session_start");
	await enqueue(harness, "followUp", "original");
	await harness.emit("agent_start");

	harness.replaceEditor();
	await new Promise((resolve) => setTimeout(resolve, 5));
	harness.editor.handleInput("alt-up");
	assert.equal(harness.editor.getText(), "original");
});
