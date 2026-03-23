export type AnycopyEnterNavigationResult = "reopen" | "closed";

export type AnycopySummaryChoice = "No summary" | "Summarize" | "Summarize with custom prompt";

export type AnycopyEnterNavigationDeps = {
	entryId: string;
	effectiveLeafIdForNoop: string | null;
	skipSummaryPrompt: boolean;
	close: () => void;
	reopen: (options: { initialSelectedId: string }) => void;
	navigateTree: (
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string },
	) => Promise<{ cancelled: boolean; aborted?: boolean }>;
	ui: {
		select: (title: string, options: AnycopySummaryChoice[]) => Promise<AnycopySummaryChoice | undefined>;
		editor: (title: string) => Promise<string | undefined>;
		setStatus: (source: string, message: string) => void;
		setWorkingMessage: (message?: string) => void;
		notify: (message: string, level: "error") => void;
	};
};

export async function runAnycopyEnterNavigation(
	deps: AnycopyEnterNavigationDeps,
): Promise<AnycopyEnterNavigationResult> {
	const { entryId, effectiveLeafIdForNoop, skipSummaryPrompt, close, reopen, navigateTree, ui } = deps;

	if (effectiveLeafIdForNoop !== null && entryId === effectiveLeafIdForNoop) {
		close();
		ui.setStatus("anycopy", "Already at this point");
		return "closed";
	}

	close();

	let wantsSummary = false;
	let customInstructions: string | undefined;

	if (!skipSummaryPrompt) {
		while (true) {
			const choice = await ui.select("Summarize branch?", [
				"No summary",
				"Summarize",
				"Summarize with custom prompt",
			]);

			if (choice === undefined) {
				reopen({ initialSelectedId: entryId });
				return "reopen";
			}

			if (choice === "No summary") {
				wantsSummary = false;
				customInstructions = undefined;
				break;
			}

			if (choice === "Summarize") {
				wantsSummary = true;
				customInstructions = undefined;
				break;
			}

			customInstructions = await ui.editor("Custom summarization instructions");
			if (customInstructions === undefined) {
				continue;
			}

			wantsSummary = true;
			break;
		}
	}

	ui.setWorkingMessage("Navigating tree…");

	try {
		const result = await navigateTree(entryId, {
			summarize: wantsSummary,
			customInstructions,
		});

		if (result.cancelled) {
			if (wantsSummary) {
				ui.setStatus("anycopy", "Branch summarization cancelled");
				reopen({ initialSelectedId: entryId });
				return "reopen";
			}

			ui.setStatus("anycopy", "Navigation cancelled");
			return "closed";
		}

		return "closed";
	} catch (error) {
		ui.notify(error instanceof Error ? error.message : String(error), "error");
		return "closed";
	} finally {
		ui.setWorkingMessage();
	}
}
