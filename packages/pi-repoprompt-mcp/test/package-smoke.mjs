import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_TIMEOUT_MS = 120_000;
const RPC_RESPONSE_TIMEOUT_MS = 30_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;
const RPC_REQUEST_ID = "package-smoke-get-commands";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const canonicalSourceDirectory = resolve(repositoryDirectory, "extensions/repoprompt-mcp/src");

function commandError(command, args, result, detail) {
  const renderedCommand = [command, ...args].join(" ");
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return new Error(`${detail}: ${renderedCommand}${output ? `\n${output}` : ""}`);
}

async function runCommand(command, args, options) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceStopTimer;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      forceStopTimer = setTimeout(() => child.kill("SIGKILL"), PROCESS_STOP_TIMEOUT_MS);
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);

    function settle(callback) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceStopTimer);
      callback();
    }

    child.on("error", (error) => {
      settle(() => rejectPromise(commandError(command, args, { stdout, stderr }, error.message)));
    });
    child.on("close", (code, signal) => {
      settle(() => {
        const result = { code, signal, stdout: stdout.trim(), stderr: stderr.trim() };
        if (code === 0) {
          resolvePromise(result);
          return;
        }
        const detail = signal
          ? `Command terminated by ${signal}`
          : `Command exited with code ${String(code)}`;
        rejectPromise(commandError(command, args, result, detail));
      });
    });
  });
}

async function listFiles(rootDirectory) {
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(relative(rootDirectory, absolutePath));
      }
    }
  }

  await visit(rootDirectory);
  return files.sort();
}

async function assertCanonicalSourceParity(packagedSourceDirectory) {
  const canonicalFiles = await listFiles(canonicalSourceDirectory);
  const packagedFiles = await listFiles(packagedSourceDirectory);
  if (JSON.stringify(packagedFiles) !== JSON.stringify(canonicalFiles)) {
    throw new Error(
      `Packaged source file list differs from canonical source\n` +
        `Canonical: ${JSON.stringify(canonicalFiles)}\nPackaged: ${JSON.stringify(packagedFiles)}`,
    );
  }

  for (const relativePath of canonicalFiles) {
    const [canonicalContent, packagedContent] = await Promise.all([
      readFile(join(canonicalSourceDirectory, relativePath)),
      readFile(join(packagedSourceDirectory, relativePath)),
    ]);
    if (!canonicalContent.equals(packagedContent)) {
      throw new Error(`Packaged source differs from canonical source: ${relativePath}`);
    }
  }
}

async function assertPackagedManifest(extractedPackageDirectory) {
  const manifest = JSON.parse(await readFile(join(extractedPackageDirectory, "package.json"), "utf8"));
  const extensionEntry = "extensions/repoprompt-mcp/src/index.ts";
  if (!manifest.pi?.extensions?.includes(extensionEntry)) {
    throw new Error(`Packaged manifest does not register ${extensionEntry}`);
  }
  for (const dependency of ["@modelcontextprotocol/sdk", "diff"]) {
    if (typeof manifest.dependencies?.[dependency] !== "string") {
      throw new Error(`Packaged manifest is missing runtime dependency ${dependency}`);
    }
  }
  for (const peerDependency of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    if (manifest.peerDependencies?.[peerDependency] !== ">=0.83.0") {
      throw new Error(`Packaged manifest must require ${peerDependency} 0.83.0 or newer`);
    }
  }
  if (typeof manifest.peerDependencies?.typebox !== "string") {
    throw new Error("Packaged manifest is missing the typebox peer dependency");
  }
}

async function writeHeadlessExtensionConfig(homeDirectory) {
  const extensionConfigDirectory = join(homeDirectory, ".pi", "agent", "extensions");
  await mkdir(extensionConfigDirectory, { recursive: true });
  const inertTarget = {
    command: process.execPath,
    args: ["-e", "process.exit(1)"],
    autoLaunchApp: false,
  };
  const config = {
    activeApp: "ce",
    apps: { ce: inertTarget, classic: inertTarget },
    autoBindOnStart: false,
    persistBinding: false,
  };
  await writeFile(
    join(extensionConfigDirectory, "repoprompt-mcp.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function parseJsonLines(buffer, onRecord) {
  let remaining = buffer;
  while (remaining.includes("\n")) {
    const newlineIndex = remaining.indexOf("\n");
    const line = remaining.slice(0, newlineIndex).replace(/\r$/u, "");
    remaining = remaining.slice(newlineIndex + 1);
    if (line.length > 0) {
      onRecord(JSON.parse(line));
    }
  }
  return remaining;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolvePromise) => child.once("close", resolvePromise));
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    closed.then(() => true),
    new Promise((resolvePromise) => {
      setTimeout(() => resolvePromise(false), PROCESS_STOP_TIMEOUT_MS).unref();
    }),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await closed;
  }
}

