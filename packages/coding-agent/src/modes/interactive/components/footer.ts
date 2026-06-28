import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";

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
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	/** Rolled-up cost of spawned/subagent sessions (Cost Aggregation). 0 when none. */
	totalSpawnedCost: number;
	contextUsage: ReturnType<AgentSession["getContextUsage"]>;
};

export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private usageSnapshot?: FooterUsageSnapshot;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		this.session = session;
		this.usageSnapshot = undefined;
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

		// Calculate cumulative usage from ALL session entries in one batched pass.
		// This avoids per-frame defensive array allocation when only the TUI redraws.
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		const entries = this.session.sessionManager.getEntries();
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const usage = entry.message.usage;
			if (!usage) continue;
			totalInput += usage.input;
			totalOutput += usage.output;
			totalCacheRead += usage.cacheRead;
			totalCacheWrite += usage.cacheWrite;
			totalCost += usage.cost.total;
		}

		// Roll up spawned/subagent cost (Cost Aggregation, Model A). Derived from the same
		// session entries, so the {entryCount} cache key above busts when new reports land.
		const totalSpawnedCost = this.session.getSpawnedUsage().cost;

		const snapshot: FooterUsageSnapshot = {
			entryCount,
			messageCount,
			totalInput,
			totalOutput,
			totalCacheRead,
			totalCacheWrite,
			totalCost,
			totalSpawnedCost,
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
		const { totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalCost, totalSpawnedCost, contextUsage } =
			usageSnapshot;
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
		if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
		if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
		if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
		if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

		// Show cost with "(sub)" indicator if using OAuth subscription
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totalCost || totalSpawnedCost || usingSubscription) {
			// Main cost, then the spawned/subagent roll-up: `$0.842 (sub) (+$0.310 sub)`.
			let costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			if (totalSpawnedCost) {
				costStr += ` (+$${totalSpawnedCost.toFixed(3)} sub)`;
			}
			statsParts.push(costStr);
		}

		// Proactive cost-guard warning (#34): when the projected per-turn cost crosses the ceiling,
		// surface a visible notice so an expensive turn never sneaks by. Warn-only — no silent action.
		const costGuard = this.session.getLastCostGuardDecision?.();
		if (costGuard?.over) {
			statsParts.push(theme.fg("warning", `⚠$${costGuard.estUsd.toFixed(2)}/turn`));
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

		let statsLeft = statsParts.join(" ");

		// Add model display name on the right side, plus thinking level if model supports it
		const modelName = state.model?.name || state.model?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// Too wide, fall back
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Add extension statuses on a single line. Learning-related statuses are
		// folded into one compact chip so independent learning systems do not render
		// brittle duplicates like "(learning) (learning) auto".
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const statusLine = formatExtensionStatuses(extensionStatuses).join(" ");
			if (statusLine) {
				// Truncate to terminal width with dim ellipsis for consistency with footer style
				lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
			}
		}

		return lines;
	}
}
