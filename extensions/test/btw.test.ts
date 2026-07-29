import { describe, expect, test } from "bun:test";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import { EventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";

import { getRequestAuthError } from "../btw.js";
import { createSubagentRequestOptions, runSubagent } from "../lib/subagent-core.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => event.type === "done" ? event.message : event.error,
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("runSubagent", () => {
	test("test_provider_stream_receives_captured_auth_and_parent_session", async () => {
		let receivedOptions: SimpleStreamOptions | undefined;
		const providerStream: StreamFn = (_model, _context, options) => {
			receivedOptions = options;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("OK") });
			});
			return stream;
		};

		const result = await runSubagent(
			"system",
			"task",
			[],
			{ provider: "openai-codex", id: "test-model" },
			"off",
			providerStream,
			{ apiKey: "oauth-access-token" },
			"parent-session-id",
			undefined,
			() => {},
		);

		expect(result.exitCode).toBe(0);
		expect(result.finalOutput).toBe("OK");
		expect(receivedOptions?.apiKey).toBe("oauth-access-token");
		expect(receivedOptions?.sessionId).toBe("parent-session-id");
	});
});

describe("createSubagentRequestOptions", () => {
	test("test_request_options_reuse_parent_session_and_merge_auth_context", () => {
		const options = createSubagentRequestOptions(
			{
				apiKey: "oauth-access-token",
				env: { PROVIDER_SCOPE: "auth", SHARED: "auth" },
				headers: { Authorization: "Bearer token", Shared: "auth" },
			},
			"parent-session-id",
			{
				env: { TURN_SCOPE: "turn", SHARED: "turn" },
				headers: { Shared: "turn" },
				sessionId: "per-turn-id",
			},
		);

		expect(options).toMatchObject({
			apiKey: "oauth-access-token",
			env: { PROVIDER_SCOPE: "auth", TURN_SCOPE: "turn", SHARED: "turn" },
			headers: { Authorization: "Bearer token", Shared: "turn" },
			sessionId: "parent-session-id",
		});
	});
});

describe("getRequestAuthError", () => {
	test("test_openai_codex_without_oauth_token_returns_reauthentication_error", () => {
		const error = getRequestAuthError({ provider: "openai-codex" }, { ok: true });

		expect(error).toContain("/login openai-codex");
	});

	test("test_openai_codex_with_oauth_token_has_no_error", () => {
		const error = getRequestAuthError(
			{ provider: "openai-codex" },
			{ ok: true, apiKey: "oauth-access-token" },
		);

		expect(error).toBeUndefined();
	});

	test("test_registry_auth_failure_preserves_original_error", () => {
		const error = getRequestAuthError(
			{ provider: "anthropic" },
			{ ok: false, error: "credential store unavailable" },
		);

		expect(error).toBe("credential store unavailable");
	});

	test("test_provider_without_request_credentials_has_no_error", () => {
		const error = getRequestAuthError({ provider: "local" }, { ok: true });

		expect(error).toBeUndefined();
	});
});
