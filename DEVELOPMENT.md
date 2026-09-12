# pi-claude-bridge development

For maintainers of the dot314 fork. [README.md](README.md) covers user-facing behavior; this file records invariants that span several modules.

## Invariants

- `src/models.ts::buildModels` maintains an explicit supported-model list and projects Pi metadata; it does not synchronize from SDK picker snapshots. Anthropic's [model configuration](https://code.claude.com/docs/en/model-config#work-with-fable) documents that Fable picker entries depend on organization availability and explicit selection can succeed without an entry. Fable metadata and effort support follow the [migration guide](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide). `tests/unit-models.mjs` checks projection and metadata; `tests/unit-account-rotation-stream.mjs` checks the selected provider model reaches SDK query options.
- Request-owned state lives in a lane, never in a module-level binding. Pi calls one provider instance concurrently for parents, subagents and sibling conversations, so `src/request-lane.ts::runInRequestLane` keys an `AsyncLocalStorage` lane by `SimpleStreamOptions.sessionId`, and the active query context, Pi stream, pushed-context stack, watchdog and Claude session record resolve through it. A callback registered on a host-owned emitter (an `AbortSignal` listener) runs in the caller's context and must re-enter its lane explicitly. Presence is judged against `undefined`: an empty string is a named lane. The lane carrier and the per-session registries sit on `globalThis` under versioned symbols, because a parent and a child can load separate copies of the module. `tests/unit-session-lanes.mjs`, `tests/unit-foreign-conversation.mjs`.
- `session_shutdown` removes only the entries recorded for that `SessionManager` at its `session_start`, since an in-memory session forks by mutating the same manager's id. A request with `cacheRetention: "none"` (Pi's compaction and branch-summary one-shots, fresh `sessionId` each, no shutdown ever) releases its lane when it settles. `src/index.ts` around `ephemeralLane`.
- A tool-use turn ends at the stream's `message_stop`, because `message_delta` is what carries the real output-token count and the SDK invokes MCP handlers before it arrives. The early signals only arm the grace timer in `src/assistant-stream.ts::scheduleToolUseTurnEnd`, which force-finalizes a turn whose terminal events never come.
- A tool result whose id was never registered in the active turn is refused, never queued against another call; the remaining handlers get an internal-error result so the turn cannot report success. A queued result whose handler has not fired by the next child message boundary is parked, still consumable, because the SDK staggers handler invocation. A query torn down with results outstanding writes diagnostics, marks the session for rebuild, and re-imports delivered results from Pi history next turn. `src/query-state.ts`, `tests/unit-tool-drain.mjs`, `tests/unit-queue.mjs`.
- An unpaired `tool_use` in a rebuilt session is paired with an explicit `is_error` result saying the output was lost, never a bare placeholder a model reads as output. `src/tool-pairing-audit.ts`.
- The provider is registered natively and unconditionally, once, by the primary module instance: `src/native-provider.ts::buildNativeProvider` through `pi.registerProvider`, with `auth.apiKey.check` and `resolve` answering from the existence-only credential probes in `src/auth-presence.ts`, so Pi hides the models while no account is connected. Pi's registration is upsert-by-id and replaces the stored object, so `PRIMARY_INSTANCE_KEY` and `ACTIVE_STREAM_SIMPLE_KEY` in `src/index.ts` keep a reloaded child module from swapping in its own `streamSimple` closure. A host below the peer floor gets `NATIVE_PROVIDER_UNSUPPORTED_MESSAGE` once instead of a wrong registration. Both native entry points route through the Claude Code subprocess; there is no raw API path, which is what keeps billing on the subscription.
- The stream-idle watchdog monitors only silence before the first output (`src/stream-idle-watchdog.ts::shouldMonitor`). After output starts, long gaps are legitimate: a child-executed connector call blocks the SDK message flow while the Pi turn stays open, and extended thinking can be delta-sparse. A child that dies mid-message throws from the generator and is surfaced that way.
- Nothing is written to disk without `CLAUDE_BRIDGE_DEBUG=1`, and no log line carries a tool payload or user-authored message content. `src/debug.ts`, `tests/unit-debug-discipline.mjs`.

## Child-executed tools

Pi's tools reach the child over the in-process MCP server, so a `tool_use` coming back is the child asking Pi to run something. claude.ai connectors run the other way: they are the child's own MCP servers, reachable only inside that process. So a `tool_use` under the connector namespace is never mirrored into the Pi stream: no `toolCall` block, no turn boundary, no expected-result entry (`src/connectors.ts::isChildExecutedTool`, applied at the emission sites in `src/assistant-stream.ts`). Mirroring one made Pi write a synthetic `Tool <name> not found` error beside an answer built from the real payload, and a rebuild projected that false result into the child's conversation of record.

The same rule covers Claude Code's in-process meta-tools (`ToolSearch`, `ScheduleWakeup`), matched by exact name in `src/connectors.ts::isChildInternalTool`, never by prefix. The MCP-resource built-ins stay mirrored: a resource read is a real account-surface access and consuming hosts audit it through the Pi mirror. The classifier is a namespace plus an exact-name set on purpose; "any name Pi cannot resolve" would also swallow a genuine tool-name mismatch, which must stay a loud dispatcher error. A non-bridge `mcp__<server>__<tool>` name and a bare name with no bridge manifest entry are refused at dispatch without widening the classifier; seeing a foreign MCP call commits account routing, a rejected naming slip does not.

