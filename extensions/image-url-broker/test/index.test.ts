import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	normalizeContext,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

import {
	registerImageUrlBrokerExtension,
	rewriteSupportedImagePayload,
	type ProviderModelHint,
} from "../index.ts";
import {
	createContentAddressedImagePublisher,
	createImageBlob,
	loadImageUrlBrokerConfig,
	type ImageBlob,
	type ImagePublisher,
} from "../publication.ts";
import { createCodexImageFallback, unwrapCodexImageFallback } from "../stream-fallback.ts";

const PNG_BASE64 = "AQIDBA==";
const JPEG_BASE64 = "BQYHCA==";

function imageModel(provider: string, api: string, baseUrl?: string): ProviderModelHint {
	const defaultBaseUrl =
		provider === "anthropic"
			? "https://api.anthropic.com"
			: provider === "openai"
				? "https://api.openai.com/v1"
				: provider === "openai-codex"
					? "https://chatgpt.com/backend-api"
					: provider === "azure-openai-responses"
						? "https://example.openai.azure.com/openai/v1"
						: "https://proxy.example.test";
	return { provider, api, baseUrl: baseUrl ?? defaultBaseUrl, input: ["text", "image"] };
}

class RecordingPublisher implements ImagePublisher {
	readonly images: ImageBlob[] = [];
	failAt: number | undefined;

	async publish(image: ImageBlob): Promise<string> {
		this.images.push(image);
		if (this.images.length === this.failAt) throw new Error("publication failed");
		return `https://images.example.test/${image.key}`;
	}
}

function writeConfig(path: string, config: unknown): void {
	writeFileSync(path, JSON.stringify(config), "utf8");
}

function chatImagePayload(url: string): unknown {
	return { messages: [{ content: [{ type: "image_url", image_url: { url } }] }] };
}

function responsesImagePayload(url: string): unknown {
	return { input: [{ type: "input_image", image_url: url }] };
}

const CODEX_MODEL = {
	id: "codex-test",
	name: "Codex Test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
} as Model<"openai-codex-responses">;

const EMPTY_CONTEXT: TranscriptContext = normalizeContext({ messages: [] });

function assistantMessage(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: CODEX_MODEL.api,
		provider: CODEX_MODEL.provider,
		model: CODEX_MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function eventStream(events: readonly AssistantMessageEvent[]) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		for (const event of events) stream.push(event);
	});
	return stream;
}

async function collectEvents(stream: ReturnType<typeof createAssistantMessageEventStream>) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

