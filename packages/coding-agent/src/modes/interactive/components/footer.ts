import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { formatFooterCostParts } from "../../../core/cost/cost-summary.ts";
import { getFastModeStatus } from "../../../core/fast-mode.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

const FAST_MODE_BADGE = "[fast]";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Join footer chips with " | ", wrapping onto new lines when the width is too small. */
export function wrapPipeParts(parts: readonly string[], width: number): string[] {
	const lines: string[] = [];
	let current = "";
	for (const part of parts) {
		if (!part) continue;
		const next = current ? `${current} | ${part}` : part;
		if (visibleWidth(next) <= width) {
			current = next;
		} else {
			if (current) lines.push(current);
			if (visibleWidth(part) <= width) {
				current = part;
			} else {
				lines.push(truncateToWidth(part, width, "…"));
				current = "";
			}
		}
	}
	if (current) lines.push(current);
	return lines.length > 0 ? lines : [""];
}

function dimFooterLine(line: string, fastModeEnabled: boolean): string {
	if (!fastModeEnabled) return theme.fg("dim", line);
	const badgeIndex = line.indexOf(FAST_MODE_BADGE);
	if (badgeIndex === -1) return theme.fg("dim", line);
	return (
		theme.fg("dim", line.slice(0, badgeIndex)) +
		theme.bg("selectedBg", theme.bold(theme.fg("accent", FAST_MODE_BADGE))) +
		theme.fg("dim", line.slice(badgeIndex + FAST_MODE_BADGE.length))
	);
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizeLearningPhase(phase: string): string {
	const normalized = phase
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "")
		.trim();
	if (!normalized) return "active";
	if (normalized === "starting") return "start";
	if (normalized === "mapping") return "map";
	if (normalized === "scanning") return "scan";
	if (normalized === "auditing") return "audit";
	if (normalized === "learning") return "run";
	if (normalized === "pruning") return "prune";
	return normalized.slice(0, 16);
}

function formatExtensionStatuses(statuses: ReadonlyMap<string, string>): string[] {
	const regularStatuses: string[] = [];
	const learningPhases = new Set<string>();
	let sawLearningStatus = false;

	for (const [key, rawText] of Array.from(statuses.entries()).sort(([a], [b]) => a.localeCompare(b))) {
		if (key === "tps") continue;
		const text = sanitizeStatusText(rawText);
		const plain = stripAnsi(text).trim();
		const plainLower = plain.toLowerCase();
		let phase: string | undefined;

		if (plainLower.startsWith("(learning)")) {
			phase = plain.slice("(learning)".length).trim();
		} else if (plainLower === "learning") {
			phase = "active";
		} else if (/^learn(?:ing)?\s*[: ]/.test(plainLower)) {
			phase = plain.replace(/^learn(?:ing)?\s*[: ]/i, "").trim();
		}

		if (phase !== undefined) {
			sawLearningStatus = true;
			learningPhases.add(normalizeLearningPhase(phase));
			continue;
		}

		if (key === "auto-learn" || key === "continuous-learning") {
			sawLearningStatus = true;
			learningPhases.add("active");
			continue;
		}

		regularStatuses.push(text);
	}

	if (!sawLearningStatus) return regularStatuses;
	const phases = Array.from(learningPhases).filter((phase) => phase !== "active");
	const phaseText = phases.length > 0 ? phases.join("/") : "active";
	return [theme.fg("warning", "learn") + theme.fg("dim", `:${phaseText}`), ...regularStatuses];
}

