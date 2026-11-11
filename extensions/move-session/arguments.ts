export const FAMILY_FLAG = "--family";
export const MOVE_USAGE = "Usage: /move-session [--family] <targetCwd>";

interface MoveArguments {
    scope: "session" | "family";
    targetCwd: string;
}

export function parseMoveArguments(args: string): MoveArguments {
    const trimmed = args.trim();
    const family = /^--family(?:\s|$)/.test(trimmed);
    const targetCwd = family ? trimmed.slice(FAMILY_FLAG.length).trim() : trimmed;
    if (!targetCwd) throw new Error(MOVE_USAGE);
    if (targetCwd.startsWith("--")) throw new Error(`Unknown option: ${targetCwd.split(/\s/)[0]}. ${MOVE_USAGE}`);
    return { scope: family ? "family" : "session", targetCwd };
}