test("configuration accepts the strict schema and rejects invalid publication settings", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "image-url-broker-config-"));
	try {
		const targetDirectory = join(tempDir, "target");
		const linkedDirectory = join(tempDir, "linked");
		mkdirSync(targetDirectory);
		symlinkSync(targetDirectory, linkedDirectory, "dir");
		const configPath = join(tempDir, "config.json");
		writeConfig(configPath, {
			publicBaseUrl: "https://images.example.test:8443/pi",
			outputDirectory: linkedDirectory,
		});

		const config = loadImageUrlBrokerConfig(configPath);
		assert.ok(config);
		assert.deepEqual(config, {
			publicBaseUrl: "https://images.example.test:8443/pi/",
			outputDirectory: linkedDirectory,
		});
		createContentAddressedImagePublisher(config);

		assert.equal(loadImageUrlBrokerConfig(join(tempDir, "missing.json")), undefined);
		writeFileSync(configPath, "{", "utf8");
		assert.throws(() => loadImageUrlBrokerConfig(configPath), /image-url-broker: failed to parse config/);

		const invalidConfigs: Array<{ name: string; config: unknown; pattern: RegExp }> = [
			{ name: "non-object root", config: [], pattern: /config root must be an object/ },
			{
				name: "unknown field",
				config: { publicBaseUrl: "https://x.test", outputDirectory: tempDir, extra: true },
				pattern: /unsupported field: extra/,
			},
			{
				name: "missing field",
				config: { publicBaseUrl: "https://x.test" },
				pattern: /missing required field: outputDirectory/,
			},
			{
				name: "empty URL",
				config: { publicBaseUrl: "", outputDirectory: tempDir },
				pattern: /publicBaseUrl must be a non-empty string/,
			},
			{
				name: "HTTP URL",
				config: { publicBaseUrl: "http://x.test", outputDirectory: tempDir },
				pattern: /must use https/,
			},
			{
				name: "URL credentials",
				config: { publicBaseUrl: "https://user@x.test", outputDirectory: tempDir },
				pattern: /must not include credentials/,
			},
			{
				name: "URL query",
				config: { publicBaseUrl: "https://x.test?a=1", outputDirectory: tempDir },
				pattern: /must not include a query/,
			},
			{
				name: "URL fragment",
				config: { publicBaseUrl: "https://x.test/#a", outputDirectory: tempDir },
				pattern: /must not include a fragment/,
			},
			{
				name: "relative output",
				config: { publicBaseUrl: "https://x.test", outputDirectory: "relative" },
				pattern: /must be an absolute path/,
			},
		];
		for (const invalid of invalidConfigs) {
			writeConfig(configPath, invalid.config);
			assert.throws(
				() => loadImageUrlBrokerConfig(configPath),
				invalid.pattern,
				invalid.name,
			);
		}

		const filePath = join(tempDir, "not-a-directory");
		writeFileSync(filePath, "x", "utf8");
		assert.throws(
			() => createContentAddressedImagePublisher({
				publicBaseUrl: "https://images.example.test/",
				outputDirectory: filePath,
			}),
			/image-url-broker: failed to initialize output directory/,
		);

		if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
			const nonWritableDirectory = join(tempDir, "non-writable");
			mkdirSync(nonWritableDirectory);
			chmodSync(nonWritableDirectory, 0o555);
			try {
				assert.throws(
					() => createContentAddressedImagePublisher({
						publicBaseUrl: "https://images.example.test/",
						outputDirectory: nonWritableDirectory,
					}),
					/image-url-broker: failed to initialize output directory/,
				);
				assert.deepEqual(readdirSync(nonWritableDirectory), []);
			} finally {
				chmodSync(nonWritableDirectory, 0o755);
			}
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("content-addressed publication enforces canonical data and deterministic final paths", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "image-url-broker-publish-"));
	try {
		assert.ok(createImageBlob("image/png", "AA=="));
		assert.ok(createImageBlob("image/png", "AAA="));
		assert.throws(() => createImageBlob("image/png", "AB=="), /canonical padded base64/);
		assert.throws(() => createImageBlob("image/png", "AAB="), /canonical padded base64/);

		const blob = createImageBlob("image/png", PNG_BASE64);
		assert.ok(blob);
		const expectedKey = createHash("sha256").update("image/png\n").update(PNG_BASE64).digest("hex");
		assert.equal(blob.key, expectedKey);
		const publisher = createContentAddressedImagePublisher({
			publicBaseUrl: "https://images.example.test/pi/",
			outputDirectory: tempDir,
		});

		const [firstUrl, secondUrl] = await Promise.all([publisher.publish(blob), publisher.publish(blob)]);
		assert.equal(firstUrl, `https://images.example.test/pi/${expectedKey}.png`);
		assert.equal(secondUrl, firstUrl);
		assert.deepEqual(readdirSync(tempDir), [`${expectedKey}.png`]);
		assert.deepEqual(readFileSync(join(tempDir, `${expectedKey}.png`)), Buffer.from(PNG_BASE64, "base64"));
		assert.equal(await publisher.publish(blob), firstUrl);

		const blockedDirectory = join(tempDir, "blocked");
		mkdirSync(blockedDirectory);
		const blockedBlob = createImageBlob("image/jpeg", JPEG_BASE64);
		assert.ok(blockedBlob);
		mkdirSync(join(blockedDirectory, `${blockedBlob.key}.jpg`));
		const blockedPublisher = createContentAddressedImagePublisher({
			publicBaseUrl: "https://images.example.test/blocked/",
			outputDirectory: blockedDirectory,
		});
		await assert.rejects(() => blockedPublisher.publish(blockedBlob), /existing path is not a regular file/);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("direct Anthropic images rewrite immutably", async () => {
	const payload = {
		messages: [{ role: "user", content: [
			{ type: "text", text: "describe" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
		] }],
		metadata: { trace: "keep" },
	};
	const original = structuredClone(payload);
	const publisher = new RecordingPublisher();
	const rewritten = await rewriteSupportedImagePayload(
		payload,
		imageModel("anthropic", "anthropic-messages"),
		publisher,
	);

	assert.deepEqual(payload, original);
	assert.notEqual(rewritten, payload);
	assert.deepEqual(rewritten, {
		messages: [{ role: "user", content: [
			{ type: "text", text: "describe" },
			{ type: "image", source: { type: "url", url: `https://images.example.test/${publisher.images[0].key}` } },
		] }],
		metadata: { trace: "keep" },
	});
	assert.equal(publisher.images.length, 1);
	assert.equal(publisher.images[0].mimeType, "image/png");
	assert.equal(publisher.images[0].base64, PNG_BASE64);
});

test("OpenAI Chat preserves image_url fields and publishes duplicate content once", async () => {
	const dataUrl = `data:image/png;base64,${PNG_BASE64}`;
	const payload = { messages: [{ role: "user", content: [
		{ type: "image_url", image_url: { url: dataUrl, detail: "high" } },
		{ type: "image_url", image_url: { url: dataUrl } },
	] }] };
	const publisher = new RecordingPublisher();
	const rewritten = await rewriteSupportedImagePayload(
		payload,
		imageModel("openai", "openai-completions"),
		publisher,
	);
	const url = `https://images.example.test/${publisher.images[0].key}`;

	assert.equal(publisher.images.length, 1);
	assert.deepEqual(rewritten, { messages: [{ role: "user", content: [
		{ type: "image_url", image_url: { url, detail: "high" } },
		{ type: "image_url", image_url: { url } },
	] }] });
});

test("OpenAI Responses covers message content and tool output", async () => {
	const payload = { input: [
		{
			role: "user",
			content: [{
				type: "input_image",
				detail: "auto",
				image_url: `data:image/png;base64,${PNG_BASE64}`,
			}],
		},
		{
			type: "function_call_output",
			output: [{
				type: "input_image",
				detail: "high",
				image_url: `data:image/jpeg;base64,${JPEG_BASE64}`,
			}],
		},
		{ type: "input_text", text: "keep" },
	] };
	const publisher = new RecordingPublisher();
	const rewritten = await rewriteSupportedImagePayload(
		payload,
		imageModel("openai", "openai-responses"),
		publisher,
	);

	assert.equal(publisher.images.length, 2);
	assert.deepEqual(rewritten, { input: [
		{ role: "user", content: [{
			type: "input_image",
			detail: "auto",
			image_url: `https://images.example.test/${publisher.images[0].key}`,
		}] },
		{ type: "function_call_output", output: [{
			type: "input_image",
			detail: "high",
			image_url: `https://images.example.test/${publisher.images[1].key}`,
		}] },
		{ type: "input_text", text: "keep" },
	] });

	const codexPublisher = new RecordingPublisher();
	const codexPayload = responsesImagePayload(`data:image/png;base64,${PNG_BASE64}`);
	assert.deepEqual(
		await rewriteSupportedImagePayload(
			codexPayload,
			imageModel("openai-codex", "openai-codex-responses"),
			codexPublisher,
		),
		responsesImagePayload(`https://images.example.test/${codexPublisher.images[0].key}`),
	);
});

test("unsupported targets and representations pass through before validation", async () => {
	const cases: Array<{ name: string; payload: unknown; model: ProviderModelHint | undefined }> = [
		{
			name: "Anthropic-compatible provider",
			payload: { messages: [{ content: [{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
			}] }] },
			model: imageModel("amazon-bedrock", "anthropic-messages"),
		},
		{
			name: "Anthropic endpoint override",
			payload: { messages: [{ content: [{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
			}] }] },
			model: imageModel("anthropic", "anthropic-messages", "https://proxy.example.test"),
		},
		{
			name: "OpenAI Chat endpoint override",
			payload: chatImagePayload(`data:image/png;base64,${PNG_BASE64}`),
			model: imageModel("openai", "openai-completions", "https://proxy.example.test"),
		},
		{
			name: "OpenAI Responses endpoint override",
			payload: responsesImagePayload(`data:image/png;base64,${PNG_BASE64}`),
			model: imageModel("openai", "openai-responses", "https://proxy.example.test"),
		},
		{
			name: "Azure OpenAI Responses",
			payload: responsesImagePayload(`data:image/png;base64,${PNG_BASE64}`),
			model: imageModel("azure-openai-responses", "azure-openai-responses"),
		},
		{
			name: "OpenRouter malformed data remains untouched",
			payload: chatImagePayload("data:image/png;base64,%%%"),
			model: imageModel("openrouter", "openai-completions"),
		},
		{
			name: "missing model",
			payload: chatImagePayload(`data:image/png;base64,${PNG_BASE64}`),
			model: undefined,
		},
		{
			name: "text-only model",
			payload: chatImagePayload(`data:image/png;base64,${PNG_BASE64}`),
			model: { ...imageModel("openai", "openai-completions"), input: ["text"] },
		},
		{
			name: "existing remote URL",
			payload: chatImagePayload("https://existing.test/image.png"),
			model: imageModel("openai", "openai-completions"),
		},
		{
			name: "unsupported MIME",
			payload: chatImagePayload("data:image/svg+xml;base64,PHN2Zz4="),
			model: imageModel("openai", "openai-completions"),
		},
		{
			name: "malformed unsupported MIME",
			payload: chatImagePayload("data:image/svg+xml;base64"),
			model: imageModel("openai", "openai-completions"),
		},
		{
			name: "Google inlineData",
			payload: { contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: PNG_BASE64 } }] }] },
			model: imageModel("google", "google-generative-ai"),
		},
		{
			name: "Mistral imageUrl",
			payload: { messages: [{ content: [{ type: "image_url", imageUrl: `data:image/png;base64,${PNG_BASE64}` }] }] },
			model: imageModel("mistral", "mistral-conversations"),
		},
		{
			name: "Bedrock bytes",
			payload: { messages: [{ content: [{ image: { format: "png", source: { bytes: [1, 2] } } }] }] },
			model: imageModel("amazon-bedrock", "bedrock-converse-stream"),
		},
	];

	for (const testCase of cases) {
		const publisher = new RecordingPublisher();
		const result = await rewriteSupportedImagePayload(testCase.payload, testCase.model, publisher);
		assert.equal(result, undefined, testCase.name);
		assert.equal(publisher.images.length, 0, testCase.name);
	}
});

