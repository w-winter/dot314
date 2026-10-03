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
// (Registered inputs are now pass-through, see "Schemas" below, so today the
// SDK rejects no arguments; the postponement and `callFinished` remain as the
// guard for any SDK-level rejection, such as a malformed request.)
//
// Every tool is registered under its MCP alias (mcpToolAliases), the name
// Claude Code can call it by; everything else here, including the hooks and
// `names`/`serves`, speaks Pi's tool names.
// A tool keeps its alias for the whole query, withdrawn or redefined, and a tool
// added mid-query never takes an alias another registration holds (a late
// invocation under it must reach the tool Claude called), so the newcomer may
// be served under a different alias than a fresh query would give it.
//
// Schemas: Pi validates every tool call against the tool's full JSON Schema
// (pi-agent-core's validateToolArguments) and returns a failure to the model as
// the tool result, so Pi is the one validation authority. The SDK's
// registerTool only takes Zod, and converting JSON Schema to Zod lost $ref,
// unions, nullable types, integer and most constraints. So each tool is
// registered with a Zod input that accepts any object and changes nothing
// (PASS_THROUGH_INPUT), and tools/list advertises the tool's own schema
// (advertisedInputSchema) instead of the SDK's rendering of that Zod input.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "@earendil-works/pi-ai";
import { z } from "zod";
import { debug } from "./debug.ts";
import type { McpResult } from "./extract-tool-results.ts";
import { isDraft2020Schema } from "./json-schema-2020.ts";
import { mcpToolAliases } from "./tool-mapping.ts";

export const RELIST_TIMEOUT_MS = 2_000;
/** Claude Code's per-call wall-clock limit for this server. CC applies
 *  `timeout ?? MCP_TOOL_TIMEOUT ?? 1e8 ms` to in-process SDK servers too, and a
 *  user's shell commonly exports MCP_TOOL_TIMEOUT for other servers (e.g.
 *  300000). When it fires, CC answers the call itself ("timed out after Ns"),
 *  the model finishes its turn without the result, the SDK closes the query,
 *  and the real result Pi produces later is orphaned. A Pi tool's lifetime is
 *  Pi's to decide (abort, the tool's own timeout), so the limit is set to CC's
 *  own ceiling (the largest timer delay it accepts), which no Pi tool reaches. */
export const PI_TOOL_CALL_TIMEOUT_MS = 2_147_483_647;
/** The `_meta` key under which Claude Code sends a tools/call's tool_use id. */
export const CLAUDE_CODE_TOOL_USE_ID = "claudecode/toolUseId";

/** Accepts any arguments object and passes every key through unchanged (a
 *  plain z.object({}) would strip unknown keys). */
const PASS_THROUGH_INPUT = z.looseObject({});

// Root keywords the model needs to read the properties right: `$ref` targets
// and the object's own additionalProperties. Other root keywords are dropped,
// as Pi's native Anthropic provider drops them. Claude Code skips any MCP tool
// whose schema has a root anyOf/oneOf/allOf (CC 2.1.283, "which the Anthropic
// API does not accept").
const ADVERTISED_ROOT_KEYWORDS = ["$defs", "definitions", "additionalProperties"] as const;

/** The input schema tools/list advertises for a Pi tool: the shape Pi's native
 *  Anthropic provider declares (pi-ai convertTools: `type: "object"`, the
 *  tool's `properties` and `required`, verbatim), plus the root keywords the
 *  properties depend on. Pi's non-strict declaration drops root `$defs`, which
 *  leaves every `#/$defs/...` reference dangling; measured with Haiku 4.5, the
 *  model then sent a $ref'd object as a JSON string and null as "null".
 *
 *  A part that is not valid JSON Schema 2020-12 (a draft-04 boolean
 *  `exclusiveMinimum`, a draft-07 tuple `items: [...]`) would make the API
 *  reject every request of the session (see json-schema-2020.ts). Such a
 *  property or `$defs` entry is advertised as `{}` with its description, an
 *  invalid `required` as `[]`, and an invalid `additionalProperties` not at
 *  all. Pi still validates arguments against the tool's full schema. */
export function advertisedInputSchema(parameters: unknown, toolName = "tool"): Record<string, unknown> {
	const schema = JSON.parse(JSON.stringify(parameters ?? {})) as Record<string, unknown>;
	const loosened: string[] = [];
	const subschema = (value: unknown, path: string): unknown => {
		if (isDraft2020Schema(value)) return value;
		loosened.push(path);
		const description = typeof value === "object" && value !== null ? (value as { description?: unknown }).description : undefined;
		return typeof description === "string" ? { description } : {};
	};
	const subschemas = (value: unknown, path: string): Record<string, unknown> => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			loosened.push(path);
			return {};
		}
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, subschema(entry, `${path}.${key}`)]));
	};
	const advertised: Record<string, unknown> = {
		type: "object",
		properties: subschemas(schema.properties ?? {}, "properties"),
		required: schema.required ?? [],
	};
	if (!isDraft2020Schema({ required: advertised.required })) {
		loosened.push("required");
		advertised.required = [];
	}
	for (const keyword of ADVERTISED_ROOT_KEYWORDS) {
		const value = schema[keyword];
		if (value === undefined) continue;
		if (keyword !== "additionalProperties") advertised[keyword] = subschemas(value, keyword);
		else if (isDraft2020Schema(value)) advertised[keyword] = value;
		else loosened.push(keyword);
	}
	if (loosened.length > 0) {
		debug(`WARNING: served tools: ${toolName} advertises ${loosened.join(", ")} without its schema: not valid JSON Schema 2020-12, which the Anthropic API requires of every tool. Pi still validates the arguments.`);
	}
	return advertised;
}

