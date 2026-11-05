import type { ModelInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeChildEnv, type ClaudeAccountRoute } from "./account-router.ts";
import { preflightClaudeExecutable, resolveClaudeExecutable, spawnClaudeCodeWithDiagnostics } from "./claude-executable.ts";
import { loadConfig } from "./config.ts";
import { closeSdkQuery } from "./query-teardown.ts";
import { sdkQuery } from "./sdk-query.ts";

// Match the existing account probe's allowance for cold CLI startup.
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

/** Reads the selected CLI account's picker catalog without a model prompt.
 * Rejects on cancellation, initialization failure or timeout, and closes the worker. */
export async function discoverClaudeModels(cwd: string, account: ClaudeAccountRoute | undefined, signal: AbortSignal | undefined): Promise<ModelInfo[]> {
	if (Boolean(signal)) signal.throwIfAborted();
	const config = loadConfig(cwd);
	const executable = resolveClaudeExecutable(config.provider.pathToClaudeCodeExecutable);
	if (executable) preflightClaudeExecutable(executable, cwd);
	const controller = new AbortController();
	let closeInput!: () => void;
	const inputClosed = new Promise<void>((resolve) => { closeInput = resolve; });
	async function* input(): AsyncGenerator<SDKUserMessage> { await inputClosed; }
	const options: NonNullable<Parameters<typeof sdkQuery>[0]["options"]> = {
		cwd,
		abortController: controller,
		persistSession: false,
		settings: { autoDreamEnabled: false },
		settingSources: [],
		strictMcpConfig: true,
		tools: [],
		mcpServers: {},
		permissionMode: "dontAsk",
		env: { ...claudeChildEnv(account, config.provider.inheritAnthropicEnv), ENABLE_CLAUDEAI_MCP_SERVERS: "0" },
		spawnClaudeCodeProcess: spawnClaudeCodeWithDiagnostics,
	};
	if (executable) options.pathToClaudeCodeExecutable = executable;
	const probe = sdkQuery({ prompt: input(), options });
	const cancelled = new Promise<never>((_resolve, reject) => {
		controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
	});
	const cancel = (): void => controller.abort(signal.reason);
	if (Boolean(signal)) signal.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("Claude Code model discovery timed out")), MODEL_DISCOVERY_TIMEOUT_MS);
	try {
		return structuredClone(await Promise.race([probe.supportedModels(), cancelled]));
	} finally {
		clearTimeout(timer);
		if (Boolean(signal)) signal.removeEventListener("abort", cancel);
		closeInput();
		closeSdkQuery(probe);
	}
}