test("allowlisted malformed and ambiguous payloads reject safely before publication", async () => {
	const malformedDataUrls = [
		"data:image/png;base64",
		"data:image/png;charset=utf-8;base64,AAAA",
		"data:image/png,AAAA",
		"data:image/png;base64,",
		"data:image/png;base64,%%%",
	];
	for (const dataUrl of malformedDataUrls) {
		const publisher = new RecordingPublisher();
		await assert.rejects(
			() => rewriteSupportedImagePayload(
				chatImagePayload(dataUrl),
				imageModel("openai", "openai-completions"),
				publisher,
			),
			(error: Error) => error.message.includes("malformed openai-chat") && !error.message.includes("%%%"),
		);
		assert.equal(publisher.images.length, 0, dataUrl);
	}

	const anthropicPublisher = new RecordingPublisher();
	await assert.rejects(
		() => rewriteSupportedImagePayload(
			{ messages: [{ content: [{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "%%%" },
			}] }] },
			imageModel("anthropic", "anthropic-messages"),
			anthropicPublisher,
		),
		/invalid base64/,
	);
	assert.equal(anthropicPublisher.images.length, 0);

	const mixedPublisher = new RecordingPublisher();
	await assert.rejects(
		() => rewriteSupportedImagePayload(
			{
				messages: [{ content: [{
					type: "image_url",
					image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
				}] }],
				input: [{ type: "input_image", image_url: `data:image/png;base64,${PNG_BASE64}` }],
			},
			imageModel("openai", "openai-completions"),
			mixedPublisher,
		),
		(error: Error) =>
			error.message.includes("openai-chat") &&
			error.message.includes("openai-responses") &&
			!error.message.includes(PNG_BASE64),
	);
	assert.equal(mixedPublisher.images.length, 0);
});