Consequences:

- A connector tool must reach the model under one name. `src/convert.ts::mapPiToolNameToSdk` passes connector names through unchanged and `src/index.ts::resolveMcpTools` never re-offers a connector-namespace tool under the bridge prefix; Pi history recorded before that rule can still carry aliased names.
- The child's result is observed, never re-delivered (`src/assistant-stream.ts::noteChildExecutedToolResults`, fed from the SDK's `user` message). The debug line records name, error flag and byte size only.
- A connector call draws no tool card. Pi's assistant content is text, thinking or a `toolCall` its loop dispatches, so a delegated call has no honest representation; that is an upstream ask.

### The audit trail

Each child-executed connector call (never a child-internal built-in) appends a session `CustomEntry` of type `claude-bridge-connector-call` (`src/connector-audit.ts`). A `CustomEntry` does not enter LLM context and `convertPiMessages` reads messages, not entries, so it can neither be dispatched nor projected into the child. Never use `CustomMessageEntry` for this: that sibling type enters context, which is the bug again. The record is `{ name, toolUseId, outcome, byteSize?, childSessionId?, reason? }`, and `outcome` includes `unobserved` for a call whose result never came back, written at teardown with its cause; recording is keyed on the `tool_use` id so either path reaching a call first writes the one record. The audit map is query-scoped and is not cleared by `resetToolTracking`, which runs at every child message boundary. Pi's `createBranchedSession` copies entries into a fork, which is harmless here, unlike the `claude-bridge-session` marker beside it, which carries a `piSessionId` guard for that reason.

## Connector enforcement

- Write denial is two-layered: the known write tools are passed as `disallowedTools` by exact id (the CLI's MCP permission matcher takes exact names or a whole-server glob, nothing in between), and a `PreToolUse` hook denies any connector tool classified as a write at call time. Classification is fail-closed over the connector namespace: a tool is a write unless its name opens with a read verb matched as a word across naming styles, a leading server-name word skipped first; a name that opens with a read verb but also names a mutation is a write, and so is a name that does not parse. `src/connectors.ts::isConnectorWriteTool`, `tests/unit-connector-writes.mjs`.
- Every connectors-mode child also carries `src/connectors.ts::connectorBuiltinAllowlistHook`: only `mcp__custom-tools__*`, `mcp__claude_ai_*` and `CONNECTOR_DISCOVERY_TOOLS` may execute, and a hook exception converts to a deny because the CLI treats a thrown hook as fail-open. Connector sessions ingest untrusted third-party content, and a denylist of today's built-ins fails open on tomorrow's. The account probe child gets `denyAllToolsHook`.
- `settingSourcesForQuery` passes `["user"]` for connector queries and `[]` otherwise. `project` or `local` would let a checkout's `.claude/settings.json` reintroduce through `env` and `apiKeyHelper` exactly the provider-override environment `src/account-router.ts::subscriberProfileEnv` scrubs from managed children. An explicit `provider.settingSources` in bridge config wins verbatim.
- `enableConnectors` and `connectorWriteMode` resolve from user scope and the environment only (`src/config.ts::USER_SCOPE_ONLY_PROVIDER_KEYS`); project trust covers ordinary options and nothing that exposes live account data. `connectorWriteMode: "allow"` is per process, so an approved-write executor sets it in the child environment of a one-shot process.

## Config channels

`src/config.ts::loadConfig` reads `<piUserDir>/claude-bridge.json`, then a trusted project's `.pi/claude-bridge.json`. Provider options live under `provider`, and prompt replacement options live under `systemPrompt`. The loader normalizes provider values after merging both files. Connector enablement and write access remain user-scoped even for trusted projects.

## Runtime

- `bundle/index.js` keeps `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` external because Pi supplies them at runtime. Run the bundle from the dot314 checkout so Node resolves those packages from the repository root.
- Startup preflight (`src/claude-executable.ts::preflightClaudeExecutable`) preserves `code`, `errno`, `syscall`, `path`, `cwd` and the detected executable file type on the error it hands the SDK.

## Rate limits

`src/rate-limit.ts::normalizeRateLimitUtilization` reads a value in `(0, 1]` as a fraction and `(1, 100]` as a percent; exactly `1` is ambiguous and resolves to full, the fail-closed direction. `formatAllowedRateLimitWarning` emits a neutral toast from `ALLOWED_RATE_LIMIT_WARNING_UTILIZATION_THRESHOLD` up and never quotes a `% used` figure. Rate-limit errors are deduplicated before notification and emitted as `pi-claude:rate-limit`.

## Tests

```bash
npm run typecheck
npm run test:unit      # node --test over tests/unit-*.mjs, no credentials
npm run test:ci        # build, then the unit suite
npm test               # unit, then the integration suites
npm run test:usage     # A/B subscription-usage comparison against Claude Code direct
```

The integration suites (`tests/int-*.sh`, `tests/int-*.mjs`) need the `pi` CLI, a logged-in Claude Code, and `CLAUDE_BRIDGE_TESTING_ALT_MODEL` and `CLAUDE_BRIDGE_TESTING_ALT_PROVIDER` from `.env.test`, which `npm test` sources when present. `test:usage` spends real subscription usage. A test that spawns a child pins `HOME`, `PI_CODING_AGENT_DIR` and `CLAUDE_CONFIG_DIR` explicitly, because a spawned child inherits the process's start environment rather than a harness override.
