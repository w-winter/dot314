import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import repopromptMcp from "../dist/index.js";
import { registerRpCodeModeBridge } from "../dist/pcc-code-mode-bridge.js";

const EXTENSION_TOOLS_CHANNEL = "@howaboua/pi-codex-conversion.extension-code-mode-tools/v1";
const EXTENSION_TOOLS_REFRESH_CHANNEL = "@howaboua/pi-codex-conversion.extension-code-mode-tools-refresh/v1";

function createEventBus() {
  const listeners = new Map();
  return {
    on(name, handler) {
      const handlers = listeners.get(name) ?? new Set();
      handlers.add(handler);
      listeners.set(name, handlers);
      return () => handlers.delete(handler);
    },
    emit(name, value) {
      for (const handler of listeners.get(name) ?? []) handler(value);
    },
  };
}

function collectCodeModeTools(events) {
  const providers = [];
  events.emit(EXTENSION_TOOLS_CHANNEL, {
    refreshGates: false,
    add(provider, active) {
      providers.push({ provider, active });
    },
  });
  return providers.flatMap(({ provider, active }) => active ? provider(undefined) : []);
}

test("PCC bridge invokes the original tool with Pi context, cancellation, and updates", async () => {
  const events = createEventBus();
  let refreshes = 0;
  events.on(EXTENSION_TOOLS_REFRESH_CHANNEL, () => {
    refreshes += 1;
  });
  const calls = [];
  const updates = [];
  const captures = [];
  const extensionContext = { cwd: "/repo" };
  const signal = new AbortController().signal;
  const tool = {
    name: "rp",
    label: "RepoPrompt",
    description: "Test RP",
    parameters: Type.Object({ value: Type.String() }),
    async execute(toolCallId, params, receivedSignal, onUpdate, context) {
      calls.push({ toolCallId, params, receivedSignal, context });
      onUpdate?.({ content: [{ type: "text", text: "halfway" }], details: {} });
      return {
        content: [{ type: "text", text: `done:${params.value}` }],
        details: { value: params.value },
      };
    },
  };

  const unregister = registerRpCodeModeBridge({ events }, tool);
  const [adapted] = collectCodeModeTools(events);
  assert.ok(adapted);
  assert.equal(adapted.name, "rp");
  assert.equal(adapted.blocking, true);
  assert.equal(refreshes, 1);

  const value = await adapted.invoke(
    { value: "ok" },
    {
      toolCallId: "nested-rp",
      extensionContext,
      onUpdate: (update) => updates.push(update),
      captureResult: (result) => captures.push(result),
    },
    signal,
  );
  assert.equal(value, "done:ok");
  assert.deepEqual(calls, [{
    toolCallId: "nested-rp",
    params: { value: "ok" },
    receivedSignal: signal,
    context: extensionContext,
  }]);
  assert.equal(updates[0].content[0].text, "halfway");
  assert.equal(captures[0].details.value, "ok");
  await assert.rejects(
    adapted.invoke({ value: 1 }, { extensionContext }, signal),
    /Invalid rp arguments/,
  );

  unregister();
  assert.equal(refreshes, 2);
  assert.deepEqual(collectCodeModeTools(events), []);
});

test("repoprompt-mcp advertises its existing rp tool through the optional PCC channel", () => {
  const events = createEventBus();
  const tools = new Map();
  const pi = {
    events,
    on() {},
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    appendEntry() {},
  };

  repopromptMcp(pi);
  const rpTool = tools.get("rp");
  const [adapted] = collectCodeModeTools(events);
  assert.ok(rpTool);
  assert.ok(adapted);
  assert.equal(adapted.name, rpTool.name);
  assert.equal(adapted.description, rpTool.description);
  assert.equal(adapted.inputSchema, rpTool.parameters);
});
