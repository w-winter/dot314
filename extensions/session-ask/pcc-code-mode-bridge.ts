import type {
    AgentToolResult,
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";

const EXTENSION_TOOLS_CHANNEL = "@howaboua/pi-codex-conversion.extension-code-mode-tools/v1";
const EXTENSION_TOOLS_REFRESH_CHANNEL = "@howaboua/pi-codex-conversion.extension-code-mode-tools-refresh/v1";

interface CodeModeExecutionContext {
    toolCallId?: string;
    extensionContext?: ExtensionContext;
    onUpdate?: (result: AgentToolResult<unknown>) => void;
    captureResult?: (result: AgentToolResult<unknown>) => void;
    refreshTrace?: () => void;
}

interface CodeModeToolDefinition {
    name: string;
    usage: string;
    description: string;
    deferLoading: boolean;
    kind: "function";
    blocking: boolean;
    executionMode?: "sequential" | "parallel";
    inputSchema: unknown;
    invoke(input: unknown, context: CodeModeExecutionContext, signal: AbortSignal): Promise<unknown>;
    renderCall?: (input: unknown, theme: unknown, context: unknown) => unknown;
    renderResult?: (
        result: AgentToolResult<unknown>,
        options: { expanded: boolean; isPartial: boolean },
        theme: unknown,
        context: unknown,
    ) => unknown;
}

interface ExtensionToolsRequest {
    refreshGates: boolean;
    add(provider: (context: ExtensionContext | undefined) => readonly CodeModeToolDefinition[], active: boolean): void;
}

export interface PccCodeModeToolRegistrar {
    register<TParams extends TSchema, TDetails, TState>(
        tool: ToolDefinition<TParams, TDetails, TState>,
        usage: string,
    ): void;
    unregister(): void;
}

function isExtensionToolsRequest(value: unknown): value is ExtensionToolsRequest {
    return Boolean(
        value
        && typeof value === "object"
        && "add" in value
        && typeof value.add === "function"
        && "refreshGates" in value
        && typeof value.refreshGates === "boolean",
    );
}

function modelVisibleResult(result: AgentToolResult<unknown>): unknown {
    if (result.content.every((item) => item.type === "text")) {
        return result.content.map((item) => item.type === "text" ? item.text : "").join("\n") || "(no output)";
    }
    return { content: result.content.map((item) => ({ ...item })) };
}

function adaptTool<TParams extends TSchema, TDetails, TState>(
    tool: ToolDefinition<TParams, TDetails, TState>,
    usage: string,
): CodeModeToolDefinition {
    const prepareInput = (input: unknown): unknown => tool.prepareArguments?.(input) ?? input;
    return {
        name: tool.name,
        usage,
        description: tool.description,
        deferLoading: false,
        kind: "function",
        blocking: true,
        ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
        inputSchema: tool.parameters,
        async invoke(input, context, signal) {
            if (signal.aborted) throw new Error(`${tool.name} aborted`);
            const extensionContext = context.extensionContext;
            if (!extensionContext) throw new Error("Code Mode Pi context is unavailable");
            const prepared = prepareInput(input);
            if (!Check(tool.parameters, prepared)) throw new Error(`Invalid ${tool.name} arguments`);
            if (signal.aborted) throw new Error(`${tool.name} aborted`);
            let acceptingUpdates = true;
            try {
                context.refreshTrace?.();
                const result = await tool.execute(
                    context.toolCallId ?? `code-mode-${tool.name}`,
                    prepared as never,
                    signal,
                    (update) => {
                        if (acceptingUpdates) context.onUpdate?.(update as AgentToolResult<unknown>);
                    },
                    extensionContext,
                );
                acceptingUpdates = false;
                context.captureResult?.(result as AgentToolResult<unknown>);
                return modelVisibleResult(result as AgentToolResult<unknown>);
            } finally {
                acceptingUpdates = false;
            }
        },
        ...(tool.renderCall
            ? {
                renderCall: (input: unknown, theme: unknown, context: unknown) =>
                    tool.renderCall!(prepareInput(input) as never, theme as never, context as never),
            }
            : {}),
        ...(tool.renderResult
            ? {
                renderResult: (
                    result: AgentToolResult<unknown>,
                    options: { expanded: boolean; isPartial: boolean },
                    theme: unknown,
                    context: unknown,
                ) => tool.renderResult!(
                    result as AgentToolResult<TDetails>,
                    options,
                    theme as never,
                    context as never,
                ),
            }
            : {}),
    };
}

export function createPccCodeModeToolRegistrar(pi: ExtensionAPI): PccCodeModeToolRegistrar {
    const adaptedTools: CodeModeToolDefinition[] = [];
    const stopProvider = pi.events.on(EXTENSION_TOOLS_CHANNEL, (value) => {
        if (!isExtensionToolsRequest(value)) return;
        value.add(() => adaptedTools, true);
    });
    const refresh = (): void => {
        pi.events.emit(EXTENSION_TOOLS_REFRESH_CHANNEL, undefined);
    };
    let registered = true;

    return {
        register(tool, usage) {
            pi.registerTool(tool);
            adaptedTools.push(adaptTool(tool, usage));
            refresh();
        },
        unregister() {
            if (!registered) return;
            registered = false;
            stopProvider();
            refresh();
        },
    };
}
