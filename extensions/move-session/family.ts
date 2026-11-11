import type { SessionHeader } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, type BigIntStats } from "node:fs";
import { link, mkdir, mkdtemp, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Type } from "typebox";
import { Assert } from "typebox/value";

const HEADER_CHUNK_BYTES = 4096;
const sessionHeaderSchema = Type.Object({
    type: Type.Literal("session"),
    id: Type.String({ pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$" }),
    timestamp: Type.String(),
    cwd: Type.String(),
    version: Type.Optional(Type.Number()),
    parentSession: Type.Optional(Type.String()),
});
const parentLinkSchema = Type.Pick(sessionHeaderSchema, ["type", "parentSession"]);

type Parent = { kind: "root" } | { kind: "linked" | "missing"; path: string };
type ParentLink = { kind: "indexed"; parent: Parent } | { kind: "unlinked" };

interface HeaderLine {
    line: string;
    bodyOffset: number;
}

interface SessionFile {
    path: string;
    header: SessionHeader;
    bodyOffset: number;
    fingerprint: BigIntStats;
    parent: Parent;
}

export interface FamilyMoveOptions {
    sourceSessionFile: string;
    sessionsRoot: string;
    targetCwd: string;
    targetSessionDir: string;
    /** Confirms the source and destination paths of the selected family before writing. */
    confirm(sources: string[], destinations: string[]): Promise<boolean>;
    /** Resolves only after Pi spawns. Rejection means no new Pi process is running. */
    launch(sessionFile: string): Promise<void>;
    /** Moves every supplied path to trash, rejecting on any failure. */
    trash(paths: string[]): Promise<void>;
}

function parseHeader(line: string, path: string): SessionHeader {
    try {
        const header: unknown = JSON.parse(line);
        Assert(sessionHeaderSchema, header);
        if (header.parentSession !== undefined && !isAbsolute(header.parentSession)) {
            throw new Error("parentSession must be an absolute path");
        }
        return header;
    } catch (error) {
        throw new Error(`Invalid session header: ${path}`, { cause: error });
    }
}

async function readHeaderLine(path: string): Promise<HeaderLine> {
    const file = await open(path, "r");
    const chunks: Buffer[] = [];
    let bodyOffset = 0;
    try {
        for (;;) {
            const buffer = Buffer.allocUnsafe(HEADER_CHUNK_BYTES);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            const newline = buffer.subarray(0, bytesRead).indexOf(10);
            chunks.push(buffer.subarray(0, newline === -1 ? bytesRead : newline));
            bodyOffset += newline === -1 ? bytesRead : newline + 1;
            if (newline !== -1) break;
        }
    } finally {
        await file.close();
    }
    return { line: Buffer.concat(chunks).toString("utf8"), bodyOffset };
}

async function resolveParent(parentSession: string | undefined): Promise<Parent> {
    if (parentSession === undefined) return { kind: "root" };
    try {
        return { kind: "linked", path: await realpath(parentSession) };
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        return { kind: "missing", path: parentSession };
    }
}

async function readSession(path: string): Promise<SessionFile> {
    const fingerprint = await stat(path, { bigint: true });
    const { line, bodyOffset } = await readHeaderLine(path);
    const header = parseHeader(line, path);
    return { path, header, bodyOffset, fingerprint, parent: await resolveParent(header.parentSession) };
}

async function readParentLink(path: string): Promise<ParentLink> {
    const { line } = await readHeaderLine(path);
    let header: unknown;
    try {
        header = JSON.parse(line);
        Assert(parentLinkSchema, header);
    } catch {
        return { kind: "unlinked" };
    }
    if (header.parentSession !== undefined && !isAbsolute(header.parentSession)) return { kind: "unlinked" };
    return { kind: "indexed", parent: await resolveParent(header.parentSession) };
}

async function readAncestorChain(source: string): Promise<SessionFile[]> {
    const sessions = new Map<string, SessionFile>();
    let ancestor = source;
    for (;;) {
        if (sessions.has(ancestor)) throw new Error(`Session parent cycle: ${ancestor}`);
        const session = await readSession(ancestor);
        sessions.set(ancestor, session);
        if (session.parent.kind === "root") return [...sessions.values()];
        if (session.parent.kind === "missing") throw new Error(`Missing parent session: ${session.parent.path}`);
        ancestor = session.parent.path;
    }
}

async function discoverSessionPaths(ancestors: SessionFile[], sessionsRoot: string): Promise<Set<string>> {
    const directories = new Set(ancestors.map((file) => dirname(file.path)));
    if (existsSync(sessionsRoot)) {
        for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
            if (entry.name.startsWith("--") && entry.name.endsWith("--") &&
                (entry.isDirectory() || entry.isSymbolicLink())) {
                directories.add(await realpath(join(sessionsRoot, entry.name)));
            }
        }
    }
    const paths = new Set<string>();
    for (const directory of directories) {
        for (const name of await readdir(directory)) {
            if (!name.endsWith(".jsonl")) continue;
            paths.add(await realpath(join(directory, name)));
        }
    }
    return paths;
}

async function indexFamilyLinks(ancestors: SessionFile[], sessionsRoot: string): Promise<Map<string, string[]>> {
    const parents = new Map(ancestors.map((file) => [file.path, file.parent]));
    for (const path of await discoverSessionPaths(ancestors, sessionsRoot)) {
        if (parents.has(path)) continue;
        const link = await readParentLink(path);
        if (link.kind === "unlinked") continue;
        parents.set(path, link.parent);
    }
    const children = new Map<string, string[]>();
    for (const [path, parent] of parents) {
        if (parent.kind !== "linked") continue;
        const siblings = children.get(parent.path) ?? [];
        siblings.push(path);
        children.set(parent.path, siblings);
    }
    return children;
}

async function discoverFamily(source: string, sessionsRoot: string): Promise<SessionFile[]> {
    const ancestors = await readAncestorChain(source);
    const sessions = new Map(ancestors.map((file) => [file.path, file]));
    const children = await indexFamilyLinks(ancestors, sessionsRoot);
    const family = [ancestors[ancestors.length - 1]!];
    for (let i = 0; i < family.length; i++) {
        for (const path of children.get(family[i].path) ?? []) {
            family.push(sessions.get(path) ?? await readSession(path));
        }
    }
    return family;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
        left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function assertUnchanged(family: SessionFile[], source: string, sessionsRoot: string): Promise<void> {
    const currentFamily = await discoverFamily(source, sessionsRoot);
    const current = new Map(currentFamily.map((file) => [file.path, file]));
    if (current.size !== family.length || family.some((file) => {
        const next = current.get(file.path);
        return !next || !sameFile(file.fingerprint, next.fingerprint);
    })) {
        throw new Error("Session family changed during the move. Close other family sessions and run the command again.");
    }
}

async function hashBody(path: string, start: number): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { start })) hash.update(chunk);
    return hash.digest("hex");
}

