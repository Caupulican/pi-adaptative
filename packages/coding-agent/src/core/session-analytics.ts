/**
 * Session usage / cost / stats accounting, context-window usage, and session export.
 *
 * Owns spawned-usage ingestion and accounting memo lifetimes. Single source of truth for
 * "how much did this session and its spawned
 * subtree spend" (footer roll-up, print-mode child reporting), the daily cross-session totals, the
 * /context window estimate, and HTML/JSONL export of the current branch.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { calculateContextTokens, estimateContextTokens } from "@caupulican/pi-agent-core/compaction/compaction";
import {
	CURRENT_SESSION_VERSION,
	getLatestCompactionEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionManager,
} from "@caupulican/pi-agent-core/session";
import type { AgentMessage, AgentState } from "@caupulican/pi-agent-core/types";
import { addUsage, createEmptyUsage, getSessionEntryUsage } from "@caupulican/pi-agent-core/usage";
import type { Model, Usage } from "@caupulican/pi-ai";
import { getSessionsDir } from "../config.ts";
import { theme } from "../modes/interactive/theme/theme.ts";
import { resolvePath } from "../utils/paths.ts";
import {
	type CompactionGateCheckStats,
	type SessionStats,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
	type SpawnedUsageTotals,
} from "./agent-session-contracts.ts";
import { latestAssistantText } from "./context/message-text.ts";
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
import { aggregateCumulativeUsageFromSessionEntries } from "./cost/session-usage.ts";
import {
	deliverSpawnedUsageReceipt,
	type SpawnedUsageReceiptDisposition,
	type SpawnedUsageReceiptOptions,
} from "./cost/spawned-usage-receipt.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import type { ContextUsage, ToolDefinition } from "./extensions/index.ts";
import { resolveSessionEntryIndex } from "./session-entry-index.ts";
import { writeJsonLinesSync } from "./session-jsonl-writer.ts";
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
	type ToolArgumentValidationRecord,
	type ToolArgumentValidationStats,
} from "./tool-recovery-stats.ts";

export const TOOL_ARGUMENT_VALIDATION_CUSTOM_TYPE = "tool_argument_validation";

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
	/** This session's real agent dir (may differ from the process-global default — see
	 * `AgentSessionConfig.agentDir`); HTML export's path-alias table lives under it. */
	getAgentDir(): string;
}

export class SessionAnalytics {
	/** All accounting memos belong to one append-only session lineage, not to its entry count. */
	private _accountingSession?: {
		session: SessionManager;
		sessionId: string;
		sessionFile: string | undefined;
		lastEntry: SessionEntry | undefined;
		entryCount: number;
	};
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
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usage = createEmptyUsage();

