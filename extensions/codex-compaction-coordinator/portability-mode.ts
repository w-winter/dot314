import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { PORTABLE_SUMMARY_CUSTOM_TYPE } from "./portable-record.ts";

export const PORTABILITY_MODE_CUSTOM_TYPE = "codex-compaction-coordinator:portability-mode";
export const PORTABILITY_COMMAND_USAGE = "Usage: /codex-portability lazy|prewarm|status";

export type PortabilityMode = "lazy" | "prewarm";
export type PortabilityCommand = PortabilityMode | "status";

export type PortabilityModeRecordV1 = {
    kind: typeof PORTABILITY_MODE_CUSTOM_TYPE;
    version: 1;
    mode: PortabilityMode;
};

export type ResolvedPortabilityMode = {
    mode: PortabilityMode;
    entryId: string | null;
};

export class MalformedPortabilityModeEntryError extends Error {
    readonly entryId: string;

    constructor(entryId: string) {
        super(`Portability mode entry ${entryId} is malformed`);
        this.name = "MalformedPortabilityModeEntryError";
        this.entryId = entryId;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actualKeys = Object.keys(value);
    return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function parsePortabilityModeRecord(value: unknown): PortabilityModeRecordV1 {
    if (
        !isRecord(value)
        || !hasExactKeys(value, ["kind", "version", "mode"])
        || value.kind !== PORTABILITY_MODE_CUSTOM_TYPE
        || value.version !== 1
        || (value.mode !== "lazy" && value.mode !== "prewarm")
    ) {
        throw new Error("Invalid portability mode record");
    }
    return {
        kind: PORTABILITY_MODE_CUSTOM_TYPE,
        version: 1,
        mode: value.mode,
    };
}

export function createPortabilityModeRecord(mode: PortabilityMode): PortabilityModeRecordV1 {
    return { kind: PORTABILITY_MODE_CUSTOM_TYPE, version: 1, mode };
}

export function isPortabilityModeEntry(entry: SessionEntry): boolean {
    return entry.type === "custom" && entry.customType === PORTABILITY_MODE_CUSTOM_TYPE;
}

export function isCoordinatorMetadataEntry(entry: SessionEntry): boolean {
    return entry.type === "custom"
        && (entry.customType === PORTABLE_SUMMARY_CUSTOM_TYPE || entry.customType === PORTABILITY_MODE_CUSTOM_TYPE);
}

export function resolveSessionPortabilityMode(entries: readonly SessionEntry[]): ResolvedPortabilityMode {
    const latest = [...entries].reverse().find(isPortabilityModeEntry);
    if (!latest || latest.type !== "custom") return { mode: "lazy", entryId: null };
    try {
        return { mode: parsePortabilityModeRecord(latest.data).mode, entryId: latest.id };
    } catch {
        throw new MalformedPortabilityModeEntryError(latest.id);
    }
}

export function parsePortabilityCommand(argumentsText: string): PortabilityCommand {
    const command = argumentsText.trim();
    if (command === "lazy" || command === "prewarm" || command === "status") return command;
    throw new Error(PORTABILITY_COMMAND_USAGE);
}
