/**
 * Session usage / cost / stats accounting, context-window usage, and session export.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Read-only over the session
 * except for its two owned memo caches (`_spawnedUsageCache`, `_dailyUsageCache`) — it never mutates
 * agent or session state. Single source of truth for "how much did this session and its spawned
 * subtree spend" (footer roll-up, print-mode child reporting), the daily cross-session totals, the
 * /context window estimate, and HTML/JSONL export of the current branch.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage, AgentState } from "@caupulican/pi-agent-core";
import {
	CURRENT_SESSION_VERSION,
	calculateContextTokens,
	estimateContextTokens,
	getLatestCompactionEntry,
	type SessionHeader,
	type SessionManager,
} from "@caupulican/pi-agent-core/node";
import type { AssistantMessage, Model, Usage } from "@caupulican/pi-ai";
import { getSessionsDir } from "../config.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import { resolvePath } from "../utils/paths.ts";
import {
	type SessionStats,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
	type SpawnedUsageTotals,
} from "./agent-session.ts";
import {
	aggregateDailyUsageFromSessionFiles,
	aggregateDailyUsageFromSessionRoot,
	type DailyUsageTotals,
	formatDailyUsageBreakdown,
	getLocalDayWindow,
} from "./cost/daily-usage.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import type { ContextUsage, ToolDefinition } from "./extensions/index.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface SessionAnalyticsDeps {
	/** Live agent state — assistant-message usage and message counts are read from here. */
	getState(): AgentState;
	/** All messages (agent state view) — used for context-window estimation and last-assistant text. */
	getMessages(): AgentMessage[];
	/** Current session model — its context window bounds the /context estimate. */
	getModel(): Model<any> | undefined;
	/** Session log — entries feed spawned-usage roll-up, daily totals, branch export. */
	getSessionManager(): SessionManager;
	/** Settings — the export theme is read here. */
	getSettingsManager(): SettingsManager;
	/** Resolve a tool definition for the HTML export's custom-tool renderer. */
	getToolDefinition(name: string): ToolDefinition | undefined;
}

export class SessionAnalytics {
	/** Memoized spawned-usage totals, keyed by session entry count (Bug #22: O(1) between turns). */
	private _spawnedUsageCache?: { entryCount: number; totals: SpawnedUsageTotals };
	/** Memoized daily usage totals with a short TTL, keyed by the resolved scope dir. */
	private _dailyUsageCache?: { sessionDir: string; expiresAt: number; totals: DailyUsageTotals };

	private readonly deps: SessionAnalyticsDeps;

	constructor(deps: SessionAnalyticsDeps) {
		this.deps = deps;
	}

	getSessionStats(): SessionStats {
		const state = this.deps.getState();
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		return {
			sessionFile: this.deps.getSessionManager().getSessionFile(),
			sessionId: this.deps.getSessionManager().getSessionId(),
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.getContextUsage(),
		};
	}

