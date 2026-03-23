import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@mariozechner/pi-coding-agent"
import { SessionManager } from "@mariozechner/pi-coding-agent"
import { Key, matchesKey } from "@mariozechner/pi-tui"

const TERMINAL_FLAG = "branch-terminal"
const STATUS_KEY = "branch-terminal"
const BRANCH_LAUNCH_CUSTOM_TYPE = "branch-terminal-launch"
const BRANCH_LAUNCH_APPLIED_CUSTOM_TYPE = "branch-terminal-launch-applied"
const AUTO_SUBMIT_SECONDS = 10
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"])

type ModelRef = {
	provider: string
	id: string
	name?: string
}

type ScopedModelCandidate = {
	model: ModelRef
	thinkingLevel?: string
}

type BranchLaunchData = {
	launchId: string
	message?: string
	autoSubmitSeconds: number
	modelNotice?: string
	targetModel?: ModelRef
}

type PendingAutoSubmit = {
	ctx: ExtensionContext
	sessionFile: string
	interval: ReturnType<typeof setInterval>
	unsubscribeInput: () => void
}

let pending: PendingAutoSubmit | undefined

function normalizeTerminalFlag(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

function renderTerminalCommand(template: string, sessionFile: string): string {
	if (template.includes("{session}")) {
		return template.split("{session}").join(sessionFile)
	}
	return `${template} ${sessionFile}`
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`
}

function spawnDetached(command: string, args: string[], onError?: (error: Error) => void): void {
	const child = spawn(command, args, { detached: true, stdio: "ignore" })
	child.unref()
	if (onError) child.on("error", onError)
}

function normalizeModelText(value: string): string {
	return value.trim().toLowerCase()
}

function collapseModelText(value: string): string {
	return normalizeModelText(value).replace(/[^a-z0-9]+/g, "")
}

function expandUserPath(p: string): string {
	if (p === "~") return os.homedir()
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
	return p
}

function splitPatternThinkingLevel(pattern: string): { pattern: string; thinkingLevel?: string } {
	const lastColonIndex = pattern.lastIndexOf(":")
	if (lastColonIndex === -1) return { pattern }

	const suffix = pattern.slice(lastColonIndex + 1).trim().toLowerCase()
	if (!THINKING_LEVELS.has(suffix)) return { pattern }

	return {
		pattern: pattern.slice(0, lastColonIndex),
		thinkingLevel: suffix,
	}
}

function matchesGlob(pattern: string, value: string): boolean {
	const escaped = pattern
		.replace(/[.+^${}()|\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".")
	return new RegExp(`^${escaped}$`, "i").test(value)
}

function loadEnabledModelPatterns(cwd: string): string[] | undefined {
	const agentDir = process.env.PI_CODING_AGENT_DIR
		? expandUserPath(process.env.PI_CODING_AGENT_DIR)
		: path.join(os.homedir(), ".pi", "agent")
	const globalSettingsPath = path.join(agentDir, "settings.json")
	const projectSettingsPath = path.join(cwd, ".pi", "settings.json")

	const readEnabledModels = (settingsPath: string): string[] | undefined => {
		try {
			const raw = fs.readFileSync(settingsPath, "utf8")
			const parsed = JSON.parse(raw)
			return Array.isArray(parsed?.enabledModels)
				? parsed.enabledModels.filter((value: unknown): value is string => typeof value === "string")
				: undefined
		} catch {
			return undefined
		}
	}

	const globalModels = readEnabledModels(globalSettingsPath)
	const projectModels = readEnabledModels(projectSettingsPath)
	return projectModels ?? globalModels
}

function scoreModelCandidate(
	query: string,
	candidate: ScopedModelCandidate,
	options?: { preferredProvider?: string },
): number {
	const normalizedQuery = normalizeModelText(query)
	if (!normalizedQuery) return 0

	const fullId = normalizeModelText(`${candidate.model.provider}/${candidate.model.id}`)
	const id = normalizeModelText(candidate.model.id)
	const name = normalizeModelText(candidate.model.name ?? "")
	const providerBonus = options?.preferredProvider
		&& normalizeModelText(candidate.model.provider) === normalizeModelText(options.preferredProvider)
		? 750
		: 0

	if (fullId === normalizedQuery) return 12000 + providerBonus
	if (id === normalizedQuery) return 11500 + providerBonus
	if (fullId.endsWith(`/${normalizedQuery}`)) return 11000 + providerBonus
	if (id.startsWith(normalizedQuery)) return 10000 - (id.length - normalizedQuery.length) + providerBonus
	if (fullId.startsWith(normalizedQuery)) return 9500 - (fullId.length - normalizedQuery.length) + providerBonus

	const idIndex = id.indexOf(normalizedQuery)
	if (idIndex !== -1) return 9000 - idIndex * 10 - (id.length - normalizedQuery.length) + providerBonus

	const fullIdIndex = fullId.indexOf(normalizedQuery)
	if (fullIdIndex !== -1) {
		return 8000 - fullIdIndex * 10 - (fullId.length - normalizedQuery.length) + providerBonus
	}

	const nameIndex = name.indexOf(normalizedQuery)
	if (nameIndex !== -1) return 7000 - nameIndex * 10 - (name.length - normalizedQuery.length) + providerBonus

	const collapsedQuery = collapseModelText(query)
	if (!collapsedQuery) return 0

	const collapsedId = collapseModelText(candidate.model.id)
	const collapsedFullId = collapseModelText(`${candidate.model.provider}/${candidate.model.id}`)
	const collapsedName = collapseModelText(candidate.model.name ?? "")

	if (collapsedId === collapsedQuery) return 6500 + providerBonus
	if (collapsedFullId === collapsedQuery) return 6250 + providerBonus
	if (collapsedId.startsWith(collapsedQuery)) {
		return 6000 - (collapsedId.length - collapsedQuery.length) + providerBonus
	}
	if (collapsedFullId.startsWith(collapsedQuery)) {
		return 5500 - (collapsedFullId.length - collapsedQuery.length) + providerBonus
	}

	const collapsedIdIndex = collapsedId.indexOf(collapsedQuery)
	if (collapsedIdIndex !== -1) {
		return 5000 - collapsedIdIndex * 10 - (collapsedId.length - collapsedQuery.length) + providerBonus
	}

	const collapsedFullIdIndex = collapsedFullId.indexOf(collapsedQuery)
	if (collapsedFullIdIndex !== -1) {
		return 4500 - collapsedFullIdIndex * 10 - (collapsedFullId.length - collapsedQuery.length) + providerBonus
	}

	const collapsedNameIndex = collapsedName.indexOf(collapsedQuery)
	if (collapsedNameIndex !== -1) {
		return 4000 - collapsedNameIndex * 10 - (collapsedName.length - collapsedQuery.length) + providerBonus
	}

	return 0
}

function resolveClosestModelCandidate(
	modelQuery: string,
	candidates: ScopedModelCandidate[],
	options?: { preferredProvider?: string },
): ScopedModelCandidate | undefined {
	const normalizedQuery = normalizeModelText(modelQuery)
	if (!normalizedQuery) return undefined

	const slashIndex = normalizedQuery.indexOf("/")
	const providerQuery = slashIndex > 0 ? normalizedQuery.slice(0, slashIndex) : undefined
	const idQuery = slashIndex > 0 ? normalizedQuery.slice(slashIndex + 1) : normalizedQuery

	const searchSpace = providerQuery
		? candidates.filter((candidate) => normalizeModelText(candidate.model.provider) === providerQuery)
		: candidates
	if (searchSpace.length === 0) return undefined

	return searchSpace
		.map((candidate) => ({
			candidate,
			score: Math.max(
				scoreModelCandidate(normalizedQuery, candidate, options),
				providerQuery ? scoreModelCandidate(idQuery, candidate, options) + 50 : 0,
			),
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => (
			b.score - a.score
			|| a.candidate.model.id.length - b.candidate.model.id.length
			|| `${a.candidate.model.provider}/${a.candidate.model.id}`.localeCompare(
				`${b.candidate.model.provider}/${b.candidate.model.id}`,
			)
		))[0]?.candidate
}

function resolveScopedCandidatesFromSettings(ctx: ExtensionContext): ScopedModelCandidate[] {
	const patterns = loadEnabledModelPatterns(ctx.cwd)
	if (!patterns || patterns.length === 0) return []

	const availableModels = ctx.modelRegistry.getAvailable().map((model: any) => ({
		model: {
			provider: model.provider,
			id: model.id,
			name: model.name,
		},
	}))
	const preferredProvider = ctx.model?.provider
	const resolved: ScopedModelCandidate[] = []
	const seen = new Set<string>()

	const addCandidate = (candidate: ScopedModelCandidate) => {
		const key = `${candidate.model.provider}/${candidate.model.id}`
		if (seen.has(key)) return
		seen.add(key)
		resolved.push(candidate)
	}

	for (const rawPattern of patterns) {
		const { pattern, thinkingLevel } = splitPatternThinkingLevel(rawPattern.trim())
		if (!pattern) continue

		if (pattern.includes("*") || pattern.includes("?")) {
			for (const candidate of availableModels) {
				const fullId = `${candidate.model.provider}/${candidate.model.id}`
				if (matchesGlob(pattern, fullId) || matchesGlob(pattern, candidate.model.id)) {
					addCandidate({ model: candidate.model, thinkingLevel })
				}
			}
			continue
		}

		const match = resolveClosestModelCandidate(pattern, availableModels, { preferredProvider })
		if (match) {
			addCandidate({ model: match.model, thinkingLevel })
		}
	}

	return resolved
}

function getModelCandidates(ctx: ExtensionContext): ScopedModelCandidate[] {
	const settingsScopedModels = resolveScopedCandidatesFromSettings(ctx)
	if (settingsScopedModels.length > 0) return settingsScopedModels

	if (ctx.model) {
		return ctx.modelRegistry.getAvailable()
			.filter((model: any) => model.provider === ctx.model?.provider)
			.map((model: any) => ({
				model: {
					provider: model.provider,
					id: model.id,
					name: model.name,
				},
			}))
	}

	return []
}

function parseBranchArgs(rawArgs: string): { modelQuery?: string; message: string } {
	let remaining = rawArgs.trim()
	let modelQuery: string | undefined

	const modelMatch = remaining.match(/^--model\s+(\S+)(?:\s+|$)/)
	if (modelMatch) {
		modelQuery = modelMatch[1]
		remaining = remaining.slice(modelMatch[0].length).trimStart()
	}

	return { modelQuery, message: remaining }
}

function isEditableInput(data: string): boolean {
	if (!data) return false

	if (data.length === 1) {
		const charCode = data.charCodeAt(0)
		if (charCode >= 32 && charCode !== 127) return true
		if (charCode === 8 || charCode === 13) return true
	}

	if (data === "\n" || data === "\r" || data === "\x7f") return true
	if (data.length > 1 && !data.startsWith("\x1b")) return true
	return false
}

function getStatusLine(ctx: ExtensionContext, seconds: number): string {
	const accent = ctx.ui.theme.fg("accent", `branch auto-submit in ${seconds}s`)
	const hint = ctx.ui.theme.fg("dim", "(type or Esc to cancel)")
	return `${accent} ${hint}`
}

function clearPending(ctx?: ExtensionContext, notice?: string): void {
	if (!pending) return
	clearInterval(pending.interval)
	pending.unsubscribeInput()
	pending.ctx.ui.setStatus(STATUS_KEY, undefined)
	const active = pending
	pending = undefined
	if (ctx && notice) {
		ctx.ui.notify(notice, "info")
	} else if (!ctx && notice) {
		active.ctx.ui.notify(notice, "info")
	}
}

function autoSubmitDraft(pi: ExtensionAPI): void {
	if (!pending) return

	const active = pending
	const currentSession = active.ctx.sessionManager.getSessionFile()
	if (!currentSession || currentSession !== active.sessionFile) {
		clearPending(undefined)
		return
	}

	const draft = active.ctx.ui.getEditorText().trim()
	clearPending(undefined)
	if (!draft) {
		active.ctx.ui.notify("Draft is empty", "warning")
		return
	}

	active.ctx.ui.setEditorText("")
	try {
		if (active.ctx.isIdle()) {
			pi.sendUserMessage(draft)
		} else {
			pi.sendUserMessage(draft, { deliverAs: "followUp" })
		}
	} catch {
		pi.sendUserMessage(draft)
	}
}

function startCountdown(pi: ExtensionAPI, ctx: ExtensionContext, secondsTotal: number): void {
	clearPending(ctx)

	const sessionFile = ctx.sessionManager.getSessionFile()
	if (!sessionFile) {
		ctx.ui.notify("Auto-submit disabled: could not determine session identity", "warning")
		return
	}

	let secondsRemaining = secondsTotal
	ctx.ui.setStatus(STATUS_KEY, getStatusLine(ctx, secondsRemaining))

	const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
		if (matchesKey(data, Key.escape)) {
			clearPending(ctx, "Auto-submit cancelled")
			return { consume: true }
		}

		if (data === "\r" || data === "\n" || data === "\r\n") {
			clearPending(ctx)
			return undefined
		}

		if (isEditableInput(data)) {
			clearPending(ctx, "Auto-submit cancelled")
		}

		return undefined
	})

	const interval = setInterval(() => {
		if (!pending) return

		secondsRemaining -= 1
		if (secondsRemaining <= 0) {
			autoSubmitDraft(pi)
			return
		}

		ctx.ui.setStatus(STATUS_KEY, getStatusLine(ctx, secondsRemaining))
	}, 1000)

	pending = {
		ctx,
		sessionFile,
		interval,
		unsubscribeInput,
	}
}

function readBranchLaunchData(entries: SessionEntry[]): BranchLaunchData | undefined {
	let latestLaunch: BranchLaunchData | undefined
	const applied = new Set<string>()

	for (const entry of entries) {
		if (entry.type !== "custom") continue
		if (entry.customType === BRANCH_LAUNCH_APPLIED_CUSTOM_TYPE) {
			const launchId = typeof entry.data === "object" && entry.data && "launchId" in entry.data
				? (entry.data as any).launchId
				: undefined
			if (typeof launchId === "string" && launchId) applied.add(launchId)
			continue
		}
		if (entry.customType !== BRANCH_LAUNCH_CUSTOM_TYPE) continue
		const data = entry.data
		if (!data || typeof data !== "object") continue
		const launchId = typeof (data as any).launchId === "string" ? (data as any).launchId : undefined
		if (!launchId) continue
		latestLaunch = data as BranchLaunchData
	}

	if (!latestLaunch) return undefined
	return applied.has(latestLaunch.launchId) ? undefined : latestLaunch
}

async function isMacAppAvailable(pi: ExtensionAPI, appName: string): Promise<boolean> {
	const result = await pi.exec("open", ["-Ra", appName])
	return result.code === 0
}

async function openInITerm(pi: ExtensionAPI, forkFile: string): Promise<{ opened: boolean; error?: string }> {
	if (process.platform !== "darwin") return { opened: false }

	const appCandidates = ["iTerm2", "iTerm"]
	const availableApp = (
		await (async () => {
			for (const candidate of appCandidates) {
				if (await isMacAppAvailable(pi, candidate)) return candidate
			}
			return undefined
		})()
	)

	if (!availableApp) return { opened: false }

	const command = `pi --session ${shellQuote(forkFile)}`
	const scriptLines = [
		`tell application "${availableApp}"`,
		"activate",
		"if (count of windows) is 0 then",
		"create window with default profile",
		"else",
		"tell current window to create tab with default profile",
		"end if",
		"tell current session of current window",
		`write text ${JSON.stringify(command)}`,
		"end tell",
		"end tell",
	]

	const osascriptArgs = scriptLines.flatMap((line) => ["-e", line])
	const result = await pi.exec("osascript", osascriptArgs)
	if (result.code !== 0) {
		return { opened: false, error: result.stderr || result.stdout || "osascript failed" }
	}

	return { opened: true }
}

async function openInMacOSTerminal(
	pi: ExtensionAPI,
	forkFile: string,
): Promise<{ opened: boolean; error?: string }> {
	if (process.platform !== "darwin") return { opened: false }
	if (!(await isMacAppAvailable(pi, "Terminal"))) return { opened: false }

	const command = `pi --session ${shellQuote(forkFile)}`
	const scriptLines = [
		'tell application "Terminal"',
		"activate",
		"if (count of windows) is 0 then",
		`do script ${JSON.stringify(command)}`,
		"else",
		`do script ${JSON.stringify(command)} in front window`,
		"end if",
		"end tell",
	]

	const osascriptArgs = scriptLines.flatMap((line) => ["-e", line])
	const result = await pi.exec("osascript", osascriptArgs)
	if (result.code !== 0) {
		return { opened: false, error: result.stderr || result.stdout || "osascript failed" }
	}

	return { opened: true }
}

async function openForkInTerminal(pi: ExtensionAPI, ctx: ExtensionCommandContext, forkFile: string): Promise<void> {
	const terminalFlag = normalizeTerminalFlag(pi.getFlag(`--${TERMINAL_FLAG}`))
	if (terminalFlag) {
		const command = renderTerminalCommand(terminalFlag, forkFile)
		spawnDetached("bash", ["-lc", command], (error) => {
			if (ctx.hasUI) ctx.ui.notify(`Terminal command failed: ${error.message}`, "error")
		})
		return
	}

	if (process.env.TMUX) {
		const result = await pi.exec("tmux", ["new-window", "-n", "branch", "pi", "--session", forkFile])
		if (result.code !== 0) {
			throw new Error(result.stderr || result.stdout || "tmux new-window failed")
		}
		return
	}

	if (process.platform === "darwin") {
		const iTermAttempt = await openInITerm(pi, forkFile)
		if (iTermAttempt.opened) return
		if (iTermAttempt.error && ctx.hasUI) ctx.ui.notify(`iTerm failed to open: ${iTermAttempt.error}`, "warning")

		const terminalAttempt = await openInMacOSTerminal(pi, forkFile)
		if (terminalAttempt.opened) return
		if (terminalAttempt.error && ctx.hasUI) {
			ctx.ui.notify(`macOS Terminal failed to open: ${terminalAttempt.error}`, "warning")
		}
	}

	spawnDetached("alacritty", ["-e", "pi", "--session", forkFile], (error) => {
		if (ctx.hasUI) {
			ctx.ui.notify(`Alacritty failed to open: ${error.message}`, "warning")
			ctx.ui.notify(`Run: pi --session ${forkFile}`, "info")
		}
	})
}

async function applyPendingBranchLaunch(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const launch = readBranchLaunchData(ctx.sessionManager.getBranch())
	if (!launch) return

	pi.appendEntry(BRANCH_LAUNCH_APPLIED_CUSTOM_TYPE, { launchId: launch.launchId })

	if (launch.targetModel) {
		const match = typeof ctx.modelRegistry.find === "function"
			? ctx.modelRegistry.find(launch.targetModel.provider, launch.targetModel.id)
			: ctx.modelRegistry.getAvailable().find(
				(model: any) => model.provider === launch.targetModel?.provider && model.id === launch.targetModel?.id,
			)
		if (match && (!ctx.model || ctx.model.provider !== match.provider || ctx.model.id !== match.id)) {
			const switched = await pi.setModel(match)
			if (!switched && ctx.hasUI) {
				ctx.ui.notify(`Could not switch branch model to ${match.provider}/${match.id}`, "warning")
			}
		}
	}

	if (ctx.hasUI && launch.modelNotice) {
		ctx.ui.notify(launch.modelNotice, launch.targetModel ? "info" : "warning")
	}

	const message = launch.message?.trim()
	if (!ctx.hasUI || !message) return

	ctx.ui.setEditorText(message)
	if (launch.autoSubmitSeconds > 0) {
		startCountdown(pi, ctx, launch.autoSubmitSeconds)
	} else {
		ctx.ui.notify("Draft ready in editor (auto-submit disabled)", "info")
	}
}

function resolveBranchModel(
	ctx: ExtensionContext,
	modelQuery: string | undefined,
): { targetModel?: ModelRef; notice?: string } {
	const currentModel = ctx.model
		? {
			provider: ctx.model.provider,
			id: ctx.model.id,
			name: ctx.model.name,
		}
		: undefined

	if (!currentModel) {
		return modelQuery
			? { notice: `Model '${modelQuery}' did not resolve; branch will use the session model.` }
			: {}
	}

	if (!modelQuery) {
		return { targetModel: currentModel }
	}

	const match = resolveClosestModelCandidate(modelQuery, getModelCandidates(ctx), {
		preferredProvider: ctx.model.provider,
	})
	if (!match) {
		return {
			targetModel: currentModel,
			notice: `Model '${modelQuery}' did not resolve safely; using ${ctx.model.provider}/${ctx.model.id}`,
		}
	}

	return {
		targetModel: match.model,
		notice: `Branch model: ${match.model.provider}/${match.model.id}`,
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag(TERMINAL_FLAG, {
		description: "Command to open a new terminal. Use {session} placeholder for the session file path.",
		type: "string",
	})

	for (const eventName of [
		"session_before_switch",
		"session_switch",
		"session_before_fork",
		"session_fork",
		"session_before_tree",
		"session_tree",
		"session_shutdown",
	] as const) {
		pi.on(eventName as any, (_event: any, eventCtx: any) => {
			if (pending) clearPending(eventCtx)
		})
	}

	pi.on("session_start", async (_event, ctx) => {
		await applyPendingBranchLaunch(pi, ctx)
	})

	pi.registerCommand("branch", {
		description: "Fork current session into a new terminal, optionally queueing --model <query> and a draft message",
		handler: async (args, ctx) => {
			await ctx.waitForIdle()

			const sessionFile = ctx.sessionManager.getSessionFile()
			if (!sessionFile) {
				if (ctx.hasUI) ctx.ui.notify("Session is not persisted. Restart without --no-session.", "error")
				return
			}

			const leafId = ctx.sessionManager.getLeafId()
			if (!leafId) {
				if (ctx.hasUI) ctx.ui.notify("No messages yet. Nothing to branch.", "error")
				return
			}

			const { modelQuery, message } = parseBranchArgs(args)
			const forkManager = SessionManager.open(sessionFile)
			const forkFile = forkManager.createBranchedSession(leafId)
			if (!forkFile) {
				throw new Error("Failed to create branched session")
			}

			const trimmedMessage = message.trim()
			const hasLaunchCustomization = Boolean(modelQuery || trimmedMessage)
			let launchData: BranchLaunchData | undefined

			if (hasLaunchCustomization) {
				const launchSession = SessionManager.open(forkFile)
				const modelResolution = resolveBranchModel(ctx, modelQuery)
				launchData = {
					launchId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					message: trimmedMessage || undefined,
					autoSubmitSeconds: AUTO_SUBMIT_SECONDS,
					modelNotice: modelResolution.notice,
					targetModel: modelResolution.targetModel,
				}
				launchSession.appendCustomEntry(BRANCH_LAUNCH_CUSTOM_TYPE, launchData)
			}

			await openForkInTerminal(pi, ctx, forkFile)

			if (ctx.hasUI) {
				if (!launchData) {
					ctx.ui.notify("Opened fork in new terminal", "info")
					return
				}

				const details = [
					launchData.targetModel
						? `${launchData.targetModel.provider}/${launchData.targetModel.id}`
						: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					launchData.message ? "draft queued" : undefined,
				].filter(Boolean).join(" · ")
				ctx.ui.notify(details ? `Opened fork in new terminal (${details})` : "Opened fork in new terminal", "info")
			}
		},
	})
}
