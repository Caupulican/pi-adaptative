/**
 * Session usage / cost / stats accounting, context-window usage, and session export.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Read-only over the session
 * except for its two owned memo caches (`_spawnedUsageCache`, `_dailyUsageCache`) — it never mutates
 * agent or session state. Single source of truth for "how much did this session and its spawned
 * subtree spend" (footer roll-up, print-mode child reporting), the daily cross-session totals, the
 * /context window estimate, and HTML/JSONL export of the current branch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage, AgentState } from "@caupulican/pi-agent-core";
import {
	CURRENT_SESSION_VERSION,
	calculateContextTokens,
	estimateContextTokens,
	getLatestCompactionEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionManager,
} from "@caupulican/pi-agent-core/node";
import type {
	AssistantMessage,
	Model,
	ToolArgumentExecutionOutcome,
	ToolArgumentTeachState,
	ToolArgumentValidationTelemetryEvent,
	Usage,
} from "@caupulican/pi-ai";
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
	accumulateCurrentSessionCostsFromEntries,
	type CurrentSessionCostAccumulator,
	createCurrentSessionCostAccumulator,
	createSessionCostSummary,
	type SessionCostSummary,
} from "./cost/cost-summary.ts";
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
import {
	isToolArgumentValidationLogRecord,
	type ToolArgumentValidationLogRecord,
} from "./tool-recovery-log-records.ts";
import {
	consumeToolArgumentValidationRecord,
	createEmptyToolArgumentValidationStats,
	getToolRecoveryRecordSequence,
	readPersistedToolRecoveryStats,
} from "./tool-recovery-stats.ts";

export const TOOL_ARGUMENT_VALIDATION_CUSTOM_TYPE = "tool_argument_validation";

export interface ToolArgumentValidationTeachEfficacy {
	recurrenceBefore: number;
	recurrenceAfter: number;
	repairedThenSucceeded: number;
	repairedThenFailed: number;
	repairedThenNotRun: number;
}

export interface ToolArgumentValidationStats {
	clean: number;
	repaired: number;
	bounced: number;
	failureModes: Record<string, number>;
	repairsApplied: Record<string, number>;
	taught: Record<ToolArgumentTeachState, number>;
	executionOutcome: Record<ToolArgumentExecutionOutcome, number>;
	teachEfficacy: Record<string, ToolArgumentValidationTeachEfficacy>;
}

export interface ToolArgumentValidationRecord extends ToolArgumentValidationTelemetryEvent {
	version: 1;
}

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
	/** Sidecar recovery telemetry log; read on demand so turn handling never writes session custom entries. */
	getToolRecoveryEventLogPath(): string;
}

export class SessionAnalytics {
	/** Incremental aggregate over append-ordered session entries. */
	private _currentSessionCostCache?: {
		entryCount: number;
		accumulator: CurrentSessionCostAccumulator;
	};
	/** Memoized daily usage totals with a short TTL, keyed by the resolved scope dir and local-day window. */
	private _dailyUsageCache?: {
		sessionDir: string;
		windowStartMs: number;
		windowEndMs: number;
		expiresAt: number;
		totals: DailyUsageTotals;
	};
	/** Memoized full cost summary. The footer renders on every streamed delta and keystroke, so
	 * rescanning a long session log there turns redraw into O(entries) work per frame. */
	private _costSummaryCache?: {
		entryCount: number;
		dailyTotals: DailyUsageTotals;
		windowStartMs: number;
		windowEndMs: number;
		summary: SessionCostSummary;
	};
	/** Cumulative stats initialized once from persisted telemetry, then updated without retaining record details. */
	private _toolArgumentValidationStats: ToolArgumentValidationStats | undefined;
	/** Incremental context-usage state keyed by the append-only branch leaf. */
	private _postCompactionUsageCache?: {
		leafId: string | null;
		hasCompaction: boolean;
		hasPostCompactionUsage: boolean;
	};

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