	/**
	 * Cumulative usage (full breakdown) for this session's entire spawn subtree: its own
	 * assistant messages PLUS every `spawned_usage` report it has rolled up. Single source of
	 * truth for "how much did this session and everything it spawned spend" — used by print-mode
	 * to emit a child's total so a spawner can roll it up via {@link addSpawnedUsage}.
	 *
	 * Including the `spawned_usage` reports is what keeps the single-hop invariant intact: a child
	 * that itself spawned grandchildren must report own + sub-usage in one number, or the parent
	 * silently under-counts the grandchildren.
	 */
	getCumulativeUsage(): Usage {
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;
		let costInput = 0;
		let costOutput = 0;
		let costCacheRead = 0;
		let costCacheWrite = 0;
		let costTotal = 0;
		const add = (usage: Usage) => {
			input += usage.input;
			output += usage.output;
			cacheRead += usage.cacheRead;
			cacheWrite += usage.cacheWrite;
			totalTokens += usage.totalTokens;
			costInput += usage.cost.input;
			costOutput += usage.cost.output;
			costCacheRead += usage.cost.cacheRead;
			costCacheWrite += usage.cost.cacheWrite;
			costTotal += usage.cost.total;
		};
		for (const message of this.deps.getState().messages) {
			if (message.role !== "assistant") continue;
			const usage = (message as AssistantMessage).usage;
			if (!usage) continue;
			add(usage);
		}
		// Roll up usage this session attributed to its own spawned children (single-hop).
		for (const entry of this.deps.getSessionManager().getEntries()) {
			if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE) continue;
			const data = entry.data as SpawnedUsageReport | undefined;
			if (data?.usage) add(data.usage);
		}
		return {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens,
			cost: {
				input: costInput,
				output: costOutput,
				cacheRead: costCacheRead,
				cacheWrite: costCacheWrite,
				total: costTotal,
			},
		};
	}

	/**
	 * Record usage spent by a spawned/subagent session so the footer can roll it into the
	 * displayed cost. Persisted as a `CustomEntry` (`customType: "spawned_usage"`, Model A) so
	 * it survives reload and is reconstructed exactly like main usage; a new/forked session
	 * starts fresh because it owns a new log file.
	 *
	 * Idempotent on `opts.reportId`: a re-report (retry, duplicate `agent_end`) with a
	 * previously-seen id is ignored, so cost cannot be double-counted. Honors the single-hop
	 * invariant documented on {@link SpawnedUsageReport}.
	 *
	 * @returns the id of the appended entry, or `undefined` if the report was a duplicate.
	 */
	addSpawnedUsage(
		usage: Usage,
		opts?: { label?: string; sourceSessionId?: string; reportId?: string },
	): string | undefined {
		const reportId = opts?.reportId;
		if (reportId) {
			for (const entry of this.deps.getSessionManager().getEntries()) {
				if (
					entry.type === "custom" &&
					entry.customType === SPAWNED_USAGE_CUSTOM_TYPE &&
					(entry.data as SpawnedUsageReport | undefined)?.reportId === reportId
				) {
					return undefined;
				}
			}
		}
		const report: SpawnedUsageReport = {
			usage,
			label: opts?.label,
			sourceSessionId: opts?.sourceSessionId,
			reportId,
		};
		return this.deps.getSessionManager().appendCustomEntry(SPAWNED_USAGE_CUSTOM_TYPE, report);
	}

	/**
	 * Aggregate all recorded spawned-usage reports (see {@link addSpawnedUsage}). Cached by the session
	 * entry count so the interactive footer (which calls this every render frame) is O(1) between turns
	 * instead of an O(N) scan on every keystroke (Bug #22). Recomputes only when entries change.
	 */
	getSpawnedUsage(): SpawnedUsageTotals {
		const sessionManager = this.deps.getSessionManager();
		const entryCount = sessionManager.getEntryCount?.() ?? sessionManager.getEntries().length;
		if (this._spawnedUsageCache?.entryCount === entryCount) return this._spawnedUsageCache.totals;
		let cost = 0;
		let reports = 0;
		for (const entry of sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE) continue;
			const data = entry.data as SpawnedUsageReport | undefined;
			if (!data?.usage) continue;
			cost += data.usage.cost.total;
			reports += 1;
		}
		const totals: SpawnedUsageTotals = { cost, reports };
		this._spawnedUsageCache = { entryCount, totals };
		return totals;
	}

	getDailyUsageTotals(now = new Date()): DailyUsageTotals {
		const sessionManager = this.deps.getSessionManager();
		const sessionDir = sessionManager.getSessionDir();
		const scope = sessionManager.usesDefaultSessionDir() ? getSessionsDir() : sessionDir;
		const nowMs = now.getTime();
		if (this._dailyUsageCache?.sessionDir === scope && this._dailyUsageCache.expiresAt > nowMs) {
			return this._dailyUsageCache.totals;
		}
		const window = getLocalDayWindow(now);
		const totals = sessionManager.usesDefaultSessionDir()
			? aggregateDailyUsageFromSessionRoot(scope, window)
			: aggregateDailyUsageFromSessionFiles(sessionDir, window);
		this._dailyUsageCache = { sessionDir: scope, expiresAt: nowMs + 10_000, totals };
		return totals;
	}

	getDailyUsageBreakdown(formatLabel?: (label: string) => string, now = new Date()): string {
		return formatDailyUsageBreakdown(this.getDailyUsageTotals(now), formatLabel);
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.deps.getModel();
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.deps.getSessionManager().getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.deps.getMessages());
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const sessionManager = this.deps.getSessionManager();
		const themeName = this.deps.getSettingsManager().getTheme();

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.deps.getToolDefinition(name),
			theme,
			cwd: sessionManager.getCwd(),
		});

		return await exportSessionToHtml(sessionManager, this.deps.getState(), {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const sessionManager = this.deps.getSessionManager();
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: sessionManager.getCwd(),
		};

		const branchEntries = sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.deps
			.getMessages()
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}
}
