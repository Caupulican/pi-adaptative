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
		`);
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