async function writeFamilyCopies(
    family: SessionFile[], targets: Map<string, string>, staging: string, targetCwd: string,
): Promise<void> {
    for (const file of family) {
        const header = { ...file.header, cwd: targetCwd };
        if (file.parent.kind === "linked") {
            const parentTarget = targets.get(file.parent.path);
            if (!parentTarget) throw new Error(`Parent is missing from family: ${file.parent.path}`);
            header.parentSession = parentTarget;
        }
        const headerBytes = Buffer.from(JSON.stringify(header) + "\n");
        const staged = join(staging, basename(targets.get(file.path)!));
        await writeFile(staged, headerBytes, { flag: "wx", mode: Number(file.fingerprint.mode & 0o777n) });
        await pipeline(createReadStream(file.path, { start: file.bodyOffset }), createWriteStream(staged, { flags: "a" }));
        const stagedFile = await open(staged, "r+");
        try {
            await stagedFile.sync();
        } finally {
            await stagedFile.close();
        }
        if (await hashBody(file.path, file.bodyOffset) !== await hashBody(staged, headerBytes.length)) {
            throw new Error(`Session copy verification failed: ${file.path}`);
        }
    }
}

async function rollbackCopies(copies: string[], trash: FamilyMoveOptions["trash"], failure: Error): Promise<never> {
    try {
        if (copies.length) await trash(copies);
    } catch (error) {
        const cleanupFailure = error instanceof Error ? error : new Error(String(error));
        throw new AggregateError([failure, cleanupFailure],
            `Family move failed: ${failure.message}. Originals kept. Rollback failed: ${cleanupFailure.message}\n` +
            `Inspect retained copies before retrying:\n${copies.join("\n")}`);
    }
    throw new Error(`Family move failed: ${failure.message}. Originals kept.`, { cause: failure });
}

/** Copies the confirmed family, launches Pi, then trashes originals. Returns false on cancellation. Pre-launch failures roll back copies; post-launch failures retain them and report recovery paths. */
export async function moveSessionFamily(options: FamilyMoveOptions): Promise<boolean> {
    const source = await realpath(options.sourceSessionFile);
    const family = await discoverFamily(source, options.sessionsRoot);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const targets = new Map(family.map((file) => [
        file.path, join(options.targetSessionDir, `${timestamp}_${file.header.id}.jsonl`),
    ]));
    const destinations = [...targets.values()];
    if (new Set(destinations).size !== destinations.length) throw new Error("Family contains duplicate session IDs.");
    const destination = targets.get(source)!;
    if (!await options.confirm(family.map((file) => file.path), destinations)) return false;

    let staging: string | null = null;
    const published: string[] = [];
    let launched = false;
    try {
        await assertUnchanged(family, source, options.sessionsRoot);
        const conflict = destinations.find(existsSync);
        if (conflict) throw new Error(`Destination already exists: ${conflict}`);
        await mkdir(options.targetSessionDir, { recursive: true });
        staging = await mkdtemp(join(options.targetSessionDir, ".move-session-"));
        await writeFamilyCopies(family, targets, staging, options.targetCwd);
        await assertUnchanged(family, source, options.sessionsRoot);
        for (const target of destinations) {
            // Hard links publish complete files atomically and refuse to overwrite a competing destination.
            await link(join(staging, basename(target)), target);
            published.push(target);
        }
        await options.launch(destination);
        launched = true;
        // ponytail: require other family sessions closed until Pi provides a shared file lock.
        await assertUnchanged(family, source, options.sessionsRoot);
        await options.trash([staging]);
        staging = null;
        await options.trash(family.map((file) => file.path));
        const remaining = family.filter((file) => existsSync(file.path));
        if (remaining.length) throw new Error(`Original sessions remain: ${remaining.map((file) => file.path).join(", ")}`);
        return true;
    } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (launched) {
            throw new Error(`Pi launched from ${destination}, but cleanup failed: ${failure.message}\n` +
                `Keep the moved family in ${options.targetSessionDir}. Inspect original paths before removing duplicates:\n` +
                family.map((file) => file.path).join("\n") + (staging ? `\nStaging copies: ${staging}` : ""), { cause: failure });
        }
        const copies = [...published, ...(staging ? [staging] : [])];
        return rollbackCopies(copies, options.trash, failure);
    }
}
