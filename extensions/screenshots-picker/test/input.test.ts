import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import screenshotsExtension from "../index.ts";

interface TestComponent {
	handleInput(data: string): void;
}

interface TestKeybindings {
	readonly test: true;
}

interface TestContext {
	ui: {
		custom<T>(factory: (
			tui: { requestRender(): void },
			theme: { fg(color: string, text: string): string },
			keybindings: TestKeybindings,
			done: (value: T) => void,
		) => TestComponent): Promise<T>;
		setWidget(id: string, value: readonly string[] | undefined): void;
		notify(message: string, level: string): void;
	};
	sessionManager: { getBranch(): never[] };
}

interface InputEvent {
	source: "interactive" | "extension";
	text: string;
}

type InputResult = { action: "continue" } | {
	action: "transform";
	text: string;
	images?: ImageContent[];
};
type InputHandler = (event: InputEvent, context: TestContext) => InputResult;
type StartEvent = {
	type: "before_agent_start";
	systemPrompt: string;
	systemPromptOptions: Record<string, never>;
} & (
	| { messageType: "user"; prompt: string; images: ImageContent[] | undefined }
	| { messageType: "custom"; message: { role: "custom"; customType: string; content: string; display: boolean; timestamp: number } }
);
type StartHandler = (event: StartEvent) => Promise<BeforeAgentStartEventResult | undefined>;
type CommandHandler = (args: string, context: TestContext) => Promise<void>;
type ScreenshotsExtensionAPI = Parameters<typeof screenshotsExtension>[0];

function createScreenshotsHarness() {
	const inputHandlers: InputHandler[] = [];
	const startHandlers: StartHandler[] = [];
	const commands = new Map<string, CommandHandler>();

	const context: TestContext = {
		ui: {
			custom(factory) {
				return new Promise((resolve) => {
					const component = factory(
						{ requestRender() {} },
						{ fg: (_color, text) => text },
						{ test: true },
						resolve,
					);
					component.handleInput("s");
					component.handleInput("\r");
				});
			},
			setWidget() {},
			notify() {},
		},
		sessionManager: { getBranch: () => [] },
	};

	const pi = {
		on(name: string, handler: InputHandler & StartHandler) {
			if (name === "input") inputHandlers.push(handler);
			if (name === "before_agent_start") startHandlers.push(handler);
		},
		events: {
			on() {
				return () => {};
			},
		},
		registerMessageRenderer() {},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
		registerShortcut() {},
	};

	// SAFETY: The test provides every API member that the extension calls.
	const extensionApi = Object.assign({} as ScreenshotsExtensionAPI, pi);
	screenshotsExtension(extensionApi);

	return {
		async stageScreenshot(): Promise<void> {
			const command = commands.get("ss");
			assert.ok(command);
			await command("", context);
		},
		async emitInput(event: InputEvent): Promise<InputResult[]> {
			return Promise.all(inputHandlers.map((handler) => handler(event, context)));
		},
		async emitStart(event: StartEvent): Promise<(BeforeAgentStartEventResult | undefined)[]> {
			return Promise.all(startHandlers.map((handler) => handler(event)));
		},
	};
}

test("custom starts retain sent screenshot previews for the next user start", async () => {
	const home = mkdtempSync(join(tmpdir(), "screenshots-picker-home-"));
	const screenshots = join(home, "screenshots");
	mkdirSync(screenshots);
	writeFileSync(join(screenshots, "Screenshot test.png"), "test image");
	const previousHome = process.env.HOME;
	const previousScreenshotsDir = process.env.PI_SCREENSHOTS_DIR;
	process.env.HOME = home;
	process.env.PI_SCREENSHOTS_DIR = screenshots;

	try {
		const harness = createScreenshotsHarness();
		await harness.stageScreenshot();
		const internalDelivery = await harness.emitInput({ source: "extension", text: "older follow-up" });
		assert.deepEqual(internalDelivery, [{ action: "continue" }]);
		assert.deepEqual(await harness.emitInput({ source: "interactive", text: "inspect this" }), [{
			action: "transform",
			text: "inspect this",
			images: [{ type: "image", mimeType: "image/png", data: Buffer.from("test image").toString("base64") }],
		}]);
		const shared = { type: "before_agent_start" as const, systemPrompt: "BASE", systemPromptOptions: {} };
		assert.deepEqual(await harness.emitStart({
			...shared,
			messageType: "custom",
			message: { role: "custom", customType: "follow-up", content: "continue", display: false, timestamp: 0 },
		}), [undefined]);
		const userStart: StartEvent = { ...shared, messageType: "user", prompt: "inspect this", images: undefined };
		const [preview] = await harness.emitStart(userStart);
		assert.equal(preview?.message?.content, "Sent 1 screenshot");
		assert.deepEqual(preview.message.details, { paths: [join(screenshots, "Screenshot test.png")], totalCount: 1 });
		assert.deepEqual(await harness.emitStart(userStart), [undefined]);
		assert.deepEqual(await harness.emitInput({ source: "interactive", text: "next message" }), [
			{ action: "continue" },
		]);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousScreenshotsDir === undefined) delete process.env.PI_SCREENSHOTS_DIR;
		else process.env.PI_SCREENSHOTS_DIR = previousScreenshotsDir;
		rmSync(home, { recursive: true, force: true });
	}
});
