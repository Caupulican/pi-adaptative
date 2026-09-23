/**
 * The decision ledger: one SQLite database per agent directory that retains, for every session,
 * the Decision graph's stage transitions and the semantic (Jev) evaluations the session ran.
 *
 * Owner decision (2026-09-20): this data is an analysis asset — accuracy, model usage, model fitness —
 * so it is never erased and lives in one database file rather than many scattered files. Rows are
 * keyed by session id (and carry the cwd), so sessions opened in the same project never clash and
 * per-project queries stay one `WHERE`. Writers append; nothing here deletes.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqliteDatabase, type SqliteDatabase } from "../context/sqlite-database.ts";
import type {
	DecisionStage,
	DecisionStageSink,
	DecisionStageSinkEntry,
	DecisionStageStoredEntry,
} from "./decision-stage-log.ts";
import { isLegacyIdleStageRow } from "./decision-stage-log.ts";

export const DECISION_LEDGER_SCHEMA_VERSION = 1;

/** A finished or in-flight semantic evaluation as the ledger stores it. */
export interface SemanticEvaluationLedgerRow {
	readonly evaluationId: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly programId: string;
	readonly label: string;
	readonly consequence?: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly outcome?: "ok" | "failed" | "cancelled";
	readonly verdict?: string;
	readonly reasons?: readonly string[];
	readonly model?: string;
}

/** One recorded session of a working directory, as the read tool lists it. */
export interface DecisionLedgerSessionRow {
	readonly sessionId: string;
	readonly firstAt: number;
	readonly lastAt: number;
	readonly stageEntries: number;
	readonly evaluations: number;
}

/** One System One route as the ledger keeps it: what was decided, from what evidence, who executed it. */
/**
 * One provider response's cache outcome on a lane (api, provider, model): the idle gap since the lane's
 * previous response, the prompt size, the cached share of the previous prompt, and whether the prefix was
 * intact. The substrate the cache-survival estimator learns each provider's cache lifetime from.
 */
export interface CacheObservationRow {
	readonly sessionId: string;
	readonly cwd: string;
	readonly lane: string;
	readonly observedAt: number;
	/** Milliseconds from the lane's previous response to this request; absent on a lane's first request. */
	readonly gapMs?: number;
	readonly promptTokens: number;
	readonly cacheReadTokens: number;
	/** cacheRead over the previous request's prompt, clamped to [0, 1]; absent without a previous prompt. */
	readonly retained?: number;
	readonly prefixIntact: "true" | "false" | "unknown";
	readonly divergenceKind?: string;
	/**
	 * The history lineage the request was made on: the compaction it follows, or `root` before the first
	 * one. A session's requests on one lineage are that lineage's lifetime, which ends at the next compaction.
	 */
	readonly lineage?: string;
}

/**
 * One priced decision to break (or keep) a provider cache: what was proposed (`kind`, e.g. `gc_pack`),
 * whether it was admitted, why, and the priced saving and cost. `detail` carries the kind's own facts.
 */
export interface CacheDecisionRow {
	readonly sessionId: string;
	readonly cwd: string;
	readonly kind: string;
	readonly decidedAt: number;
	readonly admit: boolean;
	readonly reason: string;
	readonly savingUsd?: number;
	readonly costUsd?: number;
	readonly detail?: Readonly<Record<string, number | string>>;
}

/** One session's history lineage: how many requests were made on it, and when the last one was. */
export interface LineageEpisodeRow {
	readonly sessionId: string;
	readonly lineage: string;
	readonly requests: number;
	readonly lastObservedAt: number;
}

export interface RouteDecisionRow {
	readonly sessionId: string;
	readonly cwd: string;
	readonly objectiveId: string;
	readonly cycleId: string;
	readonly route: string;
	readonly reasonCodes: readonly string[];
	readonly decidedAt: number;
	/** A monotone proxy for "new evidence since": objective evidence plus tasks plus attempts. */
	readonly evidenceMarker: number;
	readonly executor?: string;
}

export interface DecisionLedgerStoreOptions {
	readonly databasePath: string;
	readonly busyTimeoutMs?: number;
}