async function queryRpcCommands(piEnvironment, workingDirectory) {
  const child = spawn("pi", ["--mode", "rpc", "--no-session"], {
    cwd: workingDirectory,
    env: piEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  let pendingStdout = "";
  const records = [];

  const responsePromise = new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      try {
        pendingStdout = parseJsonLines(pendingStdout + chunk, (record) => {
          records.push(record);
          if (record.type === "response" && record.id === RPC_REQUEST_ID) {
            resolvePromise(record);
          }
        });
      } catch (error) {
        rejectPromise(error);
      }
    });
    child.on("close", (code, signal) => {
      rejectPromise(
        new Error(
          `Pi RPC exited before get_commands responded (code=${String(code)}, signal=${String(signal)})` +
            `${stdout || stderr ? `\n${stdout}\n${stderr}` : ""}`,
        ),
      );
    });
  });

  try {
    child.stdin.write(`${JSON.stringify({ type: "get_commands", id: RPC_REQUEST_ID })}\n`);
    const response = await Promise.race([
      responsePromise,
      new Promise((_, rejectPromise) => {
        setTimeout(
          () => rejectPromise(new Error(`Timed out waiting for get_commands\n${stdout}\n${stderr}`)),
          RPC_RESPONSE_TIMEOUT_MS,
        ).unref();
      }),
    ]);

    const extensionErrors = records.filter((record) => record.type === "extension_error");
    if (extensionErrors.length > 0 || stdout.includes("extension_error") || stderr.includes("extension_error")) {
      throw new Error(`Pi RPC emitted extension_error\n${stdout}\n${stderr}`);
    }
    if (response.success !== true || response.command !== "get_commands") {
      throw new Error(`get_commands failed: ${JSON.stringify(response)}`);
    }
    const commands = response.data?.commands;
    if (!Array.isArray(commands) || !commands.some((command) => command?.name === "rp")) {
      throw new Error(`get_commands did not include rp: ${JSON.stringify(response)}`);
    }
  } finally {
    child.stdin.end();
    await stopProcess(child);
  }
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) !== 22) {
    throw new Error(`package smoke requires Node 22, received ${process.version}`);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-repoprompt-package-smoke-"));
  const extractionDirectory = join(temporaryRoot, "extract");
  const agentDirectory = join(temporaryRoot, "agent");
  const homeDirectory = join(temporaryRoot, "home");
  const npmCacheDirectory = join(temporaryRoot, "npm-cache");
  const workingDirectory = join(temporaryRoot, "work");
  let tarballPath;

  try {
    await Promise.all([
      mkdir(extractionDirectory, { recursive: true }),
      mkdir(agentDirectory, { recursive: true }),
      mkdir(homeDirectory, { recursive: true }),
      mkdir(npmCacheDirectory, { recursive: true }),
      mkdir(workingDirectory, { recursive: true }),
    ]);
    await writeHeadlessExtensionConfig(homeDirectory);

    const packResult = await runCommand(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--json", "--pack-destination", temporaryRoot],
      {
        cwd: packageDirectory,
        env: {
          ...process.env,
          npm_config_cache: npmCacheDirectory,
          npm_config_ignore_scripts: "false",
        },
      },
    );
    const packMetadata = JSON.parse(packResult.stdout);
    if (!Array.isArray(packMetadata) || packMetadata.length !== 1 || !packMetadata[0]?.filename) {
      throw new Error(`Unexpected npm pack --json output: ${packResult.stdout}`);
    }
    tarballPath = resolve(temporaryRoot, packMetadata[0].filename);

    await runCommand(
      "tar",
      ["-xzf", tarballPath, "-C", extractionDirectory],
      { cwd: packageDirectory, env: process.env },
    );
    const extractedPackageDirectory = join(extractionDirectory, "package");
    await assertCanonicalSourceParity(
      join(extractedPackageDirectory, "extensions", "repoprompt-mcp", "src"),
    );
    await assertPackagedManifest(extractedPackageDirectory);

    // Pi links absolute local packages; the repository install supplies their declared runtime dependencies
    const piEnvironment = {
      ...process.env,
      HOME: homeDirectory,
      NODE_PATH: resolve(repositoryDirectory, "node_modules"),
      npm_config_cache: npmCacheDirectory,
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    };
    await runCommand(
      "pi",
      ["install", resolve(extractedPackageDirectory)],
      { cwd: workingDirectory, env: piEnvironment },
    );
    await queryRpcCommands(piEnvironment, workingDirectory);

    process.stdout.write(
      `Package smoke passed for ${basename(tarballPath)}: canonical source parity and Pi RPC command registration\n`,
    );
  } finally {
    if (tarballPath) {
      await rm(tarballPath, { force: true });
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
