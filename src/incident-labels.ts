// The finite, code-owned label sets incident evidence is checked against:
// a label an incident keeps (a diag `kind`, `subtype`, `type` or `why`, a
// flight-recorder kind) must be a member of one of these, or it becomes a
// placeholder. A new Claude Code subtype is then recorded as unknown until
// the bridge handles it; that loss is accepted, a string the bridge does not
// know reaching an issue is not.

// The SDK messages the bridge handles (consume-query.ts), as
// @anthropic-ai/claude-agent-sdk 0.3.284 declares them in sdk.d.ts:
// SDKAssistantMessage `type: 'assistant'` (3597-3598), SDKUserMessage
// `type: 'user'` (6146-6147), SDKResultSuccess/SDKResultError
// `type: 'result'` (5668-5669, 5607-5608), SDKSystemMessage and the other
// system messages `type: 'system'` (5831-5832), SDKPartialAssistantMessage
// `type: 'stream_event'` (5419-5420) and SDKRateLimitEvent
// `type: 'rate_limit_event'` (5570-5571).
export const SDK_MESSAGE_TYPES = ["assistant", "user", "result", "system", "stream_event", "rate_limit_event"] as const;
export type SdkMessageType = typeof SDK_MESSAGE_TYPES[number];

// The system subtypes the bridge reads: `init` (SDKSystemMessage, 5833),
// `api_retry` (SDKAPIRetryMessage, 3577) and `model_refusal_fallback`
// (SDKModelRefusalFallbackMessage, 5353). `informational`
// (SDKInformationalMessage, 5181) is not read, so it records as unknown.
export const SDK_SYSTEM_SUBTYPES = ["init", "api_retry", "model_refusal_fallback"] as const;
export type SdkSystemSubtype = typeof SDK_SYSTEM_SUBTYPES[number];

// Every result subtype: `success` (SDKResultSuccess, 5670) and the four error
// subtypes of SDKResultError (5609). The bridge handles each: success, or an
// error result.
export const SDK_RESULT_SUBTYPES = ["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"] as const;
export type SdkResultSubtype = typeof SDK_RESULT_SUBTYPES[number];

// The stream events of SDKPartialAssistantMessage.event (sdk.d.ts 5424,
// BetaRawMessageStreamEvent: @anthropic-ai/sdk 0.112.5,
// resources/beta/messages/messages.d.ts 1756), each handled in
// assistant-stream.ts.
export const SDK_STREAM_EVENT_TYPES = ["message_start", "message_delta", "message_stop", "content_block_start", "content_block_delta", "content_block_stop"] as const;
export type SdkStreamEventType = typeof SDK_STREAM_EVENT_TYPES[number];

// The block types of a Pi assistant message the bridge builds
// (@earendil-works/pi-ai dist/types.d.ts: AssistantMessage content, 355, of
// TextContent `type: "text"` 243, ThinkingContent `type: "thinking"` 248 and
// ToolCall `type: "toolCall"` 262): what a discarded stream attempt held.
export const TURN_BLOCK_TYPES = ["text", "thinking", "toolCall"] as const;
export type TurnBlockType = typeof TURN_BLOCK_TYPES[number];

// Why a stream attempt was abandoned (discardAbandonedAttempt): Claude Code
// restreamed the request as a new message, or replaced it with a
// non-streaming fallback.
export const STREAM_ABANDON_REASONS = ["restreamed", "non-streaming-fallback"] as const;
export type StreamAbandonReason = typeof STREAM_ABANDON_REASONS[number];
