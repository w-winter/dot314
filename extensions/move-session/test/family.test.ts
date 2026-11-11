import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionHeader } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { moveSessionFamily, type FamilyMoveOptions } from "../family.ts";

let root: string;
let options: FamilyMoveOptions;
let launched: string[];
let trashed: string[];

function session(bucket: string, id: string, parentSession?: string): string {
    const file = join(root, "sessions", `--${bucket}--`, `original_${id}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
        type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z",
        cwd: `/work/${bucket}`, parentSession, customMetadata: "保存🪶".repeat(3000),
    }) + '\n{"type":"custom","data":"history 🪶"}\n');
    return file;
}

function read(file: string) {
    const bytes = readFileSync(file);
    const newline = bytes.indexOf(10);
    const header: SessionHeader = JSON.parse(bytes.subarray(0, newline).toString());
    return { header, body: bytes.subarray(newline + 1) };
}

function destinations(): string[] {
    if (!existsSync(options.targetSessionDir)) return [];
    return readdirSync(options.targetSessionDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(options.targetSessionDir, name));
}

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-move-family-test-")));
    mkdirSync(join(root, "trash"));
    launched = [];
    trashed = [];
    options = {
        sourceSessionFile: session("one", "selected"),
        sessionsRoot: join(root, "sessions"),
        targetCwd: join(root, "new workspace"),
        targetSessionDir: join(root, "sessions", "--target--"),
        confirm: async () => true,
        launch: async (file) => { launched.push(file); },
        trash: async (paths) => {
            for (const path of paths) {
                renameSync(path, join(root, "trash", `${trashed.length}_${basename(path)}`));
                trashed.push(path);
            }
        },
    };
    mkdirSync(options.targetCwd);
});

afterEach(() => {
    execFileSync("trash", [root]);
});

describe("family moves using real session files", () => {
    test("moves ancestors, siblings, cousins and deep descendants across buckets, preserving history and IDs", async () => {
        const ancestor = session("one", "ancestor");
        const parent = session("one", "parent", ancestor);
        const selected = session("two", "selected", parent);
        const sibling = session("three", "sibling", parent);
        const aunt = session("one", "aunt", ancestor);
        const cousin = session("three", "cousin", aunt);
        const child = session("two", "child", selected);
        const grandchild = session("two", "grandchild", child);
        const greatGrandchild = session("two", "great-grandchild", grandchild);
        const unrelated = session("three", "unrelated");
        const originals = [ancestor, parent, selected, sibling, aunt, cousin, child, grandchild, greatGrandchild];
        const before = new Map(originals.map((file) => [file, read(file)]));
        options.sourceSessionFile = selected;
        options.confirm = async (files) => {
            expect(new Set(files)).toEqual(new Set(originals));
            expect(destinations()).toEqual([]);
            return true;
        };
        options.launch = async (file) => {
            expect(originals.every(existsSync)).toBe(true);
            expect(destinations()).toHaveLength(originals.length);
            launched.push(file);
        };

        expect(await moveSessionFamily(options)).toBe(true);

        const moved = new Map(destinations().map((file) => [read(file).header.id, file]));
        expect(launched).toEqual([moved.get("selected")!]);
        expect(existsSync(unrelated)).toBe(true);
        for (const original of originals) {
            expect(existsSync(original)).toBe(false);
            const old = before.get(original)!;
            const next = read(moved.get(old.header.id)!);
            expect(next.body).toEqual(old.body);
            const expectedHeader = { ...old.header, cwd: options.targetCwd };
            if (old.header.parentSession !== undefined) {
                expectedHeader.parentSession = moved.get(before.get(old.header.parentSession)!.header.id)!;
            }
            expect(next.header).toEqual(expectedHeader);
        }
    });

    test("cancellation leaves all files untouched", async () => {
        const original = readFileSync(options.sourceSessionFile);
        options.confirm = async () => false;
        expect(await moveSessionFamily(options)).toBe(false);
        expect(readFileSync(options.sourceSessionFile)).toEqual(original);
        expect(destinations()).toEqual([]);
        expect(launched).toEqual([]);
        expect(trashed).toEqual([]);
    });

    test("canonicalizes symlink paths and follows parents outside the standard store", async () => {
        const external = join(root, "custom");
        mkdirSync(external);
        const parent = session("one", "parent");
        const externalParent = join(external, basename(parent));
        renameSync(parent, externalParent);
        const alias = join(root, "alias");
        symlinkSync(external, alias);
        options.sourceSessionFile = session("one", "selected", join(alias, basename(parent)));
        await moveSessionFamily(options);
        const moved = destinations().map(read);
        expect(moved.map(({ header }) => header.id).sort()).toEqual(["parent", "selected"]);
        expect(existsSync(externalParent)).toBe(false);
    });

    test("can move a family member that is already in the target bucket", async () => {
        const parent = session("target", "parent");
        options.sourceSessionFile = session("one", "selected", parent);
        await moveSessionFamily(options);
        expect(existsSync(parent)).toBe(false);
        expect(destinations()).toHaveLength(2);
    });

    test("missing parents and cycles abort without removing sessions", async () => {
        options.sourceSessionFile = session("one", "selected", join(root, "missing.jsonl"));
        await expect(moveSessionFamily(options)).rejects.toThrow("parent");
        const parent = session("one", "parent", options.sourceSessionFile);
        session("one", "selected", parent);
        await expect(moveSessionFamily(options)).rejects.toThrow("cycle");
        expect(existsSync(options.sourceSessionFile)).toBe(true);
        expect(existsSync(parent)).toBe(true);
        expect(trashed).toEqual([]);
        expect(launched).toEqual([]);
    });

    test("confirmation only describes the family and leaves unrelated invalid files untouched", async () => {
        const unrelated = session("other", "unrelated");
        const broken = join(dirname(options.sourceSessionFile), "broken.jsonl");
        writeFileSync(unrelated, '{"type":"custom_message","id":"orphan"}\n');
        writeFileSync(broken, "not JSON\n");
        const invalidRoot = session("other", "invalid-root");
        writeFileSync(invalidRoot, '{"type":"session","id":12}\n');
        const child = session("one", "child", options.sourceSessionFile);
        options.confirm = async (...confirmationPaths) => {
            const [sources] = confirmationPaths;
            expect(new Set(sources)).toEqual(new Set([options.sourceSessionFile, child]));
            expect(confirmationPaths.flat()).not.toContain(unrelated);
            expect(confirmationPaths.flat()).not.toContain(broken);
            return true;
        };
        await moveSessionFamily(options);
        expect(destinations()).toHaveLength(2);
        expect(readFileSync(unrelated, "utf8")).toBe('{"type":"custom_message","id":"orphan"}\n');
        expect(readFileSync(broken, "utf8")).toBe("not JSON\n");
        expect(readFileSync(invalidRoot, "utf8")).toBe('{"type":"session","id":12}\n');
    });

    test("invalid metadata on a linked descendant still aborts the move", async () => {
        const child = session("other", "child", options.sourceSessionFile);
        writeFileSync(child, JSON.stringify({type: "session", id: 12, parentSession: options.sourceSessionFile}) + "\n");
        await expect(moveSessionFamily(options)).rejects.toThrow(child);
        expect(existsSync(options.sourceSessionFile)).toBe(true);
        expect(trashed).toEqual([]);
        expect(launched).toEqual([]);
    });

    test("a referenced ancestor without a header still aborts the move", async () => {
        const parent = session("other", "parent");
        options.sourceSessionFile = session("one", "selected", parent);
        writeFileSync(parent, '{"type":"message","id":"orphan"}\n');
        await expect(moveSessionFamily(options)).rejects.toThrow(parent);
        expect(existsSync(options.sourceSessionFile)).toBe(true);
        expect(trashed).toEqual([]);
        expect(launched).toEqual([]);
    });

    test("ignores other applications' stores alongside Pi working-directory folders", async () => {
        const foreignStore = join(options.sessionsRoot, "claude-code");
        mkdirSync(foreignStore);
        writeFileSync(join(foreignStore, "conversation.jsonl"), '{"type":"user","message":"foreign format"}\n');
        await moveSessionFamily(options);
        expect(destinations()).toHaveLength(1);
        expect(existsSync(join(foreignStore, "conversation.jsonl"))).toBe(true);
    });

    test("a source changed during confirmation aborts before launch", async () => {
        options.confirm = async () => {
            appendFileSync(options.sourceSessionFile, '{"type":"custom","data":"new work"}\n');
            return true;
        };
        await expect(moveSessionFamily(options)).rejects.toThrow("changed");
        expect(readFileSync(options.sourceSessionFile, "utf8")).toContain("new work");
        expect(destinations()).toEqual([]);
        expect(launched).toEqual([]);
    });

    test("a new descendant during confirmation requires another confirmation", async () => {
        options.confirm = async () => {
            session("one", "new-child", options.sourceSessionFile);
            return true;
        };
        await expect(moveSessionFamily(options)).rejects.toThrow("changed");
        expect(destinations()).toEqual([]);
        expect(launched).toEqual([]);
    });

    test("destination conflicts never overwrite existing files", async () => {
        options.confirm = async (_files, targets) => {
            mkdirSync(options.targetSessionDir, { recursive: true });
            writeFileSync(targets[0]!, "existing data");
            return true;
        };
        await expect(moveSessionFamily(options)).rejects.toThrow();
        expect(destinations().map((file) => readFileSync(file, "utf8"))).toEqual(["existing data"]);
        expect(existsSync(options.sourceSessionFile)).toBe(true);
        expect(launched).toEqual([]);
    });

    test("failed launch rolls back published copies and retains every original", async () => {
        const child = session("one", "child", options.sourceSessionFile);
        options.launch = async () => { throw new Error("launch failed"); };
        await expect(moveSessionFamily(options)).rejects.toThrow("launch failed");
        expect(destinations()).toEqual([]);
        expect(existsSync(options.sourceSessionFile)).toBe(true);
        expect(existsSync(child)).toBe(true);
    });

    test("writes during launch keep all originals and report incomplete cleanup", async () => {
        options.launch = async (file) => {
            launched.push(file);
            appendFileSync(options.sourceSessionFile, '{"type":"custom","data":"late work"}\n');
        };
        await expect(moveSessionFamily(options)).rejects.toThrow("changed");
        expect(existsSync(options.sourceSessionFile)).toBe(true);
        expect(destinations()).toHaveLength(1);
        expect(trashed).not.toContain(options.sourceSessionFile);
    });

    test("partial trash failure retains the complete destination family and reports recovery paths", async () => {
        const child = session("one", "child", options.sourceSessionFile);
        const originalTrash = options.trash;
        options.trash = async (paths) => {
            if (paths.includes(options.sourceSessionFile)) {
                await originalTrash([options.sourceSessionFile]);
                throw new Error("trash failed");
            }
            await originalTrash(paths);
        };
        await expect(moveSessionFamily(options)).rejects.toThrow(options.targetSessionDir);
        expect(destinations()).toHaveLength(2);
        expect(existsSync(child)).toBe(true);
        expect(launched).toHaveLength(1);
    });

    test("rollback failures report retained paths and keep originals", async () => {
        options.launch = async () => { throw new Error("launch failed"); };
        options.trash = async () => { throw new Error("trash unavailable"); };
        await expect(moveSessionFamily(options)).rejects.toThrow(options.targetSessionDir);
        expect(existsSync(options.sourceSessionFile)).toBe(true);
        expect(destinations()).toHaveLength(1);
    });
});
