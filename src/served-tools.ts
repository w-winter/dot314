// The query's MCP tool server, kept in step with Pi's active tools.
//
// A Pi extension can change the active tool set from inside a tool call
// (`subagents_enable`, pi-web-access's `web_enable` call pi.setActiveTools).
// One Claude Code query spans the whole turn, so tools registered only at query
// start would stay invisible to the model until the next user prompt. The
// server therefore registers tools on the live McpServer instance, whose
// registerTool/remove send notifications/tools/list_changed, and CC re-lists.
//
// CC builds the model's next request as soon as a tool result lands, and it
// applies a re-list asynchronously, so a result delivered right after the
// notification goes out with the OLD tool set (measured against CC 2.1.283:
// 0/5 without a hold, 5/5 with it). `update` therefore resolves only once CC
// has fetched tools/list, capped at RELIST_TIMEOUT_MS.
//
// A tool Pi deactivates is WITHDRAWN, not removed: it disappears from
// tools/list but stays registered. Claude Code may invoke the MCP handler of a
// call Pi already executed after Pi's callback (the result then waits in the
// queue), and the SDK's call handler answers `Tool … not found` for an
// unregistered name before ours runs, which would replace the real output. A
// genuinely new call under a withdrawn name has no recorded tool_use to claim
// (the name no longer maps to Pi), so the handler rejects it.
//
// For the same reason a changed declaration (same name, new schema) is
// POSTPONED while the tool has a call Claude already issued whose MCP
// invocation has not arrived: the SDK validates that invocation against the
// registered schema before our handler runs, and the new schema may reject the
// old arguments. Claude Code cannot send another model request until that
// invocation is answered, so applying the redefinition when it arrives
// (retryDeferred, with the result held for the re-list) still gives the next
// request the new schema.
//
// A call can also finish without reaching our handler: the SDK rejects
// arguments that fail the registered schema before the handler runs. Claude
// Code tags every tools/call with its tool_use id (`_meta` key
// CLAUDE_CODE_TOOL_USE_ID), so once the SDK has answered a call, `callFinished`
// retires that id and the postponed redefinition applies before the answer
// goes back, still ahead of the next model request. Without the tag, the
// bridge retires the id when Claude Code reports the call's tool_result
// (consume-query.ts), which bounds the postponement to that call's lifetime.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "@earendil-works/pi-ai";
import { debug } from "./debug.js";
import type { McpResult } from "./extract-tool-results.js";
import { jsonSchemaToZodShape } from "./typebox-to-zod.js";

export const RELIST_TIMEOUT_MS = 2_000;
/** The `_meta` key under which Claude Code sends a tools/call's tool_use id. */
export const CLAUDE_CODE_TOOL_USE_ID = "claudecode/toolUseId";

export type ServedToolHandler = (args?: Record<string, unknown>) => Promise<McpResult>;
export type ServedToolUpdate = "relisted" | "timeout" | "not-connected";
export interface ServedToolHooks {
	/** Whether `name`'s declaration must not change yet (see update). */
	redefinitionBlocked?: (name: string) => boolean;
	/** Called once the SDK has answered the tools/call for `toolUseId`, whether
	 *  or not our handler ran; the answer is sent after the returned promise. */
	callFinished?: (toolUseId: string) => Promise<unknown> | null;
}

type McpServerInstance = ReturnType<typeof createSdkMcpServer>["instance"];
type RegisteredTool = ReturnType<McpServerInstance["registerTool"]>;
type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

/** Pi reports a changed definition as removal + addition; comparing the
 *  declaration catches a same-name redefinition too. */
function toolSignature(tool: Tool): string {
	return JSON.stringify([tool.description, tool.parameters]);
}

export class ServedToolServer {
	readonly config: ReturnType<typeof createSdkMcpServer>;
	private readonly registered = new Map<string, { signature: string; handle: RegisteredTool }>();
	private readonly withdrawn = new Set<string>();
	private readonly deferred = new Set<string>();
	private desired: Tool[] = [];
	private listObserved = false;
	private relistWaiters: Array<() => void> = [];
	private readonly handlerFor: (tool: Tool) => ServedToolHandler;
	private readonly hooks: ServedToolHooks;

	constructor(name: string, tools: Tool[], handlerFor: (tool: Tool) => ServedToolHandler, hooks: ServedToolHooks = {}) {
		this.handlerFor = handlerFor;
		this.hooks = hooks;
		this.desired = tools;
		// Tools are registered here rather than through createSdkMcpServer's
		// `tools` option so every tool, initial or added later, has a
		// RegisteredTool handle that can remove it.
		this.config = createSdkMcpServer({ name, version: "1.0.0", tools: [] });
		for (const tool of tools) this.register(tool);
		this.observeRelist();
		this.observeCalls();
	}

	/** The advertised tool names. */
	get names(): string[] {
		return [...this.registered.keys()].filter((name) => !this.withdrawn.has(name));
	}

	serves(name: string): boolean {
		return this.registered.has(name) && !this.withdrawn.has(name);
	}