/** Registered as the MCP tool callback, so it receives the request's
 *  RequestHandlerExtra, whose `_meta` carries CLAUDE_CODE_TOOL_USE_ID and
 *  whose `signal` aborts when the client cancels the request. */
export type ServedToolHandler = (args?: Record<string, unknown>, extra?: { _meta?: Record<string, unknown>; signal?: AbortSignal }) => Promise<McpResult>;
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
	/** Keyed by Pi tool name; `alias` is the MCP name it is registered under. */
	private readonly registered = new Map<string, { signature: string; alias: string; inputSchema: Record<string, unknown>; handle: RegisteredTool }>();
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
		this.config = createSdkMcpServer({ name, version: "1.0.0", tools: [], timeout: PI_TOOL_CALL_TIMEOUT_MS });
		const aliases = mcpToolAliases(tools.map((tool) => tool.name));
		for (const tool of tools) this.register(tool, aliases.get(tool.name) ?? tool.name);
		this.observeRelist();
		this.observeCalls();
	}

	/** The advertised tools' Pi names. */
	get names(): string[] {
		return [...this.registered.keys()].filter((name) => !this.withdrawn.has(name));
	}

	serves(name: string): boolean {
		return this.registered.has(name) && !this.withdrawn.has(name);
	}

	/** Pi name -> MCP alias of each advertised tool, as registered: the source
	 *  of the query's reverse name manifest once tools change mid-query. */
	get aliases(): Map<string, string> {
		return new Map([...this.registered].filter(([name]) => !this.withdrawn.has(name)).map(([name, entry]) => [name, entry.alias]));
	}

	/** Serve exactly `tools`. Returns null when nothing changed. Otherwise
	 *  resolves once CC has re-listed, after `timeoutMs` without a re-list, or at
	 *  once when no client is connected (the next connection lists the new set). */
	update(tools: Tool[], timeoutMs = RELIST_TIMEOUT_MS): Promise<ServedToolUpdate> | null {
		this.desired = tools;
		const next = new Map(tools.map((tool) => [tool.name, tool]));
		// A registered tool (active, withdrawn or with a postponed redefinition)
		// keeps its alias for the whole query, and a newcomer never takes it: a
		// late invocation under that alias must reach the tool Claude called.
		const owned = new Map([...this.registered].map(([name, entry]) => [name, entry.alias]));
		const aliases = mcpToolAliases(next.keys(), owned);
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
			// Redefined (re-registered below under the same alias, so a late
			// invocation still finds it), or no list hook to hide it with.
			entry.handle.remove();
			this.registered.delete(name);
			this.withdrawn.delete(name);
			changed = true;
		}
		for (const tool of next.values()) {
			if (this.registered.has(tool.name)) continue;
			this.register(tool, aliases.get(tool.name) ?? tool.name);
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

	private register(tool: Tool, alias: string): void {
		const handle = this.config.instance.registerTool(
			alias,
			{ description: tool.description, inputSchema: PASS_THROUGH_INPUT },
			this.handlerFor(tool) as Parameters<McpServerInstance["registerTool"]>[2],
		);
		this.registered.set(tool.name, { signature: toolSignature(tool), alias, inputSchema: advertisedInputSchema(tool.parameters, tool.name), handle });
	}

	// McpServer has no public hook for "the client listed tools", nor for the
	// schema it lists, so wrap the tools/list entry its Protocol dispatches from.
	// Pinned SDK; if the entry is missing, updates fall back to the timeout cap,
	// deactivated tools are removed outright, tools are listed with the SDK's
	// empty rendering of PASS_THROUGH_INPUT, and this logs why.
	private observeRelist(): void {
		const handlers = (this.config.instance.server as unknown as { _requestHandlers?: Map<string, RequestHandler> })._requestHandlers;
		const list = handlers?.get("tools/list");
		if (!handlers || !list) {
			debug("WARNING: served tools cannot observe tools/list; tools are listed without their parameters and mid-turn tool changes will wait for the timeout cap");
			return;
		}
		handlers.set("tools/list", async (request, extra) => {
			const result = await list(request, extra) as { tools: Array<{ name: string; inputSchema?: unknown }> };
			// Next macrotask: the list response is sent after this handler returns,
			// and a tool result released earlier could overtake it on CC's stdin.
			for (const release of this.relistWaiters.splice(0)) setImmediate(release);
			const hidden = new Set([...this.withdrawn].map((name) => this.registered.get(name)?.alias));
			const schemas = new Map([...this.registered.values()].map((entry) => [entry.alias, entry.inputSchema]));
			return {
				...result,
				tools: result.tools
					.filter((tool) => !hidden.has(tool.name))
					.map((tool) => ({ ...tool, inputSchema: schemas.get(tool.name) ?? tool.inputSchema })),
			};
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
