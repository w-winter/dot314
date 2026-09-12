// Canonical selection + display order for the model picker.
// Extracted from index.ts so tests can import without activating the extension.

export const FABLE_MODEL_ID = "claude-fable-5-1";
// Opus 4.8 is both a selectable model and the safety-fallback target for the two
// primaries whose classifiers can decline a turn (Fable 5.1, Opus 5).
export const FABLE_FALLBACK_MODEL_ID = "claude-opus-4-8";
export const OPUS_5_MODEL_ID = "claude-opus-5";
export const SONNET_5_MODEL_ID = "claude-sonnet-5";

export function fallbackModelForPrimaryModel(modelId: string): string | undefined {
	return modelId === FABLE_MODEL_ID || modelId === OPUS_5_MODEL_ID ? FABLE_FALLBACK_MODEL_ID : undefined;
}

export const MODEL_IDS_IN_ORDER = [
	FABLE_MODEL_ID,
	OPUS_5_MODEL_ID,
	FABLE_FALLBACK_MODEL_ID,
	"claude-opus-4-7",
	"claude-opus-4-6",
	SONNET_5_MODEL_ID,
	"claude-sonnet-4-6",
	"claude-haiku-4-5",
];

type BridgeModelMetadata = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
};

const FALLBACK_MODELS: Record<string, BridgeModelMetadata> = {
	[FABLE_MODEL_ID]: {
		id: FABLE_MODEL_ID,
		name: "Claude Fable 5.1",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[OPUS_5_MODEL_ID]: {
		id: OPUS_5_MODEL_ID,
		name: "Claude Opus 5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[FABLE_FALLBACK_MODEL_ID]: {
		id: FABLE_FALLBACK_MODEL_ID,
		name: "Claude Opus 4.8",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[SONNET_5_MODEL_ID]: {
		id: SONNET_5_MODEL_ID,
		name: "Claude Sonnet 5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
};

// Human label for the safety-fallback notice. Every id that participates in a
// fallbackModelForPrimaryModel pairing has an entry above; the raw id is the
// last-resort label so an unmapped pairing still reads sensibly.
export function modelDisplayName(modelId: string): string {
	return FALLBACK_MODELS[modelId]?.name ?? modelId;
}

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// keep MODEL_IDS_IN_ORDER ordering, and fill bridge-owned metadata for supported
// IDs absent from pi-ai. Unknown missing IDs are still dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id) ?? FALLBACK_MODELS[id])
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
		// xhigh→xhigh instead of xhigh→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}
