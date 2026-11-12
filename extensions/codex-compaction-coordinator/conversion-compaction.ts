import { createRequire } from "node:module";
import { join } from "node:path";

import {
    getAgentDir,
    type CompactionEntry,
    type ExtensionAPI,
    type ExtensionContext,
    type SessionBeforeCompactEvent,
    type SessionBeforeCompactResult,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";

type ConversionConfig = { compaction: { method: "pi" | "v2" | "both" } };
type Preparation = (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<SessionBeforeCompactResult | void>;

export interface ConversionCompaction {
    /** Cancels aborted attempts and method changes before summarization. */
    prepare: Preparation;
    /** Selects native summaries or encrypted-checkpoint conversion. Throws if the startup method changed. */
    delegates(event: SessionBeforeCompactEvent, ctx: ExtensionContext): boolean;
    dispose(): void;
}

/** Returns the loaded npm extension's startup compaction policy, or undefined when it is absent. */
export function loadConversionCompaction(pi: ExtensionAPI, ctx: ExtensionContext): ConversionCompaction | undefined {
    const command = pi.getCommands().find(({ sourceInfo }) =>
        /^npm:@howaboua\/pi-codex-conversion(?:@|$)/.test(sourceInfo.source));
    if (!command) return undefined;

    // Resolve helpers from the same package version as the loaded extension.
    const requireConversion = createRequire(command.sourceInfo.path);
    const configStore: {
        readEffectiveCodexConversionConfig(options: {
            cwd: string; projectTrusted: boolean; globalConfigPath: string;
        }): ConversionConfig;
    } = requireConversion("@howaboua/pi-codex-conversion/dist/adapter/activation/config-store.js");
    const runtimePlan: {
        resolveCodexRuntimePlanForState(context: Pick<ExtensionContext, "model">, state: {
            config: ConversionConfig; availableToolNames: string[];
        }): { nativeCompaction: boolean; nativeReplay: boolean };
    } = requireConversion("@howaboua/pi-codex-conversion/dist/adapter/activation/runtime-plan.js");
    const checkpoints: {
        resolveLatestNativeCompactionEntry(entries: readonly SessionEntry[]):
            | { ok: true; entry: CompactionEntry }
            | { ok: false };
    } = requireConversion("@howaboua/pi-codex-conversion/dist/adapter/compaction/details-store.js");
    const summaries: {
        hasPortableNativeCompactionSummary(entry: CompactionEntry): boolean;
    } = requireConversion("@howaboua/pi-codex-conversion/dist/adapter/compaction/types.js");
    const preparation: {
        registerCompactionPreparation(api: ExtensionAPI, handler: Preparation): {
            prepare: Preparation; dispose(): void;
        };
    } = requireConversion("@howaboua/pi-codex-conversion/dist/compaction.js");

    const readConfig = (context: ExtensionContext) => configStore.readEffectiveCodexConversionConfig({
        cwd: context.cwd,
        projectTrusted: context.isProjectTrusted(),
        globalConfigPath: join(getAgentDir(), "pi-codex-conversion.json"),
    });
    const config = readConfig(ctx);
    const assertMethodUnchanged = (context: ExtensionContext) => {
        if (readConfig(context).compaction.method !== config.compaction.method) {
            throw new Error("The Codex compaction method changed. Run /reload before compacting.");
        }
    };
    const registered = preparation.registerCompactionPreparation(pi, async (event, context) => {
        if (event.signal.aborted) return { cancel: true };
        try {
            assertMethodUnchanged(context);
        } catch (error) {
            if (context.hasUI) context.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return { cancel: true };
        }
    });

    return {
        ...registered,
        delegates(event, context) {
            assertMethodUnchanged(context);
            const plan = runtimePlan.resolveCodexRuntimePlanForState(context, {
                config,
                availableToolNames: pi.getAllTools().map(({ name }) => name),
            });
            if (plan.nativeCompaction) return true;
            if (!plan.nativeReplay) return false;
            const latest = checkpoints.resolveLatestNativeCompactionEntry(event.branchEntries);
            return latest.ok && !summaries.hasPortableNativeCompactionSummary(latest.entry);
        },
    };
}
