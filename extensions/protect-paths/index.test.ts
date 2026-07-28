import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import protectPaths, { loadProtectPathsConfig } from "./index.ts";

type ToolCallResult = { block: true; reason?: string } | undefined;
type ToolCallHandler = (
    event: { toolName: string; input: Record<string, unknown> },
    context: {
        hasUI: boolean;
        ui: {
            notify: (message: string, level: string) => void;
            confirm: (title: string, message: string) => Promise<boolean>;
        };
    },
) => Promise<ToolCallResult>;

const ALLOWED_PI_ROOT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const ALLOWED_PI_PATH = `${ALLOWED_PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/providers`;
const tempDirectories: string[] = [];

afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function createConfig(trustedReadPaths: string[]): string {
    const directory = mkdtempSync(join(tmpdir(), "protect-paths-"));
    tempDirectories.push(directory);

    const configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify({ trustedReadPaths }));
    return configPath;
}

function createBashRunner(trustedReadPaths = [ALLOWED_PI_ROOT]): (command: string) => Promise<ToolCallResult> {
    const handlers: ToolCallHandler[] = [];
    const pi = {
        on(eventName: string, handler: ToolCallHandler) {
            if (eventName === "tool_call") handlers.push(handler);
        },
    } as unknown as ExtensionAPI;

    protectPaths(pi, { configPath: createConfig(trustedReadPaths) });

    return async (command: string) => {
        const event = { toolName: "bash", input: { command } };
        const context = {
            hasUI: false,
            ui: {
                notify: () => undefined,
                confirm: async () => true,
            },
        };

        for (const handler of handlers) {
            const result = await handler(event, context);
            if (result?.block) return result;
        }

        return undefined;
    };
}

test("loadProtectPathsConfig returns no trusted paths when config is absent", () => {
    const directory = mkdtempSync(join(tmpdir(), "protect-paths-"));
    tempDirectories.push(directory);

    assert.deepEqual(loadProtectPathsConfig(join(directory, "config.json")), { trustedReadPaths: [] });
});

test("loadProtectPathsConfig loads the checked-in example", () => {
    const examplePath = fileURLToPath(new URL("config.json.example", import.meta.url));
    const config = loadProtectPathsConfig(examplePath);

    assert.ok(config.trustedReadPaths.length > 0);
    assert.ok(config.trustedReadPaths.every((path) => path.startsWith("/")));
});

test("loadProtectPathsConfig rejects malformed configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "protect-paths-"));
    tempDirectories.push(directory);

    const configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify({ trustedReadPaths: ["relative/path"] }));

    assert.throws(() => loadProtectPathsConfig(configPath), /trustedReadPaths must contain absolute paths/);
});

test("trusted read-only Bash commands can inspect configured dependencies", async () => {
    const runBash = createBashRunner();
    const result = await runBash(
        `ls ${ALLOWED_PI_PATH} 2>/dev/null || find ${ALLOWED_PI_ROOT} -name "openai-completions*"`,
    );

    assert.equal(result, undefined);
});

test("untrusted node_modules reads remain blocked", async () => {
    const runBash = createBashRunner();
    const result = await runBash("ls /tmp/project/node_modules/package/index.js");

    assert.equal(result?.block, true);
});

test("output redirection into a trusted node_modules path remains blocked", async () => {
    const runBash = createBashRunner();
    const result = await runBash(`echo changed > ${ALLOWED_PI_PATH}/generated.js`);

    assert.equal(result?.block, true);
});

test("mutating find actions in a trusted node_modules path remain blocked", async () => {
    const runBash = createBashRunner();
    const result = await runBash(`find ${ALLOWED_PI_PATH} -delete`);

    assert.equal(result?.block, true);
});
