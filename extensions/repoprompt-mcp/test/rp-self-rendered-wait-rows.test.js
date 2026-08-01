import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { Container, visibleWidth } from "@earendil-works/pi-tui";

import repopromptMcp from "../dist/index.js";
import { clearBinding } from "../dist/binding.js";
import { resetRpClient } from "../dist/client.js";

const WIDTH = 100;

// Real SGR sequences so visibleWidth() treats shell framing as zero-width.
const BG = {
  toolPendingBg: "\u001b[48;5;17m",
  toolSuccessBg: "\u001b[48;5;22m",
  toolErrorBg: "\u001b[48;5;52m",
};

function createTheme() {
  return {
    fg: (_slot, text) => text,
    bold: (text) => text,
    dim: (text) => text,
    italic: (text) => text,
    inverse: (text) => text,
    bg: (slot, text) => `${BG[slot] ?? "\u001b[48;5;0m"}${text}\u001b[49m`,
  };
}

function createMockPi() {
  const tools = new Map();
  return {
    on() {},
    registerCommand() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    getTool(name) {
      return tools.get(name);
    },
    appendEntry() {},
  };
}

async function withRpTool(run) {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "rp-self-shell-home-"));
  process.env.HOME = tempHome;
  try {
    mkdirSync(path.join(tempHome, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(
      path.join(tempHome, ".pi", "agent", "extensions", "repoprompt-mcp.json"),
      JSON.stringify({ activeApp: "ce", apps: { ce: { command: "fake-rp", args: [] } } }),
    );
    await resetRpClient();
    clearBinding();

    const pi = createMockPi();
    repopromptMcp(pi);
    const rpTool = pi.getTool("rp");
    assert.ok(rpTool, "rp tool should be registered");

    await run(rpTool);
  } finally {
    process.env.HOME = originalHome;
    clearBinding();
    await resetRpClient();
    rmSync(tempHome, { recursive: true, force: true });
  }
}

/**
 * Drives the registered renderers the way ToolExecutionComponent does in self-shell mode:
 * one shared renderer state, per-slot lastComponent values, both returned components added
 * to a real container, and one leading separator only when the body is non-empty.
 * Mirrors packages/coding-agent/src/modes/interactive/components/tool-execution.ts:216-248.
 */
function createSession(rpTool, theme) {
  const state = {};
  let lastCall;
  let lastResult;

  return {
    render({
      args,
      result,
      isPartial = false,
      expanded = false,
      isError = false,
      argsComplete = true,
    }) {
      const baseContext = {
        args,
        toolCallId: "tool-call-1",
        invalidate() {},
        state,
        cwd: "/tmp/rp-self-shell",
        executionStarted: true,
        argsComplete,
        isPartial,
        expanded,
        showImages: false,
        isError,
      };

      const container = new Container();

      const callComponent = rpTool.renderCall(args, theme, { ...baseContext, lastComponent: lastCall });
      lastCall = callComponent;
      container.addChild(callComponent);

      if (result) {
        const resultComponent = rpTool.renderResult(
          result,
          { expanded, isPartial },
          theme,
          { ...baseContext, lastComponent: lastResult },
        );
        lastResult = resultComponent;
        container.addChild(resultComponent);
      }

      const lines = container.render(WIDTH);
      return lines.length > 0 ? ["", ...lines] : [];
    },
  };
}

// The TUI host builds the result argument as { content, details } and never forwards isError.
function hostResult(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

function assertShell(lines, { background, minLines = 3 }) {
  assert.ok(lines.length >= minLines, `expected a visible shell, got ${lines.length} lines`);
  assert.equal(lines[0], "", "first line must be the host separator");
  for (const line of lines.slice(1)) {
    assert.equal(visibleWidth(line), WIDTH, "every shell line must fill the row width");
    assert.ok(line.includes(background), "every shell line must carry the expected background");
  }
  for (const [slot, code] of Object.entries(BG)) {
    if (code === background) continue;
    for (const line of lines.slice(1)) {
      assert.ok(!line.includes(code), `unexpected ${slot} background in a visible shell line`);
    }
  }
}

const WAIT_PROTOCOLS = [
  {
    name: "context_builder_wait",
    jobId: "cb_1",
    jobField: "contextBuilderJob",
    underlyingTool: "context_builder",
  },
  {
    name: "oracle_send_wait",
    jobId: "or_1",
    jobField: "oracleSendJob",
    underlyingTool: "oracle_send",
  },
];

function waitArgs(protocol) {
  return { call: protocol.name, args: { job_id: protocol.jobId } };
}

test("rp registers with the self render shell", async () => {
  await withRpTool((rpTool) => {
    assert.equal(rpTool.renderShell, "self");
    assert.equal(typeof rpTool.renderCall, "function");
    assert.equal(typeof rpTool.renderResult, "function");
  });
});

test("valid local wait calls render zero lines while pending and running", async () => {
  await withRpTool((rpTool) => {
    for (const protocol of WAIT_PROTOCOLS) {
      const session = createSession(rpTool, createTheme());
      const args = waitArgs(protocol);

      assert.deepEqual(session.render({ args }), [], `${protocol.name}: call row must be hidden`);

      const partial = session.render({
        args,
        isPartial: true,
        result: hostResult(`Waiting for job ${protocol.jobId}…`, {
          mode: "call",
          tool: protocol.name,
          status: "running",
          jobId: protocol.jobId,
        }),
      });
      assert.deepEqual(partial, [], `${protocol.name}: running partial must be hidden`);

      const heartbeat = session.render({
        args,
        result: hostResult(`Job "${protocol.jobId}" is still running.`, {
          mode: "call",
          tool: protocol.name,
          [protocol.jobField]: { jobId: protocol.jobId, status: "running", target: { windowId: 7 } },
        }),
      });
      assert.deepEqual(heartbeat, [], `${protocol.name}: running heartbeat must be hidden`);
    }
  });
});

test("wait calls stay hidden while their arguments are still streaming", async () => {
  await withRpTool((rpTool) => {
    for (const protocol of WAIT_PROTOCOLS) {
      const streaming = createSession(rpTool, createTheme()).render({
        args: { call: protocol.name, args: {} },
        argsComplete: false,
      });
      assert.deepEqual(streaming, [], `${protocol.name}: must not flash before arguments complete`);

      const settled = createSession(rpTool, createTheme()).render({
        args: { call: protocol.name, args: {} },
        argsComplete: true,
      });
      assertShell(settled, { background: BG.toolPendingBg });
    }
  });
});

test("completed waits replace the hidden row with one success shell", async () => {
  await withRpTool((rpTool) => {
    for (const protocol of WAIT_PROTOCOLS) {
      const session = createSession(rpTool, createTheme());
      const args = waitArgs(protocol);

      assert.deepEqual(session.render({ args }), []);
      assert.deepEqual(
        session.render({
          args,
          isPartial: true,
          result: hostResult("Waiting…", {
            mode: "call",
            tool: protocol.name,
            status: "running",
            jobId: protocol.jobId,
          }),
        }),
        [],
      );

      const completed = session.render({
        args,
        result: hostResult("## Result ready", {
          mode: "call",
          tool: protocol.underlyingTool,
          [protocol.jobField]: { jobId: protocol.jobId, status: "completed", target: { windowId: 7 } },
        }),
      });

      assertShell(completed, { background: BG.toolSuccessBg });
      const text = stripAnsi(completed.join("\n"));
      assert.match(text, new RegExp(protocol.name, "u"), "the wait call header must reappear");
      assert.match(text, /Result ready/u);
      assert.doesNotMatch(text, /Running…/u);
      assert.doesNotMatch(text, /still running/u);
    }
  });
});

test("failed and thrown waits replace the hidden row with one error shell", async () => {
  await withRpTool((rpTool) => {
    const returnedFailure = createSession(rpTool, createTheme());
    const oracleArgs = waitArgs(WAIT_PROTOCOLS[1]);
    assert.deepEqual(returnedFailure.render({ args: oracleArgs }), []);
    const failed = returnedFailure.render({
      args: oracleArgs,
      isError: true,
      result: hostResult("Oracle send failed: runner rejected the request", {
        mode: "call",
        tool: "oracle_send_wait",
        oracleSendJob: { jobId: "or_1", status: "failed", target: { windowId: 7 } },
      }),
    });
    assertShell(failed, { background: BG.toolErrorBg });
    assert.match(stripAnsi(failed.join("\n")), /↳ .*runner rejected the request/u);

    const thrown = createSession(rpTool, createTheme());
    const builderArgs = waitArgs(WAIT_PROTOCOLS[0]);
    assert.deepEqual(thrown.render({ args: builderArgs }), []);
    const errored = thrown.render({
      args: builderArgs,
      isError: true,
      result: hostResult("[context_builder_job_not_found] missing", {}),
    });
    assertShell(errored, { background: BG.toolErrorBg });
    assert.match(stripAnsi(errored.join("\n")), /\[context_builder_job_not_found\]/u);
  });
});

test("invalid wait arguments always stay visible", async () => {
  await withRpTool((rpTool) => {
    const invalidArgs = [
      { call: "context_builder_wait" },
      { call: "context_builder_wait", args: {} },
      { call: "context_builder_wait", args: { job_id: "   " } },
      { call: "context_builder_wait", args: { job_id: 7 } },
      { call: "context_builder_wait", args: { job_id: "cb_1", extra: true } },
      { call: "oracle_send_wait", args: ["or_1"] },
    ];

    for (const args of invalidArgs) {
      const session = createSession(rpTool, createTheme());
      const pending = session.render({ args });
      assertShell(pending, { background: BG.toolPendingBg });

      const failure = session.render({
        args,
        isError: true,
        result: hostResult("[invalid_context_builder_wait_args] requires exactly one job_id", {}),
      });
      assertShell(failure, { background: BG.toolErrorBg });
    }
  });
});

test("running classification is exact and every other shape stays visible", async () => {
  await withRpTool((rpTool) => {
    const visibleCases = [
      {
        why: "ordinary forwarded partial",
        args: { call: "read_file", args: { path: "src/App.tsx" } },
        isPartial: true,
        result: hostResult("Calling read_file", { mode: "call", tool: "read_file", status: "running" }),
        background: BG.toolPendingBg,
      },
      {
        why: "wait partial with another status",
        args: waitArgs(WAIT_PROTOCOLS[0]),
        isPartial: true,
        result: hostResult("Queued", { mode: "call", tool: "context_builder_wait", status: "queued" }),
        background: BG.toolPendingBg,
      },
      {
        why: "wait partial for another job",
        args: waitArgs(WAIT_PROTOCOLS[0]),
        isPartial: true,
        result: hostResult("Waiting", {
          mode: "call",
          tool: "context_builder_wait",
          status: "running",
          jobId: "cb_2",
        }),
        background: BG.toolPendingBg,
      },
      {
        why: "running heartbeat without a job ID",
        args: waitArgs(WAIT_PROTOCOLS[0]),
        result: hostResult("missing job ID", {
          mode: "call",
          tool: "context_builder_wait",
          contextBuilderJob: { status: "running" },
        }),
        background: BG.toolSuccessBg,
      },
      {
        why: "running heartbeat for another job",
        args: waitArgs(WAIT_PROTOCOLS[0]),
        result: hostResult("wrong job ID", {
          mode: "call",
          tool: "context_builder_wait",
          contextBuilderJob: { jobId: "cb_2", status: "running" },
        }),
        background: BG.toolSuccessBg,
      },
      {
        why: "context builder wait carrying only an oracle job",
        args: waitArgs(WAIT_PROTOCOLS[0]),
        result: hostResult("mismatched", {
          mode: "call",
          tool: "context_builder_wait",
          oracleSendJob: { jobId: "or_1", status: "running" },
        }),
        background: BG.toolSuccessBg,
      },
      {
        why: "oracle wait carrying only a context builder job",
        args: waitArgs(WAIT_PROTOCOLS[1]),
        result: hostResult("mismatched", {
          mode: "call",
          tool: "oracle_send_wait",
          contextBuilderJob: { jobId: "cb_1", status: "running" },
        }),
        background: BG.toolSuccessBg,
      },
      {
        why: "error-marked wait-like result",
        args: waitArgs(WAIT_PROTOCOLS[0]),
        isError: true,
        result: hostResult("[context_builder_job_consumed] already consumed", {
          mode: "call",
          tool: "context_builder_wait",
          contextBuilderJob: { jobId: "cb_1", status: "running" },
        }),
        background: BG.toolErrorBg,
      },
      {
        why: "context builder start result",
        args: { call: "context_builder", args: { instructions: "Review it" } },
        result: hostResult('Started in the background. Job ID: "cb_1"', {
          mode: "call",
          tool: "context_builder",
          contextBuilderJob: { jobId: "cb_1", status: "running" },
        }),
        background: BG.toolSuccessBg,
      },
      {
        why: "oracle send start result",
        args: { call: "oracle_send", args: { message: "Review it" } },
        result: hostResult('Started in the background. Job ID: "or_1"', {
          mode: "call",
          tool: "oracle_send",
          oracleSendJob: { jobId: "or_1", status: "running" },
        }),
        background: BG.toolSuccessBg,
      },
    ];

    for (const testCase of visibleCases) {
      const session = createSession(rpTool, createTheme());
      const lines = session.render(testCase);
      assertShell(lines, { background: testCase.background });
    }
  });
});

test("ordinary forwarded partials keep the exact five-line pending shell", async () => {
  await withRpTool((rpTool) => {
    const session = createSession(rpTool, createTheme());
    const lines = session.render({
      args: { call: "read_file", args: { path: "src/App.tsx" } },
      isPartial: true,
      result: hostResult("Calling read_file", { mode: "call", tool: "read_file", status: "running" }),
    });

    // separator, box top padding, call line, result line, box bottom padding
    assert.equal(lines.length, 5);
    assert.equal(lines[0], "");
    assertShell(lines, { background: BG.toolPendingBg, minLines: 5 });

    const text = stripAnsi(lines.join("\n"));
    assert.match(text, /Read File • src\/App\.tsx/u);
    assert.match(text, /Running…/u);
  });
});

test("ordinary success rows keep one summarized success shell", async () => {
  await withRpTool((rpTool) => {
    const session = createSession(rpTool, createTheme());
    const lines = session.render({
      args: { call: "read_file", args: { path: "src/App.tsx" } },
      result: hostResult("## File Read ✅\n- **Path**: `src/App.tsx`", {
        mode: "call",
        tool: "read_file",
      }),
    });

    assertShell(lines, { background: BG.toolSuccessBg });
    assert.match(stripAnsi(lines.join("\n")), /Read File • src\/App\.tsx/u);
  });
});

test("expanded output stays inside one success shell", async () => {
  await withRpTool((rpTool) => {
    const body = ["line one", "line two", "line three", "line four"].join("\n");
    const session = createSession(rpTool, createTheme());
    const lines = session.render({
      args: { call: "read_file", args: { path: "src/App.tsx" } },
      expanded: true,
      result: hostResult(body, { mode: "call", tool: "read_file" }),
    });

    assertShell(lines, { background: BG.toolSuccessBg });
    const text = stripAnsi(lines.join("\n"));
    assert.match(text, /line one/u);
    assert.match(text, /line four/u);
  });
});

test("adaptive diff results stay inside one correctly sized success shell", async () => {
  await withRpTool((rpTool) => {
    const diff = [
      "--- a/demo.txt",
      "+++ b/demo.txt",
      "@@ -1 +1 @@",
      "-old value",
      "+new value",
    ].join("\n");

    const session = createSession(rpTool, createTheme());
    const lines = session.render({
      args: { call: "apply_edits", args: { path: "demo.txt" } },
      expanded: true,
      result: hostResult("Applied edits • +1 -1 • 1 hunk • 1 file", {
        mode: "call",
        tool: "apply_edits",
        diff,
        filePath: "demo.txt",
      }),
    });

    assert.equal(lines[0], "");
    for (const line of lines.slice(1)) {
      assert.equal(visibleWidth(line), WIDTH);
      assert.ok(line.includes(BG.toolSuccessBg));
    }
    assert.match(stripAnsi(lines.join("\n")), /new value/u);
  });
});

test("status, search, and describe keep summarized success shells", async () => {
  await withRpTool((rpTool) => {
    const cases = [
      {
        args: {},
        result: hostResult("## RepoPrompt Status", { mode: "status" }),
        summary: /Status/u,
      },
      {
        args: { search: "selection" },
        result: hostResult("## Found 2 tool(s)", { mode: "search", query: "selection", count: 2 }),
        summary: /Tool Search • "selection"/u,
      },
      {
        args: { describe: "read_file" },
        result: hostResult("## read_file", { mode: "describe", requestedTool: "read_file" }),
        summary: /Describe • read_file/u,
      },
    ];

    for (const testCase of cases) {
      const lines = createSession(rpTool, createTheme()).render({
        args: testCase.args,
        result: testCase.result,
      });
      assertShell(lines, { background: BG.toolSuccessBg });
      assert.match(stripAnsi(lines.join("\n")), testCase.summary);
    }
  });
});

// The rest of this suite mirrors the host's self-shell composition. This one drives the real
// ToolExecutionComponent so the premise the whole feature rests on - a self-rendered tool whose
// components yield no lines produces no row and no separator - is pinned against Pi itself
// rather than against our mirror of it. Theme-dependent assertions stay in the mirrored harness
// because the host renders with a module-level singleton theme.
test("the real host component hides running waits and frames ordinary rows", async () => {
  await withRpTool(async (rpTool) => {
    const { ToolExecutionComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
    // The host renders through a module-level singleton theme, so it must be initialized
    // before constructing the component. This test asserts structure only, never theme slots.
    initTheme();
    const ui = { requestRender() {} };

    const wait = new ToolExecutionComponent(
      "rp",
      "tool-call-wait",
      { call: "context_builder_wait", args: { job_id: "cb_1" } },
      {},
      rpTool,
      ui,
      "/tmp/rp-self-shell",
    );
    wait.setArgsComplete();
    assert.deepEqual(wait.render(WIDTH), [], "a pending valid wait must occupy no rows");

    wait.updateResult(
      {
        content: [{ type: "text", text: 'Job "cb_1" is still running.' }],
        details: {
          mode: "call",
          tool: "context_builder_wait",
          contextBuilderJob: { jobId: "cb_1", status: "running" },
        },
        isError: false,
      },
      false,
    );
    assert.deepEqual(wait.render(WIDTH), [], "a running heartbeat must occupy no rows");

    const ordinary = new ToolExecutionComponent(
      "rp",
      "tool-call-read",
      { call: "read_file", args: { path: "src/App.tsx" } },
      {},
      rpTool,
      ui,
      "/tmp/rp-self-shell",
    );
    ordinary.setArgsComplete();
    ordinary.updateResult(
      {
        content: [{ type: "text", text: "Calling read_file" }],
        details: { mode: "call", tool: "read_file", status: "running" },
        isError: false,
      },
      true,
    );

    const lines = ordinary.render(WIDTH);
    assert.equal(lines.length, 5, "separator, top padding, call, result, bottom padding");
    assert.equal(lines[0], "", "the host supplies exactly one leading separator");
    assert.match(stripAnsi(lines.join("\n")), /Read File • src\/App\.tsx/u);
  });
});