	/** Serve exactly `tools`. Returns null when nothing changed. Otherwise
	 *  resolves once CC has re-listed, after `timeoutMs` without a re-list, or at
	 *  once when no client is connected (the next connection lists the new set). */
	update(tools: Tool[], timeoutMs = RELIST_TIMEOUT_MS): Promise<ServedToolUpdate> | null {
		this.desired = tools;
		const next = new Map(tools.map((tool) => [tool.name, tool]));
		let changed = false;
		let visibilityChanged = false;
		for (const [name, entry] of this.registered) {
			const tool = next.get(name);
			if (tool && toolSignature(tool) === entry.signature) {
				this.deferred.delete(name);
				if (this.withdrawn.delete(name)) visibilityChanged = true;
				continue;
			}
			if (tool && this.hooks.redefinitionBlocked?.(name)) {
				// Keeps serving (and advertising) the old declaration for now.
				this.deferred.add(name);
				if (this.withdrawn.delete(name)) visibilityChanged = true;
				continue;
			}
			this.deferred.delete(name);
			if (!tool && this.listObserved) {
				if (!this.withdrawn.has(name)) {
					this.withdrawn.add(name);
					visibilityChanged = true;
				}
				continue;
			}
			// Redefined (re-registered below under the same name, so a late
			// invocation still finds it), or no list hook to hide it with.
			entry.handle.remove();
			this.registered.delete(name);
			this.withdrawn.delete(name);
			changed = true;
		}
		for (const tool of next.values()) {
			if (this.registered.has(tool.name)) continue;
			this.register(tool);
			changed = true;
		}
		if (!changed && !visibilityChanged) return null;
		if (visibilityChanged) this.config.instance.sendToolListChanged();
		if (!this.config.instance.isConnected()) return Promise.resolve("not-connected");
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.relistWaiters = this.relistWaiters.filter((waiter) => waiter !== release);
				resolve("timeout");
			}, timeoutMs);
			const release = () => {
				clearTimeout(timer);
				resolve("relisted");
			};
			this.relistWaiters.push(release);
		});
	}

	/** Applies redefinitions postponed by `redefinitionBlocked` once it allows
	 *  them; null when none are pending or none can be applied yet. */
	retryDeferred(timeoutMs = RELIST_TIMEOUT_MS): Promise<ServedToolUpdate> | null {
		return this.deferred.size > 0 ? this.update(this.desired, timeoutMs) : null;
	}

	private register(tool: Tool): void {
		const handle = this.config.instance.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: jsonSchemaToZodShape(tool.parameters) },
			this.handlerFor(tool) as Parameters<McpServerInstance["registerTool"]>[2],
		);
		this.registered.set(tool.name, { signature: toolSignature(tool), handle });
	}

	// McpServer has no public hook for "the client listed tools", so wrap the
	// tools/list entry its Protocol dispatches from. Pinned SDK; if the entry is
	// missing, updates fall back to the timeout cap, deactivated tools are
	// removed outright, and this logs why.
	private observeRelist(): void {
		const handlers = (this.config.instance.server as unknown as { _requestHandlers?: Map<string, RequestHandler> })._requestHandlers;
		const list = handlers?.get("tools/list");
		if (!handlers || !list) {
			debug("WARNING: served tools cannot observe tools/list; mid-turn tool changes will wait for the timeout cap");
			return;
		}
		handlers.set("tools/list", async (request, extra) => {
			const result = await list(request, extra) as { tools: Array<{ name: string }> };
			// Next macrotask: the list response is sent after this handler returns,
			// and a tool result released earlier could overtake it on CC's stdin.
			for (const release of this.relistWaiters.splice(0)) setImmediate(release);
			return { ...result, tools: result.tools.filter((tool) => !this.withdrawn.has(tool.name)) };
		});
		this.listObserved = true;
	}

	// Same private entry, for tools/call: the SDK's handler looks the tool up
	// synchronously when called, so a redefinition applied by `callFinished` (or
	// by our handler, mid-call) cannot change the schema this call validates
	// against. If the entry is missing, the tool_result fallback applies.
	private observeCalls(): void {
		const callFinished = this.hooks.callFinished;
		if (!callFinished) return;
		const handlers = (this.config.instance.server as unknown as { _requestHandlers?: Map<string, RequestHandler> })._requestHandlers;
		const call = handlers?.get("tools/call");
		if (!handlers || !call) {
			debug("WARNING: served tools cannot observe tools/call; a rejected call releases a postponed redefinition only at its tool_result");
			return;
		}
		handlers.set("tools/call", async (request, extra) => {
			try {
				return await call(request, extra);
			} finally {
				const toolUseId = (request as { params?: { _meta?: Record<string, unknown> } }).params?._meta?.[CLAUDE_CODE_TOOL_USE_ID];
				debug(`served tools: tools/call answered [${typeof toolUseId === "string" ? toolUseId : "no tool_use id; its tool_result will settle it"}]`);
				if (typeof toolUseId === "string") await callFinished(toolUseId);
			}
		});
	}
}