const STAGE_SET: ReadonlySet<string> = new Set([
	"understand",
	"plan",
	"build",
	"dispatch",
	"observe",
	"verify",
	"clarify",
	"repair",
	"deliver",
	"done",
]);

function asInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asText(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export class DecisionLedgerStore {
	private readonly database: SqliteDatabase;

	constructor(options: DecisionLedgerStoreOptions) {
		// The driver opens files, not directories: the state dir is ours to create.
		mkdirSync(dirname(options.databasePath), { recursive: true });
		this.database = openSqliteDatabase({
			databasePath: options.databasePath,
			...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}),
		});
		this.database.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS stage_entries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				objective_id TEXT NOT NULL,
				stage TEXT NOT NULL,
				entered_at INTEGER NOT NULL,
				ended_at INTEGER,
				loop INTEGER NOT NULL,
				reason_code TEXT,
				note TEXT
			);
			CREATE INDEX IF NOT EXISTS stage_entries_session ON stage_entries (session_id, id);
			CREATE INDEX IF NOT EXISTS stage_entries_cwd ON stage_entries (cwd, entered_at);
			CREATE TABLE IF NOT EXISTS semantic_evaluations (
				evaluation_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				program_id TEXT NOT NULL,
				label TEXT NOT NULL,
				consequence TEXT,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				outcome TEXT,
				verdict TEXT,
				reasons TEXT,
				model TEXT
			);
			CREATE INDEX IF NOT EXISTS semantic_evaluations_session ON semantic_evaluations (session_id, started_at);
			CREATE INDEX IF NOT EXISTS semantic_evaluations_cwd ON semantic_evaluations (cwd, started_at);
			CREATE TABLE IF NOT EXISTS route_decisions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				objective_id TEXT NOT NULL,
				cycle_id TEXT NOT NULL,
				route TEXT NOT NULL,
				reason_codes TEXT NOT NULL,
				decided_at INTEGER NOT NULL,
				evidence_marker INTEGER NOT NULL,
				executor TEXT
			);
			CREATE INDEX IF NOT EXISTS route_decisions_objective ON route_decisions (session_id, objective_id, id);
			CREATE TABLE IF NOT EXISTS cache_observations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				lane TEXT NOT NULL,
				observed_at INTEGER NOT NULL,
				gap_ms INTEGER,
				prompt_tokens INTEGER NOT NULL,
				cache_read_tokens INTEGER NOT NULL,
				retained REAL,
				prefix_intact TEXT NOT NULL,
				divergence_kind TEXT,
				lineage TEXT
			);
			CREATE INDEX IF NOT EXISTS cache_observations_lane ON cache_observations (lane, observed_at);
			CREATE INDEX IF NOT EXISTS cache_observations_session_lane ON cache_observations (session_id, lane, observed_at);
			CREATE TABLE IF NOT EXISTS cache_decisions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				cwd TEXT NOT NULL,
				kind TEXT NOT NULL,
				decided_at INTEGER NOT NULL,
				admit INTEGER NOT NULL,
				reason TEXT NOT NULL,
				saving_usd REAL,
				cost_usd REAL,
				detail TEXT
			);
			CREATE INDEX IF NOT EXISTS cache_decisions_session ON cache_decisions (session_id, decided_at);
		`);
		// Ledgers created before observations carried their lineage gain the column; their rows stay unassigned.
		const columns = this.database.prepare("PRAGMA table_info(cache_observations)").all();
		if (!columns.some((column) => column.name === "lineage")) {
			this.database.exec("ALTER TABLE cache_observations ADD COLUMN lineage TEXT");
		}
		this.database.exec(
			"CREATE INDEX IF NOT EXISTS cache_observations_lineage ON cache_observations (session_id, lineage, observed_at)",
		);
		this.database
			.prepare("INSERT OR IGNORE INTO ledger_meta (key, value) VALUES ('schema_version', ?)")
			.run(String(DECISION_LEDGER_SCHEMA_VERSION));
	}

	/** A sink bound to one session, for the stage log. */
	stageSink(sessionId: string, cwd: string): DecisionStageSink {
		return {
			open: (entry) => this.openStage(sessionId, cwd, entry),
			close: (rowId, endedAt) => this.closeStage(rowId, endedAt),
			load: () => this.loadStages(sessionId),
			reanchor: (rowId, enteredAt) => this.reanchorStage(rowId, enteredAt),
		};
	}

	openStage(sessionId: string, cwd: string, entry: DecisionStageSinkEntry): number {
		const result = this.database
			.prepare(
				`INSERT INTO stage_entries (session_id, cwd, objective_id, stage, entered_at, loop, reason_code, note)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				sessionId,
				cwd,
				entry.objectiveId,
				entry.stage,
				entry.enteredAt,
				entry.loop,
				entry.reasonCode ?? null,
				entry.note ?? null,
			);
		const rowId = asInteger((result as { lastInsertRowid?: unknown } | undefined)?.lastInsertRowid);
		if (rowId !== undefined) return rowId;
		// bun:sqlite reports the rowid the same way; a driver that does not is answered by a query.
		const row = this.database.prepare("SELECT MAX(id) AS id FROM stage_entries WHERE session_id = ?").get(sessionId);
		return asInteger(row?.id) ?? 0;
	}

	closeStage(rowId: number, endedAt: number): void {
		this.database
			.prepare("UPDATE stage_entries SET ended_at = ? WHERE id = ? AND ended_at IS NULL")
			.run(endedAt, rowId);
	}

	/** Restarts an open stage at `enteredAt`. A closed row is left alone. */
	reanchorStage(rowId: number, enteredAt: number): void {
		this.database
			.prepare("UPDATE stage_entries SET entered_at = ? WHERE id = ? AND ended_at IS NULL")
			.run(enteredAt, rowId);
	}

	/** Every stage entry of a session, oldest first. */
	loadStages(sessionId: string): DecisionStageStoredEntry[] {
		const rows = this.database
			.prepare(
				"SELECT id, objective_id, stage, entered_at, ended_at, loop, reason_code, note FROM stage_entries WHERE session_id = ? ORDER BY id",
			)
			.all(sessionId);
		const entries: DecisionStageStoredEntry[] = [];
		for (const row of rows) {
			const stage = asText(row.stage);
			const id = asInteger(row.id);
			const enteredAt = asInteger(row.entered_at);
			const loop = asInteger(row.loop);
			const objectiveId = asText(row.objective_id);
			if (
				stage === undefined ||
				!STAGE_SET.has(stage) ||
				id === undefined ||
				enteredAt === undefined ||
				loop === undefined ||
				objectiveId === undefined
			)
				continue;
			const endedAt = asInteger(row.ended_at);
			const reasonCode = asText(row.reason_code);
			const note = asText(row.note);
			if (isLegacyIdleStageRow({ stage, ...(reasonCode !== undefined ? { reasonCode } : {}) })) continue;
			entries.push({
				rowId: id,
				objectiveId,
				stage: stage as DecisionStage,
				enteredAt,
				loop,
				...(endedAt !== undefined ? { endedAt } : {}),
				...(reasonCode !== undefined ? { reasonCode } : {}),
				...(note !== undefined ? { note } : {}),
			});
		}
		return entries;
	}

	/** Records the start of a semantic evaluation; settled later by `settleSemanticEvaluation`. */
	startSemanticEvaluation(
		row: Omit<SemanticEvaluationLedgerRow, "endedAt" | "outcome" | "verdict" | "reasons">,
	): void {
		this.database
			.prepare(
				`INSERT OR IGNORE INTO semantic_evaluations (evaluation_id, session_id, cwd, program_id, label, consequence, started_at, model)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.evaluationId,
				row.sessionId,
				row.cwd,
				row.programId,
				row.label,
				row.consequence ?? null,
				row.startedAt,
				row.model ?? null,
			);
	}

	settleSemanticEvaluation(
		evaluationId: string,
		settlement: {
			endedAt: number;
			outcome: "ok" | "failed" | "cancelled";
			verdict?: string;
			reasons?: readonly string[];
		},
	): void {
		this.database
			.prepare(
				"UPDATE semantic_evaluations SET ended_at = ?, outcome = ?, verdict = COALESCE(?, verdict), reasons = COALESCE(?, reasons) WHERE evaluation_id = ?",
			)
			.run(
				settlement.endedAt,
				settlement.outcome,
				settlement.verdict ?? null,
				settlement.reasons ? JSON.stringify(settlement.reasons) : null,
				evaluationId,
			);
	}

	/** The verdict of an evaluation that settled before its policy result was known (System One stages). */
	noteSemanticVerdict(evaluationId: string, verdict: string, reasons?: readonly string[]): void {
		this.database
			.prepare("UPDATE semantic_evaluations SET verdict = ?, reasons = COALESCE(?, reasons) WHERE evaluation_id = ?")
			.run(verdict, reasons ? JSON.stringify(reasons) : null, evaluationId);
	}

	/** Sessions recorded for a working directory, newest activity first, bounded. */
	listSessions(cwd: string, limit: number): DecisionLedgerSessionRow[] {
		const rows = this.database
			.prepare(
				`SELECT session_id, MIN(first_at) AS first_at, MAX(last_at) AS last_at,
					SUM(stage_entries) AS stage_entries, SUM(evaluations) AS evaluations
				FROM (
					SELECT session_id, MIN(entered_at) AS first_at, MAX(entered_at) AS last_at, COUNT(*) AS stage_entries, 0 AS evaluations
						FROM stage_entries WHERE cwd = ? GROUP BY session_id
					UNION ALL
					SELECT session_id, MIN(started_at) AS first_at, MAX(started_at) AS last_at, 0 AS stage_entries, COUNT(*) AS evaluations
						FROM semantic_evaluations WHERE cwd = ? GROUP BY session_id
				) GROUP BY session_id ORDER BY last_at DESC LIMIT ?`,
			)
			.all(cwd, cwd, Math.max(1, Math.floor(limit)));
		const out: DecisionLedgerSessionRow[] = [];
		for (const row of rows) {
			const sessionId = asText(row.session_id);
			const firstAt = asInteger(row.first_at);
			const lastAt = asInteger(row.last_at);
			if (sessionId === undefined || firstAt === undefined || lastAt === undefined) continue;
			out.push({
				sessionId,
				firstAt,
				lastAt,
				stageEntries: asInteger(row.stage_entries) ?? 0,
				evaluations: asInteger(row.evaluations) ?? 0,
			});
		}
		return out;
	}

	/** Records one provider response's cache outcome (see {@link CacheObservationRow}). */
	recordCacheObservation(row: CacheObservationRow): void {
		this.database
			.prepare(
				`INSERT INTO cache_observations
				 (session_id, cwd, lane, observed_at, gap_ms, prompt_tokens, cache_read_tokens, retained, prefix_intact, divergence_kind, lineage)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.sessionId,
				row.cwd,
				row.lane,
				row.observedAt,
				row.gapMs ?? null,
				row.promptTokens,
				row.cacheReadTokens,
				row.retained ?? null,
				row.prefixIntact,
				row.divergenceKind ?? null,
				row.lineage ?? null,
			);
	}

	/** Records one priced cache decision (see {@link CacheDecisionRow}). */
	recordCacheDecision(row: CacheDecisionRow): void {
		this.database
			.prepare(
				`INSERT INTO cache_decisions (session_id, cwd, kind, decided_at, admit, reason, saving_usd, cost_usd, detail)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.sessionId,
				row.cwd,
				row.kind,
				row.decidedAt,
				row.admit ? 1 : 0,
				row.reason,
				row.savingUsd ?? null,
				row.costUsd ?? null,
				row.detail ? JSON.stringify(row.detail) : null,
			);
	}

	/** A session's cache decisions, oldest first. */
	cacheDecisions(sessionId: string): CacheDecisionRow[] {
		const rows = this.database
			.prepare("SELECT * FROM cache_decisions WHERE session_id = ? ORDER BY decided_at, id")
			.all(sessionId);
		const out: CacheDecisionRow[] = [];
		for (const row of rows) {
			const cwd = asText(row.cwd);
			const kind = asText(row.kind);
			const decidedAt = asInteger(row.decided_at);
			const reason = asText(row.reason);
			if (cwd === undefined || kind === undefined || decidedAt === undefined || reason === undefined) continue;
			const detailText = asText(row.detail);
			out.push({
				sessionId,
				cwd,
				kind,
				decidedAt,
				admit: row.admit === 1,
				reason,
				...(typeof row.saving_usd === "number" ? { savingUsd: row.saving_usd } : {}),
				...(typeof row.cost_usd === "number" ? { costUsd: row.cost_usd } : {}),
				...(detailText !== undefined ? { detail: JSON.parse(detailText) as Record<string, number | string> } : {}),
			});
		}
		return out;
	}

	/** A session lane's most recent observation: where a resumed session's next gap is measured from. */
	latestCacheObservation(sessionId: string, lane: string): { observedAt: number; promptTokens: number } | undefined {
		const row = this.database
			.prepare(
				"SELECT observed_at, prompt_tokens FROM cache_observations WHERE session_id = ? AND lane = ? ORDER BY observed_at DESC LIMIT 1",
			)
			.get(sessionId, lane);
		const observedAt = asInteger(row?.observed_at);
		const promptTokens = asInteger(row?.prompt_tokens);
		return observedAt !== undefined && promptTokens !== undefined ? { observedAt, promptTokens } : undefined;
	}

	/**
	 * Every recorded history lineage across sessions: its request count and last request time, newest
	 * first. Rows recorded without a lineage are not counted.
	 */
	lineageEpisodes(): LineageEpisodeRow[] {
		const rows = this.database
			.prepare(
				`SELECT session_id, lineage, COUNT(*) AS requests, MAX(observed_at) AS last_at
				 FROM cache_observations WHERE lineage IS NOT NULL
				 GROUP BY session_id, lineage ORDER BY last_at DESC`,
			)
			.all();
		const out: LineageEpisodeRow[] = [];
		for (const row of rows) {
			const sessionId = asText(row.session_id);
			const lineage = asText(row.lineage);
			const requests = asInteger(row.requests);
			const lastObservedAt = asInteger(row.last_at);
			if (sessionId === undefined || lineage === undefined || requests === undefined || lastObservedAt === undefined)
				continue;
			out.push({ sessionId, lineage, requests, lastObservedAt });
		}
		return out;
	}

	/** A lane's most recent observations across sessions, newest first, bounded. */
	recentCacheObservations(lane: string, limit: number): CacheObservationRow[] {
		const rows = this.database
			.prepare("SELECT * FROM cache_observations WHERE lane = ? ORDER BY observed_at DESC LIMIT ?")
			.all(lane, Math.max(1, Math.floor(limit)));
		const out: CacheObservationRow[] = [];
		for (const row of rows) {
			const sessionId = asText(row.session_id);
			const cwd = asText(row.cwd);
			const observedAt = asInteger(row.observed_at);
			const promptTokens = asInteger(row.prompt_tokens);
			const cacheReadTokens = asInteger(row.cache_read_tokens);
			const prefixIntact = asText(row.prefix_intact);
			if (
				sessionId === undefined ||
				cwd === undefined ||
				observedAt === undefined ||
				promptTokens === undefined ||
				cacheReadTokens === undefined ||
				(prefixIntact !== "true" && prefixIntact !== "false" && prefixIntact !== "unknown")
			)
				continue;
			const gapMs = asInteger(row.gap_ms);
			const retained = typeof row.retained === "number" ? row.retained : undefined;
			const divergenceKind = asText(row.divergence_kind);
			const lineage = asText(row.lineage);
			out.push({
				sessionId,
				cwd,
				lane,
				observedAt,
				promptTokens,
				cacheReadTokens,
				prefixIntact,
				...(gapMs !== undefined ? { gapMs } : {}),
				...(retained !== undefined ? { retained } : {}),
				...(divergenceKind !== undefined ? { divergenceKind } : {}),
				...(lineage !== undefined ? { lineage } : {}),
			});
		}
		return out;
	}

	/** Records a route System One decided; the executor is noted once the route ran. */
	recordRoute(row: Omit<RouteDecisionRow, "executor">): void {
		this.database
			.prepare(
				`INSERT INTO route_decisions (session_id, cwd, objective_id, cycle_id, route, reason_codes, decided_at, evidence_marker)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				row.sessionId,
				row.cwd,
				row.objectiveId,
				row.cycleId,
				row.route,
				JSON.stringify(row.reasonCodes),
				row.decidedAt,
				row.evidenceMarker,
			);
	}

	noteRouteExecutor(sessionId: string, cycleId: string, executor: string): void {
		this.database
			.prepare("UPDATE route_decisions SET executor = ? WHERE session_id = ? AND cycle_id = ?")
			.run(executor, sessionId, cycleId);
	}

	/** The objective's recent routes, oldest first, bounded. */
	recentRoutes(sessionId: string, objectiveId: string, limit: number): RouteDecisionRow[] {
		const rows = this.database
			.prepare("SELECT * FROM route_decisions WHERE session_id = ? AND objective_id = ? ORDER BY id DESC LIMIT ?")
			.all(sessionId, objectiveId, Math.max(1, Math.floor(limit)));
		const out: RouteDecisionRow[] = [];
		for (const row of rows) {
			const cwd = asText(row.cwd);
			const cycleId = asText(row.cycle_id);
			const route = asText(row.route);
			const decidedAt = asInteger(row.decided_at);
			const evidenceMarker = asInteger(row.evidence_marker);
			if (
				cwd === undefined ||
				cycleId === undefined ||
				route === undefined ||
				decidedAt === undefined ||
				evidenceMarker === undefined
			)
				continue;
			let reasonCodes: string[] = [];
			try {
				const parsed: unknown = JSON.parse(asText(row.reason_codes) ?? "[]");
				if (Array.isArray(parsed)) reasonCodes = parsed.filter((item): item is string => typeof item === "string");
			} catch {
				reasonCodes = [];
			}
			const executor = asText(row.executor);
			out.push({
				sessionId,
				cwd,
				objectiveId,
				cycleId,
				route,
				reasonCodes,
				decidedAt,
				evidenceMarker,
				...(executor !== undefined ? { executor } : {}),
			});
		}
		return out.reverse();
	}

	/** Recent evaluations of a session, newest first, bounded. */
	recentSemanticEvaluations(sessionId: string, limit: number): SemanticEvaluationLedgerRow[] {
		const rows = this.database
			.prepare("SELECT * FROM semantic_evaluations WHERE session_id = ? ORDER BY started_at DESC LIMIT ?")
			.all(sessionId, Math.max(1, Math.floor(limit)));
		const out: SemanticEvaluationLedgerRow[] = [];
		for (const row of rows) {
			const evaluationId = asText(row.evaluation_id);
			const programId = asText(row.program_id);
			const label = asText(row.label);
			const startedAt = asInteger(row.started_at);
			const cwd = asText(row.cwd);
			if (
				evaluationId === undefined ||
				programId === undefined ||
				label === undefined ||
				startedAt === undefined ||
				cwd === undefined
			)
				continue;
			const outcome = asText(row.outcome);
			let reasons: string[] | undefined;
			const rawReasons = asText(row.reasons);
			if (rawReasons !== undefined) {
				try {
					const parsed: unknown = JSON.parse(rawReasons);
					if (Array.isArray(parsed)) reasons = parsed.filter((item): item is string => typeof item === "string");
				} catch {
					reasons = undefined;
				}
			}
			const endedAt = asInteger(row.ended_at);
			const verdict = asText(row.verdict);
			const consequence = asText(row.consequence);
			const model = asText(row.model);
			out.push({
				evaluationId,
				sessionId,
				cwd,
				programId,
				label,
				startedAt,
				...(consequence !== undefined ? { consequence } : {}),
				...(endedAt !== undefined ? { endedAt } : {}),
				...(outcome === "ok" || outcome === "failed" || outcome === "cancelled" ? { outcome } : {}),
				...(verdict !== undefined ? { verdict } : {}),
				...(reasons !== undefined ? { reasons } : {}),
				...(model !== undefined ? { model } : {}),
			});
		}
		return out;
	}

	close(): void {
		this.database[Symbol.dispose]();
	}
}
