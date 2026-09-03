import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

const EXTENSION_TOOLS_CHANNEL = "@howaboua/pi-codex-conversion.extension-code-mode-tools/v1";
const EXTENSION_TOOLS_REFRESH_CHANNEL = "@howaboua/pi-codex-conversion.extension-code-mode-tools-refresh/v1";

interface CodeModeExecutionContext {
  toolCallId?: string;
  extensionContext?: ExtensionContext;
  onUpdate?: (result: AgentToolResult<unknown>) => void;
  captureResult?: (result: AgentToolResult<unknown>) => void;
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

function adaptRpTool(tool: ToolDefinition): CodeModeToolDefinition {
  const prepareInput = (input: unknown): unknown => tool.prepareArguments?.(input) ?? input;
  return {
    name: tool.name,
    usage: "await tools.rp({ call: \"read_file\", args: { path: \"...\" } })",
    description: tool.description,
    deferLoading: false,
    kind: "function",
    // RP may own long cache-aware waits; keep cancellation attached to the outer exec cell
    blocking: true,
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    inputSchema: tool.parameters,
    async invoke(input, context, signal) {
      const extensionContext = context.extensionContext;
      if (!extensionContext) throw new Error("Code Mode Pi context is unavailable");
      const prepared = prepareInput(input);
      if (!Check(tool.parameters, prepared)) throw new Error("Invalid rp arguments");
      const result = await tool.execute(
        context.toolCallId ?? "code-mode-rp",
        prepared as never,
        signal,
        (update) => context.onUpdate?.(update as AgentToolResult<unknown>),
        extensionContext,
      );
      context.captureResult?.(result as AgentToolResult<unknown>);
      return modelVisibleResult(result as AgentToolResult<unknown>);
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
          ) => tool.renderResult!(result, options, theme as never, context as never),
        }
      : {}),
  };
}

export function registerRpCodeModeBridge(
  pi: ExtensionAPI,
  tool: ToolDefinition,
): () => void {
  const adaptedTool = adaptRpTool(tool);
  const stopProvider = pi.events.on(EXTENSION_TOOLS_CHANNEL, (value) => {
    if (!isExtensionToolsRequest(value)) return;
    value.add(() => [adaptedTool], true);
  });
  let registered = true;
  const unregister = (): void => {
    if (!registered) return;
    registered = false;
    stopProvider();
    pi.events.emit(EXTENSION_TOOLS_REFRESH_CHANNEL, undefined);
  };
  pi.events.emit(EXTENSION_TOOLS_REFRESH_CHANNEL, undefined);
  return unregister;
}
