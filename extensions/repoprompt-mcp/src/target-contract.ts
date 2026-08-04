import { normalizeToolName } from "./tool-names.js";
import type { RpAppId, RpToolMeta } from "./types.js";

export {
  AGENT_MANAGE_OPERATIONS,
  AGENT_RUN_OPERATIONS,
  BIND_CONTEXT_OPERATIONS,
  MANAGE_WORKSPACES_ACTIONS,
  MANAGE_WORKTREE_OPERATIONS,
  classifyForwardingOperation,
} from "./tool-forwarding-policy.js";
export type { ForwardingClass, OperationClassification } from "./tool-forwarding-policy.js";

export type SupportedTargetContract = "ce-1.2" | "classic-2.1.32";
export type OracleMode = "chat" | "plan" | "edit" | "review";

export type ContractEvidenceStatus = "proven" | "rejected" | "unresolved";

export interface TargetContractEvidence {
  readonly jsonInventory: ContractEvidenceStatus;
  readonly connectionBinding: ContractEvidenceStatus;
  readonly hiddenRawJson: ContractEvidenceStatus;
  readonly hiddenWindowSelector: ContractEvidenceStatus;
  readonly diagnostic?: string;
}

export type FeatureCapability<T> =
  | { kind: "available"; value: T }
  | { kind: "unavailable"; diagnostic: string };

export interface TargetCapabilities {
  readonly inventoryRequiresObservation: boolean;
  readonly evidence: TargetContractEvidence;
  readonly oracle: FeatureCapability<{ readonly modes: readonly OracleMode[] }>;
  readonly codeStructure: FeatureCapability<{ readonly vocabulary: readonly string[] }>;
  readonly rootObservation: FeatureCapability<{ readonly hiddenSelector: "_windowID" }>;
}

export type TargetCapabilityResult =
  | { kind: "supported"; capabilities: TargetCapabilities }
  | { kind: "unsupported"; diagnostics: readonly string[] };

export interface TargetContract {
  readonly id: SupportedTargetContract;
  readonly app: RpAppId;
  readonly oracleModes: readonly OracleMode[];
  readonly codeStructureVocabulary: readonly string[];
  readonly evidence: TargetContractEvidence;
  readonly boundConnectionBindingKind: "tab_context" | "context";
  inventoryArgs(): Readonly<Record<string, unknown>>;
  bindArgs(contextId: string, windowId: number): Readonly<Record<string, unknown>>;
  rootObservationArgs(windowId: number): Readonly<Record<string, unknown>>;
  inspectCapabilities(tools: readonly RpToolMeta[]): TargetCapabilityResult;
}