test("publication failure and cancellation cannot produce a partial replacement", async () => {
	const payload = { messages: [{ content: [
		{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
		{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG_BASE64}` } },
	] }] };
	const original = structuredClone(payload);
	const publisher = new RecordingPublisher();
	publisher.failAt = 2;
	await assert.rejects(
		() => rewriteSupportedImagePayload(
			payload,
			imageModel("openai", "openai-completions"),
			publisher,
		),
		/publication failed/,
	);
	assert.deepEqual(payload, original);
	assert.equal(publisher.images.length, 2);

	const controller = new AbortController();
	controller.abort();
	const cancelledPublisher = new RecordingPublisher();
	assert.equal(
		await rewriteSupportedImagePayload(
			payload,
			imageModel("openai", "openai-completions"),
			cancelledPublisher,
			controller.signal,
		),
		undefined,
	);
	assert.equal(cancelledPublisher.images.length, 0);
});

test("Codex retries a rewritten pre-content failure inline and quarantines later turns", async () => {
	const sources: string[] = [];
	const baseStream: Parameters<typeof createCodexImageFallback>[0] = (_model, _context, options) => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const rewritten = await options?.onPayload?.({ inline: true }, CODEX_MODEL);
			const source =
				typeof rewritten === "object" && rewritten !== null && "remote" in rewritten
					? "url"
					: "inline";
			sources.push(source);
			const pending = assistantMessage("pending");
			const events: AssistantMessageEvent[] = sources.length === 1
				? [
					{ type: "start", partial: pending },
					{ type: "error", reason: "error", error: assistantMessage("error", "URL rejected") },
				]
				: [
					{ type: "start", partial: pending },
					{ type: "done", reason: "stop", message: assistantMessage("stop") },
				];
			for (const event of events) stream.push(event);
		})();
		return stream;
	};
	const rewrittenInputs: unknown[] = [];
	const recoveryDiagnostics: Array<string | undefined> = [];
	const fallback = createCodexImageFallback(baseStream, async payload => {
		rewrittenInputs.push(payload);
		return { ...(payload as Record<string, unknown>), remote: true };
	}, {
		rewriteFailed() {},
		retryingInline: error => recoveryDiagnostics.push(error),
	});
	let chainedPayloads = 0;

	const recovered = await collectEvents(fallback.streamSimple(CODEX_MODEL, EMPTY_CONTEXT, {
		onPayload: payload => {
			chainedPayloads += 1;
			return { ...(payload as Record<string, unknown>), chained: true };
		},
	}));
	assert.deepEqual(sources, ["url", "inline"]);
	assert.deepEqual(recovered.map(event => event.type), ["start", "done"]);
	assert.deepEqual(rewrittenInputs, [{ inline: true, chained: true }]);
	assert.equal(chainedPayloads, 2);
	assert.deepEqual(recoveryDiagnostics, ["URL rejected"]);
	assert.equal(fallback.isQuarantined(), true);

	await collectEvents(fallback.streamSimple(CODEX_MODEL, EMPTY_CONTEXT));
	assert.deepEqual(sources, ["url", "inline", "inline"]);
});

test("Codex does not retry after content or an abort", async () => {
	const cases: Array<{ name: string; events: AssistantMessageEvent[]; signal?: AbortSignal }> = [
		{
			name: "content exposed",
			events: [
				{ type: "start", partial: assistantMessage("pending") },
				{ type: "text_start", contentIndex: 0, partial: assistantMessage("pending") },
				{ type: "error", reason: "error", error: assistantMessage("error", "stream failed") },
			],
		},
		{
			name: "aborted",
			events: [{ type: "error", reason: "aborted", error: assistantMessage("aborted", "aborted") }],
			signal: AbortSignal.abort(),
		},
	];

	for (const testCase of cases) {
		let attempts = 0;
		const baseStream: Parameters<typeof createCodexImageFallback>[0] = (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				await options?.onPayload?.({ inline: true }, CODEX_MODEL);
				attempts += 1;
				for (const event of testCase.events) stream.push(event);
			})();
			return stream;
		};
		const fallback = createCodexImageFallback(baseStream, async payload => ({ payload, remote: true }));
		const events = await collectEvents(
			fallback.streamSimple(CODEX_MODEL, EMPTY_CONTEXT, { signal: testCase.signal }),
		);
		assert.equal(attempts, 1, testCase.name);
		assert.deepEqual(events, testCase.events, testCase.name);
		assert.equal(fallback.isQuarantined(), false, testCase.name);
	}
});

test("Codex fallback unwraps its effective transport across extension reloads", () => {
	const baseStream: Parameters<typeof createCodexImageFallback>[0] = () => createAssistantMessageEventStream();
	const rewritePayload = async (payload: unknown) => payload;
	const firstInstance = createCodexImageFallback(baseStream, rewritePayload);
	const reloadedInstance = createCodexImageFallback(firstInstance.streamSimple, rewritePayload);

	assert.equal(unwrapCodexImageFallback(firstInstance.streamSimple), baseStream);
	assert.equal(unwrapCodexImageFallback(reloadedInstance.streamSimple), baseStream);
});

test("Codex broker rewrite failure reports once and preserves the chained inline payload", async () => {
	const receivedPayloads: unknown[] = [];
	const baseStream: Parameters<typeof createCodexImageFallback>[0] = (_model, _context, options) => {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			receivedPayloads.push(await options?.onPayload?.({ inline: true }, CODEX_MODEL));
			stream.push({ type: "start", partial: assistantMessage("pending") });
			stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
		})();
		return stream;
	};
	const rewriteFailures: unknown[] = [];
	const fallback = createCodexImageFallback(
		baseStream,
		async () => { throw new Error("disk full"); },
		{
			rewriteFailed: error => rewriteFailures.push(error),
			retryingInline() {},
		},
	);
	const events = await collectEvents(fallback.streamSimple(CODEX_MODEL, EMPTY_CONTEXT, {
		onPayload: payload => ({ ...(payload as Record<string, unknown>), chained: true }),
	}));

	assert.deepEqual(receivedPayloads, [{ inline: true, chained: true }]);
	assert.equal(rewriteFailures.length, 1);
	assert.match((rewriteFailures[0] as Error).message, /disk full/);
	assert.deepEqual(events.map(event => event.type), ["start", "done"]);
});

function createRegistrationHarness(
	initialConfig: ProviderConfig | undefined,
	effectiveStream: Parameters<typeof createCodexImageFallback>[0],
	hasNativeProvider = false,
) {
	let registeredConfig = initialConfig;
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		registerProvider: (_name: string, config: ProviderConfig) => {
			registeredConfig = { ...registeredConfig, ...config };
		},
		unregisterProvider: () => { registeredConfig = undefined; },
	} as unknown as ExtensionAPI;
	const ctx = {
		modelRegistry: {
			getRegisteredProviderConfig: () => registeredConfig,
			getRegisteredNativeProvider: () => hasNativeProvider ? {} : undefined,
			getProvider: () => ({ streamSimple: effectiveStream }),
		},
	};
	return {
		pi,
		ctx,
		start: async () => handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx),
		shutdown: async () => handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, ctx),
		getConfig: () => registeredConfig,
		mergeConfig: (config: ProviderConfig) => { registeredConfig = { ...registeredConfig, ...config }; },
	};
}

test("Codex registration skips mismatched legacy APIs and native extension providers", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "image-url-broker-registration-"));
	try {
		const configPath = join(tempDir, "config.json");
		writeConfig(configPath, {
			publicBaseUrl: "https://images.example.test/",
			outputDirectory: join(tempDir, "images"),
		});

		const successfulStream = (counter: () => void): Parameters<typeof createCodexImageFallback>[0] =>
			(_model, _context, options) => {
				counter();
				const stream = createAssistantMessageEventStream();
				void (async () => {
					await options?.onPayload?.({}, CODEX_MODEL);
					stream.push({ type: "start", partial: assistantMessage("pending") });
					stream.push({ type: "done", reason: "stop", message: assistantMessage("stop") });
				})();
				return stream;
			};
		const effectiveStream = successfulStream(() => {});
		const mismatchedStream = successfulStream(() => {});
		const initialConfig: ProviderConfig = {
			api: "anthropic-messages",
			streamSimple: mismatchedStream,
			headers: { "x-test": "preserve" },
		};
		const mismatched = createRegistrationHarness(initialConfig, effectiveStream);
		registerImageUrlBrokerExtension(mismatched.pi, { configPath });
		await mismatched.start();
		assert.equal(mismatched.getConfig()?.api, initialConfig.api);
		assert.equal(mismatched.getConfig()?.streamSimple, initialConfig.streamSimple);

		const native = createRegistrationHarness(undefined, effectiveStream, true);
		registerImageUrlBrokerExtension(native.pi, { configPath });
		await native.start();
		assert.equal(native.getConfig(), undefined);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Codex shutdown restores only broker-owned provider fields", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "image-url-broker-restoration-"));
	try {
		const configPath = join(tempDir, "config.json");
		writeConfig(configPath, {
			publicBaseUrl: "https://images.example.test/",
			outputDirectory: join(tempDir, "images"),
		});
		let codexTransportCalls = 0;
		let genericProviderCalls = 0;
		const completedStream = (onCall: () => void): Parameters<typeof createCodexImageFallback>[0] =>
			() => {
				onCall();
				return eventStream([
					{ type: "start", partial: assistantMessage("pending") },
					{ type: "done", reason: "stop", message: assistantMessage("stop") },
				]);
			};
		const codexTransport = completedStream(() => { codexTransportCalls += 1; });
		const genericProviderStream = completedStream(() => { genericProviderCalls += 1; });
		const priorConfig: ProviderConfig = {
			api: "openai-codex-responses",
			streamSimple: codexTransport,
			headers: { "x-prior": "preserve" },
		};

		const clean = createRegistrationHarness(priorConfig, genericProviderStream);
		registerImageUrlBrokerExtension(clean.pi, { configPath, streamByApi: genericProviderStream });
		await clean.start();
		assert.notEqual(clean.getConfig()?.streamSimple, codexTransport);
		assert.ok(clean.getConfig()?.streamSimple);
		await collectEvents(clean.getConfig().streamSimple(CODEX_MODEL, EMPTY_CONTEXT));
		assert.equal(codexTransportCalls, 1);
		assert.equal(genericProviderCalls, 0);
		await clean.shutdown();
		assert.equal(clean.getConfig()?.api, priorConfig.api);
		assert.equal(clean.getConfig()?.streamSimple, codexTransport);
		assert.deepEqual(clean.getConfig()?.headers, priorConfig.headers);

		const apiChanged = createRegistrationHarness(priorConfig, genericProviderStream);
		registerImageUrlBrokerExtension(apiChanged.pi, { configPath, streamByApi: genericProviderStream });
		await apiChanged.start();
		apiChanged.mergeConfig({ api: "openai-responses", headers: { "x-later": "preserve" } });
		assert.ok(apiChanged.getConfig()?.streamSimple);
		const nonCodexModel = { ...CODEX_MODEL, api: "openai-responses" } as Model<"openai-responses">;
		await collectEvents(apiChanged.getConfig().streamSimple(nonCodexModel, EMPTY_CONTEXT));
		assert.equal(codexTransportCalls, 1);
		assert.equal(genericProviderCalls, 1);
		await apiChanged.shutdown();
		assert.equal(apiChanged.getConfig()?.api, "openai-responses");
		assert.equal(apiChanged.getConfig()?.streamSimple, undefined);
		assert.deepEqual(apiChanged.getConfig()?.headers, { "x-later": "preserve" });

		let stockCodexCalls = 0;
		const stockCodexStream = completedStream(() => { stockCodexCalls += 1; });
		const stock = createRegistrationHarness(undefined, stockCodexStream);
		registerImageUrlBrokerExtension(stock.pi, { configPath, streamByApi: genericProviderStream });
		await stock.start();
		assert.ok(stock.getConfig()?.streamSimple);
		await collectEvents(stock.getConfig().streamSimple(CODEX_MODEL, EMPTY_CONTEXT));
		assert.equal(stockCodexCalls, 1);
		stock.mergeConfig({ api: "openai-responses" });
		await collectEvents(stock.getConfig().streamSimple(nonCodexModel, EMPTY_CONTEXT));
		assert.equal(stockCodexCalls, 1);
		assert.equal(genericProviderCalls, 2);
		await stock.shutdown();
		assert.equal(stock.getConfig()?.api, "openai-responses");
		assert.equal(stock.getConfig()?.streamSimple, undefined);

		const replacementStream: Parameters<typeof createCodexImageFallback>[0] = () => createAssistantMessageEventStream();
		const streamChanged = createRegistrationHarness(priorConfig, genericProviderStream);
		registerImageUrlBrokerExtension(streamChanged.pi, { configPath, streamByApi: genericProviderStream });
		await streamChanged.start();
		streamChanged.mergeConfig({ api: "openai-codex-responses", streamSimple: replacementStream });
		await streamChanged.shutdown();
		assert.equal(streamChanged.getConfig()?.streamSimple, replacementStream);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});