		for (const entry of this.deps.getSessionManager().getEntries()) {
			const entryUsage = getSessionEntryUsage(entry);
			if (entryUsage) addUsage(usage, entryUsage);
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
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
			totalMessages,
			tokens: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
			},
			cost: usage.cost.total,
			contextUsage: this.getContextUsage(),
			toolArgumentValidation,
			compactionGates,
		};
	}

	getCompactionGateStats(): SessionStats["compactionGates"] {
		let gateFailures = 0;
		let deterministicGapFills = 0;
		let compactionsWithGateFailures = 0;
		const checks = new Map<string, CompactionGateCheckStats>();
		for (const entry of this.deps.getSessionManager().getEntries()) {
			if (entry.type !== "compaction") continue;
			const details = entry.details;
			if (!details || typeof details !== "object") continue;
			const rawGateFailures = (details as { verificationGateFailures?: unknown }).verificationGateFailures;
			const rawGapFills = (details as { deterministicGapFills?: unknown }).deterministicGapFills;
			const rawChecks = (details as { verificationGateChecks?: unknown }).verificationGateChecks;
			const entryGateFailures =
				typeof rawGateFailures === "number" && Number.isFinite(rawGateFailures) ? rawGateFailures : 0;
			const entryGapFills = typeof rawGapFills === "number" && Number.isFinite(rawGapFills) ? rawGapFills : 0;
			gateFailures += entryGateFailures;
			deterministicGapFills += entryGapFills;
			if (entryGateFailures > 0) compactionsWithGateFailures++;
			if (rawChecks && typeof rawChecks === "object" && !Array.isArray(rawChecks)) {
				for (const [check, rawStats] of Object.entries(rawChecks)) {
					if (!rawStats || typeof rawStats !== "object" || Array.isArray(rawStats)) continue;
					const stats = rawStats as Record<string, unknown>;
					const failures = stats.failures;
					if (typeof failures !== "number" || !Number.isFinite(failures) || failures <= 0) continue;
					const current = checks.get(check) ?? { failures: 0 };
					current.failures += failures;
					if (typeof stats.minScore === "number" && Number.isFinite(stats.minScore)) {
						current.minScore = Math.min(current.minScore ?? stats.minScore, stats.minScore);
					}
					if (typeof stats.maxScore === "number" && Number.isFinite(stats.maxScore)) {
						current.maxScore = Math.max(current.maxScore ?? stats.maxScore, stats.maxScore);
					}
					if (typeof stats.threshold === "number" && Number.isFinite(stats.threshold)) {
						current.threshold = stats.threshold;
					}
					if (stats.comparator === "minimum" || stats.comparator === "maximum") {
						current.comparator = stats.comparator;
					}
					checks.set(check, current);
				}
			}
		}
		return { gateFailures, deterministicGapFills, compactionsWithGateFailures, checks: Object.fromEntries(checks) };
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
			if (record?.version !== 1) continue;
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
	 * direct assistant, tool and summary charges PLUS every `spawned_usage` report it has rolled up. Single source of
	 * truth for "how much did this session and everything it spawned spend" — used by print-mode
	 * to emit a child's total so a spawner can roll it up via {@link addSpawnedUsage}.
	 *
	 * Including the `spawned_usage` reports is what keeps the single-hop invariant intact: a child
	 * that itself spawned grandchildren must report own + sub-usage in one number, or the parent
	 * silently under-counts the grandchildren.
	 */
	getCumulativeUsage(): Usage {
		return aggregateCumulativeUsageFromSessionEntries(this.deps.getSessionManager().getEntries());
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

	/**
	 * Deliver an immutable outbox receipt through the existing spawned-usage ledger. Only a matching
	 * record read back from the owning parent's file permits the sender to discard its receipt.
	 * New sessions buffer entries before their first assistant; successful append alone is insufficient.
	 */
	deliverSpawnedUsageReceipt(usage: Usage, options: SpawnedUsageReceiptOptions): SpawnedUsageReceiptDisposition {
		return deliverSpawnedUsageReceipt(this.deps.getSessionManager(), this, usage, options);
	}

	private getAccountingSession(): SessionManager {
		const sessionManager = this.deps.getSessionManager();
		const entryCount = sessionManager.getEntryCount?.() ?? sessionManager.getEntries().length;
		const previous = this._accountingSession;
		const sameLineage =
			previous &&
			previous.session === sessionManager &&
			previous.sessionId === sessionManager.getSessionId() &&
			previous.sessionFile === sessionManager.getSessionFile() &&
			entryCount >= previous.entryCount &&
			(!previous.lastEntry ||
				(sessionManager.getEntry ? sessionManager.getEntry(previous.lastEntry.id) === previous.lastEntry : true));
		if (!sameLineage) {
			this._currentSessionCostCache = undefined;
			this._dailyUsageCache = undefined;
			this._costSummaryCache = undefined;
		}
		if (!sameLineage || entryCount !== previous?.entryCount) {
			const tail =
				entryCount > 0
					? (sessionManager.getEntriesSince?.(entryCount - 1) ?? sessionManager.getEntries()).at(-1)
					: undefined;
			this._accountingSession = {
				session: sessionManager,
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				entryCount,
				lastEntry: tail,
			};
		}
		return sessionManager;
	}

	private getCurrentSessionCostTotals(): CurrentSessionCostAccumulator {
		const sessionManager = this.getAccountingSession();
		const entryCount = sessionManager.getEntryCount?.() ?? sessionManager.getEntries().length;
		let cache = this._currentSessionCostCache;
		const getEntriesSince = sessionManager.getEntriesSince?.bind(sessionManager);
		if (!cache || entryCount < cache.entryCount || !getEntriesSince) {
			const entries = sessionManager.getEntries();
			cache = {
				entryCount,
				accumulator: accumulateCurrentSessionCostsFromEntries(createCurrentSessionCostAccumulator(), entries),
			};
			this._currentSessionCostCache = cache;
		} else if (entryCount > cache.entryCount) {
			const appended = getEntriesSince(cache.entryCount);
			accumulateCurrentSessionCostsFromEntries(cache.accumulator, appended);
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
		const sessionManager = this.getAccountingSession();
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
		const sessionManager = this.getAccountingSession();
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
		const index = resolveSessionEntryIndex(sessionManager);
		const leafId = index?.leafId;
		if (index && leafId !== undefined) {
			if (this._postCompactionUsageCache?.leafId === leafId) {
				return { ...this._postCompactionUsageCache };
			}
			const appended: SessionEntry[] = [];
			const cachedLeafId = this._postCompactionUsageCache?.leafId;
			let currentId = leafId;
			const seen = new Set<string>();
			while (currentId !== null && currentId !== cachedLeafId && !seen.has(currentId)) {
				seen.add(currentId);
				const entry = index.getEntry(currentId);
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
					const entry = index.getEntry(currentId);
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
			agentDir: this.deps.getAgentDir(),
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
		function* linearizedEntries(): Generator<SessionHeader | SessionEntry> {
			yield header;
			let prevId: string | null = null;
			for (const entry of branchEntries) {
				yield { ...entry, parentId: prevId };
				prevId = entry.id;
			}
		}
		writeJsonLinesSync(filePath, linearizedEntries());
		return filePath;
	}

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		return latestAssistantText(this.deps.getMessages());
	}
}
