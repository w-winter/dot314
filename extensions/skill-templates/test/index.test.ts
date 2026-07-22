import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createHarness, createTempDir, writeTextFile } from "./test-helpers.ts";

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

test("factory load registers global aliases and excludes project aliases before session_start", () => {
  const cwd = createTempDir();
  const globalSkillDir = join(cwd, "home", ".pi", "agent", "skills", "global-review");
  const projectSkillDir = join(cwd, ".pi", "skills", "project-review");
  writeTextFile(join(globalSkillDir, "SKILL.template.md"), "---\ndescription: global review\n---\nGlobal body");
  writeTextFile(join(projectSkillDir, "SKILL.template.md"), "---\ndescription: project review\n---\nProject body");

  const harness = createHarness({ cwd, projectTrusted: false });

  assert.ok(harness.commands.has("skill-template:global-review"));
  assert.ok(!harness.commands.has("skill-template:project-review"));
  harness.cleanup();
});

test("session_start excludes project templates when the project is untrusted", async () => {
  const harness = createHarness({ projectTrusted: false });
  const skillDir = join(harness.cwd, ".pi", "skills", "review");
  writeTextFile(join(skillDir, "SKILL.template.md"), "---\ndescription: review\n---\nBody");

  await harness.emit("session_start");
  await harness.emit("resources_discover");
  const result = await harness.emitInput({ text: "/skill:review" });

  assert.deepEqual(result, { action: "continue" });
  harness.cleanup();
});

test("input refreshes the catalog when project trust changes for the same cwd", async () => {
  const harness = createHarness({ projectTrusted: false });
  const skillDir = join(harness.cwd, ".pi", "skills", "review");
  writeTextFile(join(skillDir, "SKILL.template.md"), "---\ndescription: review\n---\nBody");

  await harness.emit("session_start");
  assert.deepEqual(await harness.emitInput({ text: "/skill:review" }), { action: "continue" });

  harness.setProjectTrusted(true);
  const trustedResult = await harness.emitInput({ text: "/skill:review" });

  assert.equal((trustedResult as { action?: string }).action, "transform");
  harness.cleanup();
});

test("input transforms /skill:name when a matching template skill exists", async () => {
  const harness = createHarness();
  const skillDir = join(harness.cwd, ".pi", "skills", "review");
  writeTextFile(join(skillDir, "SKILL.template.md"), "---\ndescription: review\n---\nBody {{ args[0] }}");

  await harness.emit("session_start");
  const result = await harness.emitInput({ text: "/skill:review security", images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } }] });

  assert.deepEqual(result, {
    action: "transform",
    text: [
      `<skill name="review" location="${canonicalizePath(join(skillDir, "SKILL.template.md"))}">`,
      `References are relative to ${canonicalizePath(skillDir)}.`,
      "",
      "Body security",
      "</skill>",
      "",
      "security",
    ].join("\n"),
    images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } }],
  });

  harness.cleanup();
});

test("input continues to core handling when no matching template skill exists", async () => {
  const harness = createHarness();

  const result = await harness.emitInput({ text: "/skill:missing" });
  assert.deepEqual(result, { action: "continue" });

  harness.cleanup();
});

test("input handles matching template render errors without falling back", async () => {
  const harness = createHarness();
  const skillDir = join(harness.cwd, ".pi", "skills", "review");
  writeTextFile(join(skillDir, "SKILL.template.md"), "---\ndescription: review\n---\n{% skill \"./missing\" %}");

  await harness.emit("session_start");
  const result = await harness.emitInput({ text: "/skill:review" });

  assert.deepEqual(result, { action: "handled" });
  assert.ok(harness.notifications.some((notification) => notification.level === "error"));

  harness.cleanup();
});

test("extension-originated input bypasses template interception", async () => {
  const harness = createHarness();
  const skillDir = join(harness.cwd, ".pi", "skills", "review");
  writeTextFile(join(skillDir, "SKILL.template.md"), "---\ndescription: review\n---\nBody");

  await harness.emit("session_start");
  const result = await harness.emitInput({ text: "/skill:review", source: "extension" });

  assert.deepEqual(result, { action: "continue" });
  harness.cleanup();
});

