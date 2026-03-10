import { resolve } from "node:path";

export function normalizeTargetCwd(
    rawTargetCwd: string,
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): string {
    let targetCwd = rawTargetCwd;
    if (/^~(?=$|\/)/.test(rawTargetCwd)) {
        const home = env.HOME || env.USERPROFILE;
        if (!home) {
            throw new Error("Cannot expand '~': $HOME is not set");
        }
        targetCwd = rawTargetCwd.replace(/^~(?=$|\/)/, home);
    }
    return resolve(cwd, targetCwd);
}