		const toolArgumentValidation = this.getToolArgumentValidationStats();
		const compactionGates = this.getCompactionGateStats();

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
			toolArgumentValidation,
			compactionGates,
		};
	}

	getCompactionGateStats(): SessionStats["compactionGates"] {
		let gateFailures = 0;
		let deterministicGapFills = 0;
		let compactionsWithGateFailures = 0;
		for (const entry of this.deps.getSessionManager().getEntries()) {
			if (entry.type !== "compaction") continue;
			const details = entry.details;
			if (!details || typeof details !== "object") continue;
			const rawGateFailures = (details as { verificationGateFailures?: unknown }).verificationGateFailures;
			const rawGapFills = (details as { deterministicGapFills?: unknown }).deterministicGapFills;
			const entryGateFailures =
				typeof rawGateFailures === "number" && Number.isFinite(rawGateFailures) ? rawGateFailures : 0;
			const entryGapFills = typeof rawGapFills === "number" && Number.isFinite(rawGapFills) ? rawGapFills : 0;
			gateFailures += entryGateFailures;
			deterministicGapFills += entryGapFills;
			if (entryGateFailures > 0) compactionsWithGateFailures++;
		}
		return { gateFailures, deterministicGapFills, compactionsWithGateFailures };
	}

	recordToolArgumentValidation(record: ToolArgumentValidationLogRecord): void {
		const stats = this.getToolArgumentValidationStats();
		consumeToolArgumentValidationRecord(stats, record);
		this._toolArgumentValidationStats = stats;
	}

	private readToolArgumentValidationSidecarRecords(): ToolArgumentValidationLogRecord[] {
		const filePath = this.deps.getToolRecoveryEventLogPath();
		if (!existsSync(filePath)) return [];
		const records: ToolArgumentValidationLogRecord[] = [];
		try {
			const sessionId = this.deps.getSessionManager().getSessionId();
			for (const line of readFileSync(filePath, "utf-8").split("\n")) {
				if (line.trim().length === 0) continue;
				const parsed = JSON.parse(line) as unknown;
				if (!isToolArgumentValidationLogRecord(parsed) || parsed.sessionId !== sessionId) continue;
				records.push(parsed);
			}
		} catch {
			return [];
		}
		return records;
	}

	getToolArgumentValidationStats(): ToolArgumentValidationStats {
		if (this._toolArgumentValidationStats) return structuredClone(this._toolArgumentValidationStats);
		const eventLogPath = this.deps.getToolRecoveryEventLogPath();
		const sessionId = this.deps.getSessionManager().getSessionId();
		const persisted = readPersistedToolRecoveryStats(eventLogPath, sessionId);
		const stats = persisted ? structuredClone(persisted.stats) : createEmptyToolArgumentValidationStats();
		const seen = new Set<string>();
		const consume = (record: ToolArgumentValidationRecord, key: string): void => {
			if (seen.has(key)) return;
			seen.add(key);
			consumeToolArgumentValidationRecord(stats, record);
		};

		for (const entry of this.deps.getSessionManager().getEntries()) {
			if (entry.type !== "custom" || entry.customType !== TOOL_ARGUMENT_VALIDATION_CUSTOM_TYPE) continue;
			const record = entry.data as ToolArgumentValidationRecord | undefined;
			if (!record || record.version !== 1) continue;
			consume(record, `legacy:${entry.id}`);
		}
		for (const record of this.readToolArgumentValidationSidecarRecords()) {
			if (
				persisted &&
				record.sessionId === sessionId &&
				getToolRecoveryRecordSequence(record) <= persisted.lastRecordSequence
			) {
				continue;
			}
			consume(record, record.recordId);
		}

		this._toolArgumentValidationStats = stats;
		return structuredClone(stats);
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
		const seenSpawnedReportIds = new Set<string>();
		for (const entry of this.deps.getSessionManager().getEntries()) {
			if (entry.type !== "custom" || entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE) continue;
			const data = entry.data as SpawnedUsageReport | undefined;
			if (!data?.usage) continue;
			if (data.reportId) {
				if (seenSpawnedReportIds.has(data.reportId)) continue;
				seenSpawnedReportIds.add(data.reportId);
			}
			add(data.usage);
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
		if (reportId && this.getCurrentSessionCostTotals().seenSubagentReportIds.has(reportId)) {
			return undefined;
		}
		const report: SpawnedUsageReport = {
			usage,
			label: opts?.label,
			sourceSessionId: opts?.sourceSessionId,
			reportId,
		};
		const entryId = this.deps.getSessionManager().appendCustomEntry(SPAWNED_USAGE_CUSTOM_TYPE, report);
		if (reportId) this.getCurrentSessionCostTotals();
		return entryId;
	}

	private getCurrentSessionCostTotals(): CurrentSessionCostAccumulator {
		const sessionManager = this.deps.getSessionManager();
		const entryCount = sessionManager.getEntryCount?.() ?? sessionManager.getEntries().length;
		let cache = this._currentSessionCostCache;
		const getEntriesSince = sessionManager.getEntriesSince?.bind(sessionManager);
		if (!cache || entryCount < cache.entryCount || !getEntriesSince) {
			cache = {
				entryCount,
				accumulator: accumulateCurrentSessionCostsFromEntries(
					createCurrentSessionCostAccumulator(),
					sessionManager.getEntries(),
				),
			};
			this._currentSessionCostCache = cache;
		} else if (entryCount > cache.entryCount) {
			accumulateCurrentSessionCostsFromEntries(cache.accumulator, getEntriesSince(cache.entryCount));
			cache.entryCount = entryCount;
		}
		return cache.accumulator;
	}

	/**
	 * Aggregate all recorded spawned-usage reports (see {@link addSpawnedUsage}). The append-ordered
	 * accumulator processes only new entries, so repeated turns do not rescan the full session.
	 */
	getSpawnedUsage(): SpawnedUsageTotals {
		const current = this.getCurrentSessionCostTotals();
		return { cost: current.subagentCost, reports: current.subagentReports };
	}

	getCostSummary(now = new Date()): SessionCostSummary {
		const sessionManager = this.deps.getSessionManager();
		const entryCount = sessionManager.getEntryCount?.() ?? sessionManager.getEntries().length;
		const window = getLocalDayWindow(now);
		const dailyTotals = this.getDailyUsageTotals(now);
		const cached = this._costSummaryCache;
		if (
			cached?.entryCount === entryCount &&
			cached.dailyTotals === dailyTotals &&
			cached.windowStartMs === window.startMs &&
			cached.windowEndMs === window.endMs
		) {
			return cached.summary;
		}
		const summary = createSessionCostSummary({
			currentTotals: this.getCurrentSessionCostTotals(),
			dailyTotals,
			todayWindow: window,
		});
		this._costSummaryCache = {
			entryCount,
			dailyTotals,
			windowStartMs: window.startMs,
			windowEndMs: window.endMs,
			summary,
		};
		return summary;
	}

	getDailyUsageTotals(now = new Date()): DailyUsageTotals {
		const sessionManager = this.deps.getSessionManager();
		const sessionDir = sessionManager.getSessionDir();
		const scope = sessionManager.usesDefaultSessionDir() ? getSessionsDir() : sessionDir;
		const nowMs = now.getTime();
		const window = getLocalDayWindow(now);
		if (
			this._dailyUsageCache?.sessionDir === scope &&
			this._dailyUsageCache.windowStartMs === window.startMs &&
			this._dailyUsageCache.windowEndMs === window.endMs &&
			this._dailyUsageCache.expiresAt > nowMs
		) {
			return this._dailyUsageCache.totals;
		}
		const sessionFile = sessionManager.getSessionFile();
		const liveSession = sessionFile ? { filePath: sessionFile, entries: sessionManager.getEntries() } : undefined;
		const totals = sessionManager.usesDefaultSessionDir()
			? aggregateDailyUsageFromSessionRoot(scope, window, liveSession)
			: aggregateDailyUsageFromSessionFiles(sessionDir, window, liveSession);
		this._dailyUsageCache = {
			sessionDir: scope,
			windowStartMs: window.startMs,
			windowEndMs: window.endMs,
			expiresAt: Math.min(nowMs + 10_000, window.endMs),
			totals,
		};
		return totals;
	}

	getDailyUsageBreakdown(formatLabel?: (label: string) => string, now = new Date()): string {
		return formatDailyUsageBreakdown(this.getDailyUsageTotals(now), formatLabel);
	}

	private getPostCompactionUsageState(): { hasCompaction: boolean; hasPostCompactionUsage: boolean } {
		const sessionManager = this.deps.getSessionManager();
		const indexedSessionManager = sessionManager as unknown as {
			getLeafId?: () => string | null;
			getEntry?: (id: string) => SessionEntry | undefined;
		};
		const getLeafId = indexedSessionManager.getLeafId?.bind(sessionManager);
		const getEntry = indexedSessionManager.getEntry?.bind(sessionManager);
		const leafId = getLeafId?.();
		if (getLeafId && getEntry && leafId !== undefined) {
			if (this._postCompactionUsageCache?.leafId === leafId) {
				return { ...this._postCompactionUsageCache };
			}
			const appended: SessionEntry[] = [];
			const cachedLeafId = this._postCompactionUsageCache?.leafId;
			let currentId = leafId;
			const seen = new Set<string>();
			while (currentId !== null && currentId !== cachedLeafId && !seen.has(currentId)) {
				seen.add(currentId);
				const entry = getEntry(currentId);
				if (!entry) break;
				appended.push(entry);
				currentId = entry.parentId;
			}
			const extendsCachedBranch = this._postCompactionUsageCache !== undefined && currentId === cachedLeafId;
			const state = extendsCachedBranch
				? { ...this._postCompactionUsageCache! }
				: { leafId: null, hasCompaction: false, hasPostCompactionUsage: false };
			if (!extendsCachedBranch && currentId !== null) {
				while (currentId !== null && !seen.has(currentId)) {
					seen.add(currentId);
					const entry = getEntry(currentId);
					if (!entry) break;
					appended.push(entry);
					currentId = entry.parentId;
				}
			}
			for (let index = appended.length - 1; index >= 0; index--) {
				const entry = appended[index];
				if (entry.type === "compaction") {
					state.hasCompaction = true;
					state.hasPostCompactionUsage = false;
				} else if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && state.hasCompaction) {
						state.hasPostCompactionUsage = calculateContextTokens(assistant.usage) > 0;
					}
				}
			}
			state.leafId = leafId;
			this._postCompactionUsageCache = state;
			return { ...state };
		}

		const branchEntries = sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		if (!latestCompaction) return { hasCompaction: false, hasPostCompactionUsage: false };
		const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
		for (let index = branchEntries.length - 1; index > compactionIndex; index--) {
			const entry = branchEntries[index];
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const assistant = entry.message;
			if (assistant.stopReason === "aborted" || assistant.stopReason === "error") continue;
			return { hasCompaction: true, hasPostCompactionUsage: calculateContextTokens(assistant.usage) > 0 };
		}
		return { hasCompaction: true, hasPostCompactionUsage: false };
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.deps.getModel();
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// Walk backward only to the nearest compaction instead of rebuilding the whole branch on
		// every footer invalidation; the distance is bounded by the live post-compaction context.
		const compactionState = this.getPostCompactionUsageState();
		if (compactionState.hasCompaction && !compactionState.hasPostCompactionUsage) {
			return { tokens: null, contextWindow, percent: null };
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
