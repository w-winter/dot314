/**
 * Tests for isolated mode (CLAUDE_BRIDGE_ISOLATED=1) and the piUserDir routing
 * for paths that must follow the configured Pi directory.
 *
 * Isolated mode is the contract for host apps that embed the bridge and own
 * every config dir explicitly (PI_CODING_AGENT_DIR + CLAUDE_CONFIG_DIR) : no
 * cwd-ancestor discovery, no $PATH executable fallback, nothing read from the
 * real home directory. Default (unset) behavior must be byte-identical to the
 * pre-isolation bridge.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isolatedFromEnv, loadConfig, piUserDir, recordProjectTrust } from "../src/config.ts";
import { extractAgentsAppend, resolveAgentsMdPath } from "../src/agents-md.ts";
import { readAppendSystemPromptFiles } from "../src/prompt-context.ts";
import { resolveClaudeExecutable } from "../src/index.ts";

const ENV_KEYS = ["CLAUDE_BRIDGE_ISOLATED", "PI_CODING_AGENT_DIR", "PATH"];

function withEnv(overrides, fn) {
	const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-isolation-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("isolatedFromEnv", () => {
	it("is off when unset, empty, or falsy", () => {
		for (const value of [undefined, "", "0", "false", "off", "no", "nonsense"]) {
			withEnv({ CLAUDE_BRIDGE_ISOLATED: value }, () => {
				assert.equal(isolatedFromEnv(), false, `value: ${value}`);
			});
		}
	});

	it("accepts the same truthy spellings as the connector flag", () => {
		for (const value of ["1", "true", "yes", "on", " TRUE ", "Yes"]) {
			withEnv({ CLAUDE_BRIDGE_ISOLATED: value }, () => {
				assert.equal(isolatedFromEnv(), true, `value: ${value}`);
			});
		}
	});
});

describe("piUserDir", () => {
	it("defaults to ~/.pi/agent when PI_CODING_AGENT_DIR is unset (no-behavior-change proof)", () => {
		withEnv({ PI_CODING_AGENT_DIR: undefined }, () => {
			assert.equal(piUserDir(), resolve(join(homedir(), ".pi", "agent")));
		});
	});

	it("resolves PI_CODING_AGENT_DIR when set", () => withTempDir((dir) => {
		withEnv({ PI_CODING_AGENT_DIR: dir }, () => {
			assert.equal(piUserDir(), resolve(dir));
		});
	}));
});

describe("resolveAgentsMdPath isolation", () => {
	it("default mode still finds AGENTS.md in cwd parents", () => withTempDir((dir) => {
		const cwdDir = join(dir, "cwd");
		mkdirSync(cwdDir, { recursive: true });
		writeFileSync(join(cwdDir, "AGENTS.md"), "# personal instructions\n");
		const oldCwd = process.cwd();
		try {
			process.chdir(cwdDir);
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined }, () => {
				assert.equal(resolveAgentsMdPath(), join(process.cwd(), "AGENTS.md"));
			});
		} finally {
			process.chdir(oldCwd);
		}
	}));

	it("AGENTS.override.md replaces AGENTS.md in the same directory", () => withTempDir((dir) => {
		const cwdDir = join(dir, "cwd");
		mkdirSync(cwdDir, { recursive: true });
		writeFileSync(join(cwdDir, "AGENTS.md"), "# base instructions\n");
		writeFileSync(join(cwdDir, "AGENTS.override.md"), "# override instructions\n");
		const oldCwd = process.cwd();
		try {
			process.chdir(cwdDir);
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined }, () => {
				assert.equal(resolveAgentsMdPath(), join(process.cwd(), "AGENTS.override.md"));
				assert.match(extractAgentsAppend() ?? "", /override instructions/);
			});
		} finally {
			process.chdir(oldCwd);
		}
	}));

	it("a nearer AGENTS.md still wins over an ancestor AGENTS.override.md", () => withTempDir((dir) => {
		const cwdDir = join(dir, "parent", "child");
		mkdirSync(cwdDir, { recursive: true });
		writeFileSync(join(dir, "parent", "AGENTS.override.md"), "# ancestor override\n");
		writeFileSync(join(cwdDir, "AGENTS.md"), "# nearest instructions\n");
		const oldCwd = process.cwd();
		try {
			process.chdir(cwdDir);
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined }, () => {
				assert.equal(resolveAgentsMdPath(), join(process.cwd(), "AGENTS.md"));
			});
		} finally {
			process.chdir(oldCwd);
		}
	}));

	it("a directory named AGENTS.md is not treated as a context file", () => withTempDir((dir) => {
		// The walk-up must step over the directory and find the real file one level up.
		const cwdDir = join(dir, "parent", "child");
		mkdirSync(join(cwdDir, "AGENTS.md"), { recursive: true });
		writeFileSync(join(dir, "parent", "AGENTS.md"), "# ancestor instructions\n");
		const oldCwd = process.cwd();
		try {
			process.chdir(cwdDir);
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined, PI_CODING_AGENT_DIR: join(dir, "empty-agent") }, () => {
				assert.equal(
					realpathSync(resolveAgentsMdPath()),
					realpathSync(join(dir, "parent", "AGENTS.md")),
				);
			});
		} finally {
			process.chdir(oldCwd);
		}
	}));

	it("AGENTS.MD is accepted, matching Pi's candidate order", () => withTempDir((dir) => {
		const cwdDir = join(dir, "cwd");
		mkdirSync(cwdDir, { recursive: true });
		writeFileSync(join(cwdDir, "AGENTS.MD"), "# uppercase instructions\n");
		const oldCwd = process.cwd();
		try {
			process.chdir(cwdDir);
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined }, () => {
				assert.equal(
					readFileSync(resolveAgentsMdPath(), "utf8"),
					"# uppercase instructions\n",
				);
			});
		} finally {
			process.chdir(oldCwd);
		}
	}));

	it("a dangling AGENTS.override.md symlink falls through to AGENTS.md", () => withTempDir((dir) => {
		const cwdDir = join(dir, "cwd");
		mkdirSync(cwdDir, { recursive: true });
		writeFileSync(join(cwdDir, "AGENTS.md"), "# base instructions\n");
		symlinkSync(join(cwdDir, "does-not-exist.md"), join(cwdDir, "AGENTS.override.md"));
		const oldCwd = process.cwd();
		try {
			process.chdir(cwdDir);
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined }, () => {
				assert.equal(resolveAgentsMdPath(), join(process.cwd(), "AGENTS.md"));
				assert.match(extractAgentsAppend() ?? "", /base instructions/);
			});
		} finally {
			process.chdir(oldCwd);
		}
	}));

	it("the piUserDir fallback honors AGENTS.override.md too", () => withTempDir((dir) => {
		const cwdDir = join(dir, "cwd");
		const agentDir = join(dir, "agent");
		mkdirSync(cwdDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "AGENTS.md"), "# global base\n");
		writeFileSync(join(agentDir, "AGENTS.override.md"), "# global override\n");
		const oldCwd = process.cwd();
		try {
			process.chdir(cwdDir);
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined, PI_CODING_AGENT_DIR: agentDir }, () => {
				assert.equal(resolveAgentsMdPath(), resolve(join(agentDir, "AGENTS.override.md")));
				assert.match(extractAgentsAppend() ?? "", /global override/);
			});
		} finally {
			process.chdir(oldCwd);
		}
	}));

	it("default mode falls back to the piUserDir AGENTS.md", () => withTempDir((dir) => {
		const cwdDir = join(dir, "cwd");
		const agentDir = join(dir, "agent");
		mkdirSync(cwdDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "AGENTS.md"), "# global instructions\n");
		const oldCwd = process.cwd();
		try {
			process.chdir(cwdDir);
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined, PI_CODING_AGENT_DIR: agentDir }, () => {
				assert.equal(resolveAgentsMdPath(), resolve(join(agentDir, "AGENTS.md")));
				assert.match(extractAgentsAppend() ?? "", /global instructions/);
			});
		} finally {
			process.chdir(oldCwd);
		}
	}));

	it("isolated mode suppresses cwd and shared piUserDir AGENTS.md", () => withTempDir((dir) => {
		const cwdDir = join(dir, "cwd");
		const agentDir = join(dir, "agent");
		mkdirSync(cwdDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwdDir, "AGENTS.md"), "# personal instructions\n");
		writeFileSync(join(agentDir, "AGENTS.md"), "# shared global instructions\n");
		const oldCwd = process.cwd();
		try {
			process.chdir(cwdDir);
			withEnv({ CLAUDE_BRIDGE_ISOLATED: "1", PI_CODING_AGENT_DIR: agentDir }, () => {
				assert.equal(resolveAgentsMdPath(), undefined);
				assert.equal(extractAgentsAppend(), undefined);
			});
		} finally {
			process.chdir(oldCwd);
		}
	}));
});

describe("loadConfig isolation", () => {
	it("isolated mode ignores trusted project config in favor of user config", () => withTempDir((dir) => {
		const agentDir = join(dir, "agent");
		const project = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({
			enabled: true,
			provider: {
				fastMode: false,
				pathToClaudeCodeExecutable: "/opt/host/sha-pinned-claude",
				enableConnectors: false,
				connectorWriteMode: "deny",
			},
		}));
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({
			provider: {
				fastMode: true,
				pathToClaudeCodeExecutable: "/opt/project/claude",
				enableConnectors: true,
				connectorWriteMode: "allow",
			},
		}));
		withEnv({ PI_CODING_AGENT_DIR: agentDir }, () => {
			recordProjectTrust({ cwd: project, isProjectTrusted: () => true });
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined }, () => {
				const config = loadConfig(project);
				assert.equal(config.provider?.fastMode, true);
				assert.equal(config.provider?.pathToClaudeCodeExecutable, "/opt/project/claude");
				assert.equal(config.provider?.enableConnectors, false);
				assert.equal(config.provider?.connectorWriteMode, "deny");
				assert.equal(config.enabled, true);
			});
			// Isolated mode ignores the project file.
			withEnv({ CLAUDE_BRIDGE_ISOLATED: "1" }, () => {
				const config = loadConfig(project);
				assert.equal(config.provider?.fastMode, false);
				assert.equal(config.provider?.pathToClaudeCodeExecutable, "/opt/host/sha-pinned-claude");
				assert.equal(config.provider?.enableConnectors, false);
				assert.equal(config.provider?.connectorWriteMode, "deny");
				assert.equal(config.enabled, true);
			});
		});
	}));
});

describe("recordProjectTrust isolation", () => {
	it("isolated mode records nothing (no cwd walk, no trust entry)", () => withTempDir((dir) => {
		const agentDir = join(dir, "agent");
		const project = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "settings.json"), "{}");
		writeFileSync(join(project, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { fastMode: true } }));
		withEnv({ PI_CODING_AGENT_DIR: agentDir }, () => {
			// Trust recorded while isolated must be a no-op: a later default-mode
			// loadConfig still treats the project as untrusted.
			withEnv({ CLAUDE_BRIDGE_ISOLATED: "1" }, () => {
				recordProjectTrust({ cwd: project, isProjectTrusted: () => true });
			});
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined }, () => {
				const config = loadConfig(project);
				assert.equal(config.provider?.fastMode, undefined);
			});
		});
	}));
});

describe("readAppendSystemPromptFiles isolation", () => {
	it("isolated mode skips project .pi/APPEND_SYSTEM.md but keeps the piUserDir file", () => withTempDir((dir) => {
		const agentDir = join(dir, "agent");
		const project = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "global extra\n");
		writeFileSync(join(project, ".pi", "APPEND_SYSTEM.md"), "project extra\n");
		withEnv({ PI_CODING_AGENT_DIR: agentDir }, () => {
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined }, () => {
				const labels = readAppendSystemPromptFiles(project).map((file) => file.label);
				assert.deepEqual(labels, ["global APPEND_SYSTEM.md", "project .pi/APPEND_SYSTEM.md"]);
			});
			withEnv({ CLAUDE_BRIDGE_ISOLATED: "1" }, () => {
				const files = readAppendSystemPromptFiles(project);
				assert.deepEqual(files.map((file) => file.label), ["global APPEND_SYSTEM.md"]);
				assert.equal(files[0].content, "global extra");
			});
		});
	}));
});

describe("resolveClaudeExecutable isolation", () => {
	it("a configured path always wins", () => {
		withEnv({ CLAUDE_BRIDGE_ISOLATED: "1" }, () => {
			assert.equal(resolveClaudeExecutable("/opt/app/bin/claude"), "/opt/app/bin/claude");
		});
	});

	it("default mode falls back to $PATH; isolated mode never does", () => withTempDir((dir) => {
		const bin = join(dir, "bin");
		mkdirSync(bin, { recursive: true });
		const fakeClaude = join(bin, "claude");
		writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n");
		chmodSync(fakeClaude, 0o755);
		withEnv({ PATH: bin }, () => {
			withEnv({ CLAUDE_BRIDGE_ISOLATED: undefined }, () => {
				assert.equal(resolveClaudeExecutable(undefined), fakeClaude);
			});
			withEnv({ CLAUDE_BRIDGE_ISOLATED: "1" }, () => {
				assert.equal(resolveClaudeExecutable(undefined), undefined);
			});
		});
	}));
});