/**
 * Format token counts for compact footer display.
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
type FooterUsageSnapshot = {
	entryCount: number;
	messageCount: number;
	totalInput: number;
	totalOutput: number;
	totalTokens: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	contextUsage: ReturnType<AgentSession["getContextUsage"]>;
};

export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private usageSnapshot?: FooterUsageSnapshot;
	private cumulativeUsage?: Omit<FooterUsageSnapshot, "messageCount" | "contextUsage">;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.usageSnapshot = undefined;
		this.cumulativeUsage = undefined;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * Invalidate cached footer stats when session state changes.
	 */
	invalidate(): void {
		this.usageSnapshot = undefined;
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	private getUsageSnapshot(messageCount: number): FooterUsageSnapshot {
		const sessionManager = this.session.sessionManager as AgentSession["sessionManager"] & {
			getEntryCount?: () => number;
		};
		const entryCount = sessionManager.getEntryCount?.() ?? sessionManager.getEntries().length;
		const cached = this.usageSnapshot;
		if (cached && cached.entryCount === entryCount && cached.messageCount === messageCount) {
			return cached;
		}

		// Session entries are append ordered. Reuse accumulated totals and process only the delta;
		// invalidating footer layout/context state must not force a full history scan.
		const previous = this.cumulativeUsage;
		const incrementalSessionManager = sessionManager as unknown as {
			getEntriesSince?: (startIndex: number) => ReturnType<typeof sessionManager.getEntries>;
		};
		const canExtend = previous !== undefined && entryCount >= previous.entryCount;
		let totalInput = canExtend ? previous.totalInput : 0;
		let totalOutput = canExtend ? previous.totalOutput : 0;
		let totalTokens = canExtend ? previous.totalTokens : 0;
		let totalCacheRead = canExtend ? previous.totalCacheRead : 0;
		let totalCacheWrite = canExtend ? previous.totalCacheWrite : 0;

		const entries =
			canExtend && incrementalSessionManager.getEntriesSince
				? incrementalSessionManager.getEntriesSince(previous.entryCount)
				: this.session.sessionManager.getEntries();
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const usage = entry.message.usage;
			if (!usage) continue;
			totalInput += usage.input;
			totalOutput += usage.output;
			totalTokens += usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			totalCacheRead += usage.cacheRead;
			totalCacheWrite += usage.cacheWrite;
		}

		this.cumulativeUsage = {
			entryCount,
			totalInput,
			totalOutput,
			totalTokens,
			totalCacheRead,
			totalCacheWrite,
		};
		const snapshot: FooterUsageSnapshot = {
			...this.cumulativeUsage,
			messageCount,
			// Calculate context usage from session (handles compaction correctly).
			// After compaction, tokens are unknown until the next LLM response.
			contextUsage: this.session.getContextUsage(),
		};
		this.usageSnapshot = snapshot;
		return snapshot;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const usageSnapshot = this.getUsageSnapshot(state.messages?.length ?? 0);
		const { totalInput, totalOutput, totalTokens, totalCacheRead, totalCacheWrite, contextUsage } = usageSnapshot;
		const costSummary = this.session.getCostSummary();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line
		const statsParts = [];
		if (totalInput) statsParts.push(`in ${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`out ${formatTokens(totalOutput)}`);
		const cacheTotal = totalCacheRead + totalCacheWrite;
		if (cacheTotal) statsParts.push(`cache ${formatTokens(cacheTotal)}`);
		if (totalTokens) statsParts.push(`toks ${formatTokens(totalTokens)}`);

		const usingSubscription = state.model ? this.session.modelRegistry.isUsingSubscription(state.model) : false;
		statsParts.push(...formatFooterCostParts(costSummary, 3, { subscription: usingSubscription }));

		// Keep the warning-only guard proactive without duplicating the authoritative
		// CURRENT/TODAY/SUBAGENTS totals rendered above.
		const costGuard = this.session.getLastCostGuardDecision?.();
		if (this.session.settingsManager.getCostGuardSettings().enabled && costGuard?.over) {
			statsParts.push(theme.fg("warning", `GUARD:$${costGuard.estUsd.toFixed(2)}/turn`));
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		const modelName = state.model?.name || state.model?.id || "no-model";
		const fastModeEnabled = getFastModeStatus(this.session).enabled;
		const modelDisplayName = fastModeEnabled ? `${modelName} ${FAST_MODE_BADGE}` : modelName;

		const extensionStatuses = this.footerData.getExtensionStatuses();
		const tpsStatus = sanitizeStatusText(extensionStatuses.get("tps") ?? "");
		const pipeParts = [...statsParts];
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			pipeParts.push(`(${state.model.provider})`);
		}
		pipeParts.push(modelDisplayName);
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			pipeParts.push(thinkingLevel === "off" ? "thinking off" : thinkingLevel);
		}
		if (tpsStatus) pipeParts.push(tpsStatus);
		const wrapped = wrapPipeParts(pipeParts, width);
		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, ...wrapped.map((line) => dimFooterLine(line, fastModeEnabled))];

		// Add extension statuses on a single line. Learning-related statuses are
		// folded into one compact chip so independent learning systems do not render
		// brittle duplicates like "(learning) (learning) auto".
		const autonomyStatus = this.footerData.getAutonomyStatus();

		const statusParts: string[] = [];
		if (autonomyStatus) {
			const sanitizedAutonomyStatus = sanitizeStatusText(autonomyStatus);
			if (sanitizedAutonomyStatus) {
				statusParts.push(sanitizedAutonomyStatus);
			}
		}
		if (extensionStatuses.size > 0) {
			const extLine = formatExtensionStatuses(extensionStatuses).join(" ");
			if (extLine) {
				statusParts.push(extLine);
			}
		}

		if (statusParts.length > 0) {
			const statusLine = statusParts.join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