interface JsonSchema {
  readonly type?: unknown;
  readonly properties?: unknown;
  readonly required?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function schemaProperties(schema: unknown): Record<string, unknown> | null {
  const record = asRecord(schema) as JsonSchema | null;
  return asRecord(record?.properties);
}

function schemaRequired(schema: unknown): readonly unknown[] {
  const record = asRecord(schema) as JsonSchema | null;
  return Array.isArray(record?.required) ? record.required : [];
}

function enumValues(schema: unknown): readonly unknown[] {
  const record = asRecord(schema);
  return Array.isArray(record?.enum) ? record.enum : [];
}

function findTool(tools: readonly RpToolMeta[], name: string): RpToolMeta | undefined {
  return tools.find((tool) => normalizeToolName(tool.name).toLowerCase() === name);
}

interface ExpectedSchemaProperty {
  readonly type: string;
  readonly enumValues?: readonly string[];
  readonly itemType?: string;
}

function inspectToolSchema(args: {
  tools: readonly RpToolMeta[];
  toolName: string;
  allowedRequired: readonly string[];
  expectedProperties: Readonly<Record<string, ExpectedSchemaProperty>>;
}): readonly string[] {
  const tool = findTool(args.tools, args.toolName);
  if (!tool) {
    return [`Missing required tool ${args.toolName}`];
  }

  const schema = asRecord(tool.inputSchema);
  const properties = schemaProperties(tool.inputSchema);
  if (schema?.type !== "object" || !properties) {
    return [`${args.toolName} does not advertise an object input schema`];
  }

  const diagnostics: string[] = [];
  const required = schemaRequired(tool.inputSchema);
  if (required.some((property) => typeof property !== "string")) {
    diagnostics.push(`${args.toolName}.required contains a non-string property`);
  }
  for (const property of args.allowedRequired) {
    if (!required.includes(property)) {
      diagnostics.push(`${args.toolName}.${property} is not required`);
    }
  }
  for (const property of required) {
    if (typeof property === "string" && !args.allowedRequired.includes(property)) {
      diagnostics.push(`${args.toolName} adds unsupported required property ${property}`);
    }
  }

  for (const [propertyName, expected] of Object.entries(args.expectedProperties)) {
    const property = asRecord(properties[propertyName]);
    if (!property) {
      diagnostics.push(`${args.toolName} does not advertise ${propertyName}`);
      continue;
    }
    if (property.type !== expected.type) {
      diagnostics.push(`${args.toolName}.${propertyName} is not type ${expected.type}`);
    }
    if (expected.itemType) {
      const items = asRecord(property.items);
      if (items?.type !== expected.itemType) {
        diagnostics.push(`${args.toolName}.${propertyName} items are not type ${expected.itemType}`);
      }
    }
    for (const value of expected.enumValues ?? []) {
      if (!enumValues(property).includes(value)) {
        diagnostics.push(`${args.toolName}.${propertyName} does not advertise ${value}`);
      }
    }
  }

  return diagnostics;
}

function inspectOptionalFeature<T>(args: {
  tools: readonly RpToolMeta[];
  toolName: string;
  allowedRequired: readonly string[];
  expectedProperties: Readonly<Record<string, ExpectedSchemaProperty>>;
  value: T;
}): FeatureCapability<T> {
  if (!findTool(args.tools, args.toolName)) {
    return { kind: "unavailable", diagnostic: `${args.toolName} is not advertised by this target` };
  }

  const diagnostics = inspectToolSchema(args);
  return diagnostics.length > 0
    ? { kind: "unavailable", diagnostic: diagnostics.join("; ") }
    : { kind: "available", value: args.value };
}

interface TargetProfileOptions {
  readonly id: SupportedTargetContract;
  readonly app: RpAppId;
  readonly oracleModes: readonly OracleMode[];
  readonly codeStructureVocabulary: readonly string[];
  readonly bindIncludesWindowId: boolean;
  readonly boundConnectionBindingKind: "tab_context" | "context";
  readonly evidence: TargetContractEvidence;
}

function createTargetContract(options: TargetProfileOptions): TargetContract {
  return {
    id: options.id,
    app: options.app,
    oracleModes: options.oracleModes,
    codeStructureVocabulary: options.codeStructureVocabulary,
    evidence: options.evidence,
    boundConnectionBindingKind: options.boundConnectionBindingKind,
    inventoryArgs: () => ({ op: "list", _rawJSON: true }),
    bindArgs: (contextId, windowId) => ({
      op: "bind",
      context_id: contextId,
      ...(options.bindIncludesWindowId ? { window_id: windowId } : {}),
    }),
    rootObservationArgs: (windowId) => ({ type: "roots", _windowID: windowId, _rawJSON: true }),
    inspectCapabilities: (tools) => {
      const bindContextProperties: Record<string, ExpectedSchemaProperty> = {
        op: { type: "string", enumValues: ["list", "bind"] },
        context_id: { type: "string" },
        ...(options.bindIncludesWindowId ? { window_id: { type: "integer" } } : {}),
      };
      const coreDiagnostics = [
        ...inspectToolSchema({
          tools,
          toolName: "bind_context",
          allowedRequired: ["op"],
          expectedProperties: bindContextProperties,
        }),
        ...inspectToolSchema({
          tools,
          toolName: "manage_workspaces",
          allowedRequired: ["action"],
          expectedProperties: {
            action: { type: "string", enumValues: ["create_tab"] },
            window_id: { type: "integer" },
            bind: { type: "boolean" },
            focus: { type: "boolean" },
          },
        }),
      ];

      if (coreDiagnostics.length > 0) {
        return { kind: "unsupported", diagnostics: coreDiagnostics };
      }

      const oracle = inspectOptionalFeature({
        tools,
        toolName: "oracle_send",
        allowedRequired: ["message"],
        expectedProperties: {
          message: { type: "string" },
          mode: { type: "string", enumValues: options.oracleModes },
        },
        value: { modes: options.oracleModes },
      });
      const codeStructureShapes: Readonly<Record<string, ExpectedSchemaProperty>> = {
        scope: { type: "string", enumValues: ["paths", "selected"] },
        paths: { type: "array", itemType: "string" },
        max_results: { type: "integer" },
        expand: { type: "string", enumValues: ["uses", "used_by", "both"] },
        depth: { type: "integer" },
        signatures: { type: "boolean" },
        size: { type: "string", enumValues: ["small", "medium", "large"] },
      };
      const codeStructure = inspectOptionalFeature({
        tools,
        toolName: "get_code_structure",
        allowedRequired: [],
        expectedProperties: Object.fromEntries(
          options.codeStructureVocabulary.map((property) => [property, codeStructureShapes[property]])
        ),
        value: { vocabulary: options.codeStructureVocabulary },
      });
      const fileTree = inspectOptionalFeature({
        tools,
        toolName: "get_file_tree",
        allowedRequired: [],
        expectedProperties: { type: { type: "string", enumValues: ["roots"] } },
        value: { hiddenSelector: "_windowID" as const },
      });
      const rootObservation: TargetCapabilities["rootObservation"] =
        fileTree.kind === "available" && options.evidence.hiddenWindowSelector === "proven"
          && options.evidence.hiddenRawJson === "proven"
          ? fileTree
          : {
              kind: "unavailable",
              diagnostic: fileTree.kind === "unavailable"
                ? fileTree.diagnostic
                : options.evidence.diagnostic
                  ?? `${options.id} has no proof for hidden _windowID and _rawJSON root observation`,
            };

      return {
        kind: "supported",
        capabilities: {
          inventoryRequiresObservation:
            options.evidence.jsonInventory !== "proven" || options.evidence.connectionBinding !== "proven",
          evidence: options.evidence,
          oracle,
          codeStructure,
          rootObservation,
        },
      };
    },
  };
}

export const CE_1_2_TARGET_CONTRACT = createTargetContract({
  id: "ce-1.2",
  app: "ce",
  oracleModes: ["chat", "plan", "review"],
  codeStructureVocabulary: ["paths", "expand", "depth", "signatures", "size"],
  bindIncludesWindowId: false,
  boundConnectionBindingKind: "tab_context",
  evidence: {
    jsonInventory: "proven",
    connectionBinding: "proven",
    hiddenRawJson: "proven",
    hiddenWindowSelector: "proven",
  },
});

export const CLASSIC_2_1_32_TARGET_CONTRACT = createTargetContract({
  id: "classic-2.1.32",
  app: "classic",
  oracleModes: ["chat", "plan", "edit", "review"],
  codeStructureVocabulary: ["scope", "paths", "max_results"],
  bindIncludesWindowId: true,
  boundConnectionBindingKind: "context",
  evidence: {
    jsonInventory: "unresolved",
    connectionBinding: "unresolved",
    hiddenRawJson: "unresolved",
    hiddenWindowSelector: "unresolved",
    diagnostic: [
      "Classic 2.1.32 (334) live E2E inventory reports binding_kind context;",
      "a stored raw inventory capture and hidden-selector evidence remain unavailable",
    ].join(" "),
  },
});

export function targetContractForApp(app: RpAppId): TargetContract {
  return app === "ce" ? CE_1_2_TARGET_CONTRACT : CLASSIC_2_1_32_TARGET_CONTRACT;
}
