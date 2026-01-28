import fs from "node:fs/promises";
import path from "node:path";

function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function copyPath(fromPath, toPath) {
    const stat = await fs.stat(fromPath);

    await fs.mkdir(path.dirname(toPath), { recursive: true });

    if (stat.isDirectory()) {
        await fs.cp(fromPath, toPath, { recursive: true, force: true });
        return;
    }

    await fs.copyFile(fromPath, toPath);
}

async function walkFiles(rootDir) {
    const out = [];

    async function walk(currentDir) {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            if (entry.isFile()) {
                out.push(fullPath);
            }
        }
    }

    await walk(rootDir);
    return out;
}

function isExampleJsonFile(filePath) {
    const lower = filePath.toLowerCase();
    return lower.endsWith(".json.example") || lower.endsWith(".example.json");
}

async function enforceNoSecretJson(packageDir, allowJsonRelPaths) {
    const extensionsDir = path.join(packageDir, "extensions");
    if (!(await pathExists(extensionsDir))) return;

    const allowed = new Set((allowJsonRelPaths ?? []).map((p) => p.replaceAll("\\", "/")));

    for (const absPath of await walkFiles(extensionsDir)) {
        if (!absPath.toLowerCase().endsWith(".json")) continue;
        if (isExampleJsonFile(absPath)) continue;

        const rel = path
            .relative(packageDir, absPath)
            .replaceAll("\\", "/");

        if (allowed.has(rel)) continue;

        throw new Error(
            `Refusing to package JSON file under extensions/: ${rel}\n` +
                "This repo is symlinked to ~/.pi/agent, so local config files like notify.json can appear here.\n" +
                "Ship only *.json.example (or add an explicit allowlist via dot314Prepack.allowJson).",
        );
    }
}

async function main() {
    const packageDir = process.cwd();
    const packageJsonPath = path.join(packageDir, "package.json");

    const raw = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw);

    const spec = pkg.dot314Prepack;
    if (!isObject(spec) || !Array.isArray(spec.copy)) {
        throw new Error(
            "Missing dot314Prepack.copy in package.json. " +
                "Expected: { dot314Prepack: { copy: [{from,to}, ...] } }",
        );
    }

    for (const entry of spec.copy) {
        if (!isObject(entry)) throw new Error(`Invalid copy entry: ${JSON.stringify(entry)}`);

        const from = entry.from;
        const to = entry.to;

        if (typeof from !== "string" || typeof to !== "string") {
            throw new Error(`Invalid copy entry (from/to must be strings): ${JSON.stringify(entry)}`);
        }

        const absFrom = path.resolve(packageDir, from);
        const absTo = path.resolve(packageDir, to);

        const withinPackage = absTo === packageDir || absTo.startsWith(packageDir + path.sep);
        if (!withinPackage) {
            throw new Error(`Refusing to write outside package dir: ${to}`);
        }

        if (!(await pathExists(absFrom))) {
            throw new Error(`Source path does not exist: ${from} (resolved: ${absFrom})`);
        }

        await copyPath(absFrom, absTo);
    }

    await enforceNoSecretJson(packageDir, spec.allowJson);
}

main().catch((err) => {
    // prepack failure should abort publishing
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
});
