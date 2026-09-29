// The claude_bridge_incident tool: the agent lists the bridge's incidents,
// shows one, and files one when it judges it a bridge bug. Registered once at
// every extension load, with or without `incidents.repo`, so the tool list is
// the same for the whole process; only `file` needs the repo.
//
// Every copy of the bridge reads the process-global incident registry
// (incidents.ts), so a session's own copy answers for incidents the copy
// serving its requests recorded. `list` and `show` return the validated
// evidence an issue carries, never unvalidated text.

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MAX_SUMMARY_LENGTH, fileIncident, incidentDetails, incidentListLine } from "./incident-filer.js";
import { findIncident, listIncidents, type Incident } from "./incidents.js";

export const INCIDENT_TOOL = "claude_bridge_incident";
const LIST_LIMIT = 20;

const PARAMETERS = Type.Object({
	action: StringEnum(["list", "show", "file"] as const, {
		description: "list: the incidents recorded in this Pi process. show: one incident's evidence. file: file one as a GitHub issue, with your summary.",
	}),
	incident: Type.Optional(Type.String({ description: "The incident id, such as bi-7f3a, from a bridge error or notice, or from list. Required for show and file." })),
	summary: Type.Optional(Type.String({ description: `For file: what the bridge did and your analysis of it, at most ${MAX_SUMMARY_LENGTH} characters. Never prompts, file contents, user data or secrets.` })),
});

/** Incidents the agent may see: every one but expected cleanup. */
function reportable(): Incident[] {
	return listIncidents().filter((incident) => incident.class !== "expected");
}

function lookUp(id: string | undefined): Incident {
	if (!id) throw new Error("An incident id is required for show and file.");
	const incident = findIncident(id);
	if (!incident || incident.class === "expected") throw new Error(`Unknown incident ${id}: no incident with that id in this Pi process. Use ${INCIDENT_TOOL} list to see them.`);
	return incident;
}

function listText(): string {
	// Newest first: by last seen, the later recorded first among equals.
	const incidents = reportable().reverse().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
	if (incidents.length === 0) return "No Claude bridge incidents in this Pi process.";
	const shown = incidents.slice(0, LIST_LIMIT);
	return [
		`Claude bridge incidents in this Pi process, newest first (${incidents.length}):`,
		...shown.map(incidentListLine),
		...(incidents.length > shown.length ? [`… and ${incidents.length - shown.length} older incidents not shown.`] : []),
	].join("\n");
}

async function run(params: { action: string; incident?: string; summary?: string }): Promise<string> {
	switch (params.action) {
		case "list": return listText();
		case "show": return incidentDetails(lookUp(params.incident));
		case "file": return fileIncident(lookUp(params.incident), params.summary);
		default: throw new Error(`Unknown action ${String(params.action).slice(0, 20)}: use list, show or file.`);
	}
}

export function incidentTool(): ToolDefinition<typeof PARAMETERS> {
	return {
		name: INCIDENT_TOOL,
		label: "Claude bridge incident",
		description: "Inspect and file Claude bridge incidents only: anomalies the Pi Claude bridge recorded, each with an id such as bi-7f3a that appears in bridge error messages and notices. " +
			"list shows this process's incidents; show gives one incident's evidence. " +
			"File an incident (file, with a summary) when it looks like a bridge bug worth fixing; skip one-offs you can explain, such as a cancelled request. " +
			"The summary describes the bridge's behavior and your analysis of it, and never contains prompts, file contents, user data or secrets. " +
			"After filing, tell the user which issue you filed or commented on.",
		parameters: PARAMETERS,
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: await run(params) }], details: undefined };
		},
	};
}
