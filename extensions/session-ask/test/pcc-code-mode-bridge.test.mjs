import assert from "node:assert/strict";
import test from "node:test";

import { Type } from "typebox";

import { createPccCodeModeToolRegistrar } from "../pcc-code-mode-bridge.ts";

const EXTENSION_TOOLS_CHANNEL = "@howaboua/pi-codex-conversion.extension-code-mode-tools/v1";

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

test("PCC registrar exposes both session tools without replacing their Pi definitions", () => {
    const events = createEventBus();
    const topLevelTools = [];
    const registrar = createPccCodeModeToolRegistrar({
        events,
        registerTool(tool) {
            topLevelTools.push(tool);
        },
    });
    const definition = (name) => ({
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        async execute() {
            return { content: [{ type: "text", text: name }], details: {} };
        },
    });

    registrar.register(definition("session_lineage"), "await tools.session_lineage({ maxDepth: 50 })");
    registrar.register(definition("session_ask"), 'await tools.session_ask({ question: "..." })');

    const codeModeTools = collectCodeModeTools(events);
    assert.deepEqual(topLevelTools.map((tool) => tool.name), ["session_lineage", "session_ask"]);
    assert.deepEqual(codeModeTools.map((tool) => tool.name), ["session_lineage", "session_ask"]);
    assert.equal(codeModeTools[0].inputSchema, topLevelTools[0].parameters);
    assert.equal(codeModeTools[1].inputSchema, topLevelTools[1].parameters);
    assert.equal(codeModeTools[0].blocking, true);
    assert.equal(codeModeTools[1].blocking, true);

    registrar.unregister();
    assert.deepEqual(collectCodeModeTools(events), []);
});
