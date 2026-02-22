// config.ts - configuration loading for the repoprompt-cli extension

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RpCliConfig } from "./types.js";

const DEFAULT_CONFIG: Required<RpCliConfig> = {
    readcacheReadFile: false,
    autoSelectReadSlices: true,
};

const CONFIG_LOCATIONS = [
    () => path.join(os.homedir(), ".pi", "agent", "extensions", "repoprompt-cli", "config.json"),
];

function tryReadJson<T>(filePath: string): T | null {
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(content) as T;
    } catch {
        return null;
    }
}

export function loadConfig(overrides?: Partial<RpCliConfig>): Required<RpCliConfig> {
    let config: Required<RpCliConfig> = { ...DEFAULT_CONFIG };

    for (const getPath of CONFIG_LOCATIONS) {
        const candidate = getPath();
        if (!fs.existsSync(candidate)) {
            continue;
        }

        const fileConfig = tryReadJson<Partial<RpCliConfig>>(candidate);
        if (fileConfig) {
            config = { ...config, ...fileConfig };
            break;
        }
    }

    if (overrides) {
        config = { ...config, ...overrides };
    }

    return config;
}
