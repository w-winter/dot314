import { describe, expect, test } from "bun:test";

import { normalizeTargetCwd } from "./move-session";

describe("normalizeTargetCwd", () => {
	test("resolves relative target paths to absolute paths", () => {
		expect(normalizeTargetCwd("../foo", {}, "/tmp/work/project")).toBe("/tmp/work/foo");
	});

	test("expands ~ before resolving the target path", () => {
		expect(normalizeTargetCwd("~/code", { HOME: "/Users/tester" }, "/tmp/work/project")).toBe(
			"/Users/tester/code",
		);
	});
});
