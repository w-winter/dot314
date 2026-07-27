import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type TerminalListResponse = {
	result?: {
		terminals?: Array<{
			handle?: unknown;
			leafId?: unknown;
		}>;
	};
};

function leafIdFromPaneKey(paneKey: string): string {
	const separatorIndex = paneKey.indexOf(":");
	const leafId = paneKey.slice(separatorIndex + 1).trim();
	if (separatorIndex < 1 || !leafId) {
		throw new Error(`Invalid Orca pane key: ${paneKey}`);
	}
	return leafId;
}

function terminalHandleForLeaf(stdout: string, leafId: string): string {
	const response = JSON.parse(stdout) as TerminalListResponse;
	const terminal = response.result?.terminals?.find((candidate) => candidate.leafId === leafId);
	if (typeof terminal?.handle !== "string") {
		throw new Error(`Orca did not return a terminal for pane ${leafId}`);
	}
	return terminal.handle;
}

export default function (pi: ExtensionAPI): void {
	const paneKey = process.env.ORCA_PANE_KEY;
	if (!paneKey) return;
	const leafId = leafIdFromPaneKey(paneKey);

	async function renameTab(sessionName: string): Promise<void> {
		const listResult = await pi.exec("orca", ["terminal", "list", "--worktree", "active", "--json"], {
			timeout: 2_000,
		});
		if (listResult.code !== 0) {
			throw new Error(listResult.stderr.trim() || "Orca terminal list failed");
		}

		const terminalHandle = terminalHandleForLeaf(listResult.stdout, leafId);
		const renameResult = await pi.exec(
			"orca",
			["terminal", "rename", "--terminal", terminalHandle, "--title", sessionName, "--json"],
			{ timeout: 2_000 },
		);
		if (renameResult.code !== 0) {
			throw new Error(renameResult.stderr.trim() || "Orca terminal rename failed");
		}
	}

	async function syncTitle(sessionName: string | undefined, ctx: ExtensionContext): Promise<void> {
		const namedSession = sessionName?.trim();
		if (!namedSession) return;

		try {
			await renameTab(namedSession);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not rename Orca tab: ${message}`, "warning");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		await syncTitle(pi.getSessionName(), ctx);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		await syncTitle(event.name, ctx);
	});
}