test("alias command sends the rendered invocation through sendUserMessage while streaming", async () => {
  const harness = createHarness();
  const skillDir = join(harness.cwd, ".pi", "skills", "review");
  writeTextFile(join(skillDir, "SKILL.template.md"), "---\ndescription: review\n---\nBody {{ lang }}");

  await harness.emit("session_start");
  await harness.invokeCommand("skill-template:review", "--lang python", {
    isIdle: () => false,
  });

  assert.equal(harness.sentUserMessages.length, 1);
  assert.deepEqual(harness.sentUserMessages[0]?.options, { deliverAs: "steer" });
  assert.ok(String(harness.sentUserMessages[0]?.content).includes("Body python"));

  harness.cleanup();
});

test("alias command returns immediately while idle without waiting for a state flip", async () => {
  const harness = createHarness();
  const skillDir = join(harness.cwd, ".pi", "skills", "review");
  writeTextFile(join(skillDir, "SKILL.template.md"), "---\ndescription: review\n---\nBody {{ lang }}");

  await harness.emit("session_start");
  await harness.invokeCommand("skill-template:review", "--lang python");

  assert.equal(harness.sentUserMessages.length, 1);
  assert.equal(harness.sentUserMessages[0]?.options, undefined);
  assert.ok(String(harness.sentUserMessages[0]?.content).includes("Body python"));

  harness.cleanup();
});

test("alias command does not render a project template after trust is revoked", async () => {
  const harness = createHarness();
  const skillDir = join(harness.cwd, ".pi", "skills", "review");
  writeTextFile(join(skillDir, "SKILL.template.md"), "---\ndescription: review\n---\nBody");

  await harness.emit("session_start");
  assert.ok(harness.commands.has("skill-template:review"));

  harness.setProjectTrusted(false);
  await harness.invokeCommand("skill-template:review");

  assert.equal(harness.sentUserMessages.length, 0);
  assert.ok(harness.notifications.some((notification) => notification.message.includes("stale")));
  harness.cleanup();
});

test("alias command refresh uses injected home and agent dirs", async () => {
  const harness = createHarness();
  const skillDir = join(harness.agentDir, "skills", "review");
  const skillFile = join(skillDir, "SKILL.template.md");
  writeTextFile(skillFile, "---\ndescription: review\n---\nBody {{ lang }}");

  await harness.emit("session_start");
  await harness.emit("resources_discover");
  await harness.invokeCommand("skill-template:review", "--lang python");

  assert.equal(harness.sentUserMessages.length, 1);
  assert.ok(String(harness.sentUserMessages[0]?.content).includes("Body python"));
  assert.ok(String(harness.sentUserMessages[0]?.content).includes(canonicalizePath(skillFile)));

  harness.cleanup();
});

test("session_start only shows the shadow notice for an actual same-name sibling override", async () => {
  const mismatchedHarness = createHarness();
  const mismatchedDir = join(mismatchedHarness.cwd, ".pi", "skills", "code-review");
  writeTextFile(join(mismatchedDir, "SKILL.template.md"), "---\ndescription: review\n---\nBody");
  writeTextFile(join(mismatchedDir, "SKILL.md"), "---\nname: review\ndescription: review\n---\nFallback");

  await mismatchedHarness.emit("session_start");
  assert.ok(
    !mismatchedHarness.notifications.some((notification) => notification.message.includes("/skill:code-review")),
  );
  mismatchedHarness.cleanup();

  const matchingHarness = createHarness();
  const matchingDir = join(matchingHarness.cwd, ".pi", "skills", "review");
  writeTextFile(join(matchingDir, "SKILL.template.md"), "---\ndescription: review\n---\nBody");
  writeTextFile(join(matchingDir, "SKILL.md"), "---\ndescription: review\n---\nFallback");

  await matchingHarness.emit("session_start");
  assert.ok(
    matchingHarness.notifications.some((notification) => notification.message.includes("/skill:review")),
  );
  matchingHarness.cleanup();
});

test("resources_discover marks a catalog refresh pending and the next input refreshes it", async () => {
  const harness = createHarness();
  const skillDir = join(harness.cwd, ".pi", "skills", "review");

  await harness.emit("resources_discover");
  writeTextFile(join(skillDir, "SKILL.template.md"), "---\ndescription: review\n---\nBody");

  const result = await harness.emitInput({ text: "/skill:review" });

  assert.deepEqual(result, {
    action: "transform",
    text: [
      `<skill name="review" location="${canonicalizePath(join(skillDir, "SKILL.template.md"))}">`,
      `References are relative to ${canonicalizePath(skillDir)}.`,
      "",
      "Body",
      "</skill>",
    ].join("\n"),
    images: undefined,
  });
  harness.cleanup();
});
