# subagent-bridge

A Pi extension that gives spawned subagents short, stable handles usable with `subagent_resume` and `intercom`, so the orchestrator can address them without passing full `.jsonl` paths or session UUIDs. Each child subagent also gets an `@parent` alias for messaging its current orchestrator over intercom.

Requires `pi-interactive-subagents` and `pi-intercom`.

## Usage

### From the orchestrator

Every subagent you launch or resume in this session gets a handle derived from its display name (`Idle Worker` → `idle-worker`, `Scout: DB` → `scout-db`, a second `Scout: DB` → `scout-db-2`). The list is built from what this session has actually observed; it does not come from agent definitions on disk.

Resume a known child by handle:

```ts
subagent_resume({ sessionPath: "idle-worker" })
```

Steer or check in with a running child over intercom:

```ts
intercom({ action: "send", to: "@idle-worker", message: "Run the review workflow next" })
```

### From the child

The current parent is always reachable as `@parent`, including after a resume:

```ts
intercom({ action: "send", to: "@parent", message: "Finished the parsing pass" })
intercom({ action: "ask",  to: "@parent", message: "Should I include draft PRs?" })
```

Unlike `caller_ping`, this does not shut the child down, so the child can ask a question and keep working while it waits for an answer.

### Automatic final-report fallback

If a child session reaches `agent_end` and its **last assistant turn** was not immediately replying to a user message and did not itself call `intercom({ action: "send"|"ask", to: "@parent", ... })`, `subagent_done`, or `caller_ping`, `subagent-bridge` relays that last assistant text to `@parent` automatically.

This is a safety net for cases where a subagent clearly finished but, for some reason or another, did not report back to the orchestrator/parent.

Replies to the relayed intercom message are kept valid for up to 10 minutes while the same child session remains active: `subagent-bridge` keeps the relay session alive and forwards those replies back into that child session. If the child switches to a different session or reloads into a different session file, the relay is invalidated rather than forwarding into the wrong place. When the parent-local child handle is known, the relayed message also includes an explicit `intercom({ ... to: "@<handle>" ... })` command for replying to the still-live child directly.

It is suppressed when:
- the child is in `auto-exit` mode (`PI_SUBAGENT_AUTO_EXIT=1`)
- the final assistant turn was immediately preceded by a user message
- the run was aborted
- the user took over interactively before the run ended
- there is no resolved `@parent` binding

Disable it in `config.json` if you want purely explicit reporting:

```json
{
  "autoReportToParentOnAgentEnd": false
}
```

## State files

- `<sessionDir>/subagent-bridge/<parentSessionId>/registry.json` — handle map for one orchestrator session
- `<childSessionFile>.subagent-bridge.json` — a child's current `@parent` binding

Both regenerate on the next successful launch or resume, so deleting them is safe.

## Notes

- Handles are parent-local: stable within one orchestrator session and across its reloads and resumes, not a global namespace. If two different orchestrators later resume the same child, each keeps its own handle for it.
- A brand-new child can briefly see `@parent` unresolved on its first turn, before the parent writes the child binding. Subsequent calls resolve once the parent's next `tool_result` lands.
- `pi-intercom` still treats duplicate explicit session names as ambiguous; give the orchestrator a unique name when it matters.
