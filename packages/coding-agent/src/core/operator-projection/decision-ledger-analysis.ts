/**
 * The decision ledger's analysis reader: read-only aggregate questions over the tables
 * `decision-ledger-store.ts` writes, so an operator can total the ledger and write its settled System
 * One evaluations out as replay cases a person can label. It owns its own queries (the store is over
 * the file-size limit and may not grow) and never writes a row, creates nothing, and changes nothing.
 *
 * Every read is paged in `PAGE_ROWS` rows and runs inside one read snapshot, so no statement returns a
 * whole table and no two pages disagree. A stored JSON column that does not decode to the shape the
 * store writes marks its row unreadable: the row still counts where its scalar columns are read, it is
 * left out of the export, and it never throws.
 *
 * The store adds tables and columns when a session opens a ledger; this reader adds nothing. So a ledger
 * last written by an earlier build may lack a table or a column this build reads: the reader looks once
 * at what the file holds, reads a missing column as absent and a missing table as empty.
 */

import { existsSync } from "node:fs";
import { openSqliteDatabase, type SqliteDatabase, withSqliteTransaction } from "../context/sqlite-database.ts";
import { redactSecrets } from "../system-one/projector.ts";
import type {
	SemanticDecisionTrace,
	SemanticEvaluationOutcome,
	SemanticEvaluationScope,
	SemanticQuestionState,
} from "../system-one/semantic-evaluation-ledger.ts";
import { DECISION_LEDGER_SCHEMA_VERSION } from "./decision-ledger-store.ts";

/** Rows per statement; the ledger is append-only and unbounded, a read is not. */
const PAGE_ROWS = 500;
/** Verdicts kept per program; the rest are summed as `other`. */
const MAX_VERDICTS = 8;
const BUSY_TIMEOUT_MS = 5_000;
const SETTLED_OUTCOMES = "('ok', 'failed', 'cancelled')";

/** Which rows an analysis reads. Omitted fields widen it. */
export interface DecisionAnalysisScope {
	/** Rows of this working directory only; undefined reads every project. */
	readonly cwd?: string;
	/** Rows at or after this time (epoch ms); undefined reads all of them. */
	readonly since?: number;
	/** For the export: one program id only. */
	readonly programId?: string;
}

export interface DecisionEvaluationCounts {
	readonly total: number;
	readonly ok: number;
	readonly failed: number;
	readonly cancelled: number;
	/** Started and not settled yet. */
	readonly unsettled: number;
}

export interface DecisionProgramReport {
	readonly programId: string;
	readonly total: number;
	readonly ok: number;
	readonly failed: number;
	readonly cancelled: number;
	/** Evaluations with at least one question state marked uncertain. */
	readonly uncertain: number;
	/** Evaluations whose trace says the judgments were reused, not asked again. */
	readonly cached: number;
	/** Of `ended_at - started_at` over settled rows, in ms; absent with no settled row. */
	readonly medianMs?: number;
	readonly p90Ms?: number;
	/** Count per `trace.exit`; rows whose trace recorded none are not counted. */
	readonly exits: Readonly<Record<string, number>>;
	/** Count per `verdict`, at most the 8 most frequent, the rest summed as `other`. */
	readonly verdicts: Readonly<Record<string, number>>;
}

export interface DecisionOperationGateReport {
	readonly total: number;
	readonly actions: Readonly<Record<string, number>>;
	readonly sources: Readonly<Record<string, number>>;
	readonly notable: number;
	/** Of `duration_ms`; absent with no row. */
	readonly medianMs?: number;
}

export interface DecisionRouteReport {
	readonly total: number;
	readonly routes: Readonly<Record<string, number>>;
	/** Count per `executor`; a row whose executor was never noted is counted as `unassigned`. */
	readonly executors: Readonly<Record<string, number>>;
}

export interface DecisionSupervisionReport {
	readonly total: number;
	/** Count per supervision action. */
	readonly actions: Readonly<Record<string, number>>;
}

/** The ledger totalled over one scope. Plain data: every part is JSON-serialisable and count-free of rows. */
export interface DecisionReport {
	/** Distinct sessions holding rows of the scope, over the tables this report reads. */
	readonly sessions: number;
	readonly evaluations: DecisionEvaluationCounts;
	/** One entry per `program_id`, most frequent first. */
	readonly programs: readonly DecisionProgramReport[];
	/** Count of evaluations per model; a row without one is counted as `unknown`. */
	readonly models: Readonly<Record<string, number>>;
	readonly operationGate: DecisionOperationGateReport;
	readonly routes: DecisionRouteReport;
	readonly supervision: DecisionSupervisionReport;
	/** Count per disposition, over the doubts whose evaluation is in scope. */
	readonly doubts: Readonly<Record<string, number>>;
	/** Rows whose stored JSON did not decode: counted here, left out of the export, never thrown. */
	readonly unreadable: number;
}

/**
 * One settled System One evaluation as a case a person can label: what the session asked of System One
 * and what System One answered, with `expected` left null for the verdict that would have been right.
 */
export interface DecisionReplayCase {
	/** The evaluation id. */
	readonly case: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly programId: string;
	readonly label: string;
	readonly consequence?: string;
	readonly scope?: SemanticEvaluationScope;
	readonly namespace?: string;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly model?: string;
	readonly outcome: SemanticEvaluationOutcome;
	readonly verdict?: string;
	readonly reasons: readonly string[];
	readonly questions: readonly SemanticQuestionState[];
	readonly trace?: SemanticDecisionTrace;
	/** Always null: the slot a person fills with the verdict that would have been right. */
	readonly expected: null;
}

export interface DecisionLedgerAnalysis {
	report(scope: DecisionAnalysisScope): DecisionReport;
	/** Settled System One evaluations as replay cases, oldest first, handed to `write` one at a time. */
	exportCases(scope: DecisionAnalysisScope, write: (replayCase: DecisionReplayCase) => void): number;
	close(): void;
}

/** A stored JSON column: absent (the column is null), decoded, or text this reader could not trust. */
interface Decoded<T> {
	readonly value?: T;
	readonly broken: boolean;
}

const ABSENT: Decoded<never> = { broken: false };

function decode<T>(text: string | undefined, accept: (value: unknown) => T | undefined): Decoded<T> {
	if (text === undefined) return ABSENT;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { broken: true };
	}
	const value = accept(parsed);
	return value === undefined ? { broken: true } : { value, broken: false };
}

function acceptReasons(value: unknown): readonly string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function acceptQuestions(value: unknown): readonly SemanticQuestionState[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const states: SemanticQuestionState[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) return undefined;
		const stored = item as Record<string, unknown>;
		if (typeof stored.question !== "string" || typeof stored.uncertain !== "boolean") return undefined;
		if (stored.text !== undefined && typeof stored.text !== "string") return undefined;
		states.push({
			question: stored.question,
			uncertain: stored.uncertain,
			...(stored.text !== undefined ? { text: stored.text } : {}),
		});
	}
	return states;
}

function acceptTrace(value: unknown): SemanticDecisionTrace | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const stored = value as Record<string, unknown>;
	if (typeof stored.decision !== "string") return undefined;
	for (const key of ["gates", "judgments", "facts"]) {
		const list = stored[key];
		if (list !== undefined && !Array.isArray(list)) return undefined;
	}
	if (stored.exit !== undefined && typeof stored.exit !== "string") return undefined;
	if (stored.cached !== undefined && typeof stored.cached !== "boolean") return undefined;
	return value as SemanticDecisionTrace;
}

function asText(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function countInto(counts: Map<string, number>, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

function toRecord(counts: Map<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, count] of counts) out[key] = count;
	return out;
}

/** Sorted by count, most frequent first, then by name so the same ledger always prints the same report. */
function byFrequency(counts: Map<string, number>): Array<[string, number]> {
	return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

/** A tally in reading order: the most frequent name first, so two reports of one ledger print alike. */
function frequencyRecord(counts: Map<string, number>): Record<string, number> {
	return toRecord(new Map(byFrequency(counts)));
}

/** The 8 most frequent verdicts, the rest summed as `other`. */
function trimVerdicts(counts: Map<string, number>): Record<string, number> {
	const sorted = byFrequency(counts);
	const kept = toRecord(new Map(sorted.slice(0, MAX_VERDICTS)));
	const rest = sorted.slice(MAX_VERDICTS).reduce((sum, [, count]) => sum + count, 0);
	if (rest > 0) kept.other = rest;
	return kept;
}

function sortedValues(values: readonly number[]): number[] {
	return [...values].sort((left, right) => left - right);
}

/** The two middle values averaged, as the ledger's other medians are; absent with no value. */
function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = sortedValues(values);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Nearest rank: the smallest value at or above the percentile's share of the rows. */
function percentile(values: readonly number[], share: number): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = sortedValues(values);
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil((share / 100) * sorted.length)));
	return sorted[rank - 1]!;
}

interface ScopeSql {
	readonly where: string;
	readonly params: unknown[];
}

/** One table's scope; the column names are the module's own constants, never caller input. */
function scopeSql(scope: DecisionAnalysisScope, cwdColumn: string, timeColumn: string): ScopeSql {
	const clauses: string[] = [];
	const params: unknown[] = [];
	if (scope.cwd !== undefined) {
		clauses.push(`${cwdColumn} = ?`);
		params.push(scope.cwd);
	}
	if (scope.since !== undefined) {
		clauses.push(`${timeColumn} >= ?`);
		params.push(scope.since);
	}
	return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** The program restriction, for the tables that name a program (`semantic_evaluations` alone). */
function withProgram(sql: ScopeSql, scope: DecisionAnalysisScope, programColumn: string): ScopeSql {
	if (scope.programId === undefined) return sql;
	return {
		where: `${sql.where.length > 0 ? `${sql.where} AND` : "WHERE"} ${programColumn} = ?`,
		params: [...sql.params, scope.programId],
	};
}

/** One evaluation row as the analysis reads it. */
interface AnalyzedEvaluation {
	readonly evaluationId: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly programId: string;
	readonly label: string;
	readonly consequence?: string;
	readonly scope?: SemanticEvaluationScope;
	readonly namespace?: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly model?: string;
	readonly outcome?: SemanticEvaluationOutcome;
	readonly verdict?: string;
	readonly reasons: readonly string[];
	readonly questions: readonly SemanticQuestionState[];
	readonly trace?: SemanticDecisionTrace;
	/** A stored JSON column of this row did not decode. */
	readonly broken: boolean;
}

/** The columns of `semantic_evaluations` this reader selects; the store added the later ones to older ledgers. */
const EVALUATION_COLUMNS = [
	"evaluation_id",
	"session_id",
	"cwd",
	"program_id",
	"label",
	"consequence",
	"started_at",
	"ended_at",
	"outcome",
	"verdict",
	"reasons",
	"question_states",
	"model",
	"scope_kind",
	"scope_id",
	"question_namespace",
	"trace",
] as const;

/** What a ledger file holds: its tables, each with its columns. Read once when the ledger is opened. */
type LedgerLayout = ReadonlyMap<string, ReadonlySet<string>>;

/** The tables this reader reads; their names are this module's own constants, never caller input. */
const READ_TABLES = [
	"stage_entries",
	"semantic_evaluations",
	"semantic_doubt_decisions",
	"route_decisions",
	"operation_gate_decisions",
	"supervision_actions",
] as const;

function readLayout(database: SqliteDatabase): LedgerLayout {
	const layout = new Map<string, ReadonlySet<string>>();
	for (const table of READ_TABLES) {
		const columns = database
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((column) => asText(column.name))
			.filter((name): name is string => name !== undefined);
		if (columns.length > 0) layout.set(table, new Set(columns));
	}
	return layout;
}

function readEvaluation(row: Record<string, unknown>): AnalyzedEvaluation | undefined {
	const evaluationId = asText(row.evaluation_id);
	const sessionId = asText(row.session_id);
	const cwd = asText(row.cwd);
	const programId = asText(row.program_id);
	const label = asText(row.label);
	const startedAt = asInteger(row.started_at);
	if (
		evaluationId === undefined ||
		sessionId === undefined ||
		cwd === undefined ||
		programId === undefined ||
		label === undefined ||
		startedAt === undefined
	)
		return undefined;
	const outcomeText = asText(row.outcome);
	const reasons = decode(asText(row.reasons), acceptReasons);
	const questions = decode(asText(row.question_states), acceptQuestions);
	const trace = decode(asText(row.trace), acceptTrace);
	const scopeKind = asText(row.scope_kind);
	const scopeId = asText(row.scope_id);
	const consequence = asText(row.consequence);
	const namespace = asText(row.question_namespace);
	const endedAt = asInteger(row.ended_at);
	const model = asText(row.model);
	const verdict = asText(row.verdict);
	return {
		evaluationId,
		sessionId,
		cwd,
		programId,
		label,
		startedAt,
		reasons: reasons.value ?? [],
		questions: questions.value ?? [],
		broken: reasons.broken || questions.broken || trace.broken,
		...(consequence !== undefined ? { consequence } : {}),
		...(scopeId !== undefined && (scopeKind === "session" || scopeKind === "worker-task")
			? { scope: { kind: scopeKind, id: scopeId } }
			: {}),
		...(namespace !== undefined ? { namespace } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(model !== undefined ? { model } : {}),
		...(outcomeText === "ok" || outcomeText === "failed" || outcomeText === "cancelled"
			? { outcome: outcomeText as SemanticEvaluationOutcome }
			: {}),
		...(verdict !== undefined ? { verdict } : {}),
		...(trace.value !== undefined ? { trace: trace.value } : {}),
	};
}

class LedgerAnalysis implements DecisionLedgerAnalysis {
	private readonly database: SqliteDatabase;
	private readonly layout: LedgerLayout;

	constructor(database: SqliteDatabase, layout: LedgerLayout) {
		this.database = database;
		this.layout = layout;
	}

	private has(table: string, column?: string): boolean {
		const columns = this.layout.get(table);
		return columns !== undefined && (column === undefined || columns.has(column));
	}

	/** `column`, or NULL under its name when this ledger's table does not have it yet. */
	private columnOrNull(table: string, column: string): string {
		return this.has(table, column) ? column : `NULL AS ${column}`;
	}

	/** One read snapshot: pages read the same rows, whatever a live session appends meanwhile. */
	private snapshot<T>(run: () => T, label: string): T {
		return withSqliteTransaction(this.database, run, label, "read");
	}

	private page(sql: string, params: readonly unknown[], visit: (row: Record<string, unknown>) => void): number {
		let offset = 0;
		let rows = 0;
		for (;;) {
			const page = this.database.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, PAGE_ROWS, offset);
			for (const row of page) visit(row);
			rows += page.length;
			if (page.length < PAGE_ROWS) return rows;
			offset += PAGE_ROWS;
		}
	}

	private forEachEvaluation(
		scope: DecisionAnalysisScope,
		settledOnly: boolean,
		visit: (row: AnalyzedEvaluation) => void,
	): void {
		if (!this.has("semantic_evaluations")) return;
		const { where, params } = withProgram(scopeSql(scope, "cwd", "started_at"), scope, "program_id");
		const settled = settledOnly ? (where.length > 0 ? " AND" : " WHERE") : "";
		const columns = EVALUATION_COLUMNS.map((column) => this.columnOrNull("semantic_evaluations", column));
		const sql = `SELECT ${columns.join(", ")} FROM semantic_evaluations ${where}${settled}${
			settledOnly ? ` outcome IN ${SETTLED_OUTCOMES}` : ""
		} ORDER BY started_at, rowid`;
		this.page(sql, params, (row) => {
			const evaluation = readEvaluation(row);
			if (evaluation !== undefined) visit(evaluation);
		});
	}

	private countSessions(scope: DecisionAnalysisScope): number {
		const tables: ReadonlyArray<readonly [string, string, string]> = [
			["stage_entries", "cwd", "entered_at"],
			["semantic_evaluations", "cwd", "started_at"],
			["route_decisions", "cwd", "decided_at"],
			["operation_gate_decisions", "cwd", "decided_at"],
			["supervision_actions", "cwd", "decided_at"],
		];
		const parts: string[] = [];
		const params: unknown[] = [];
		// The program restriction is the export's alone (`semantic_evaluations.program_id`); sessions are
		// counted over the whole scope, because a session's rows of other programs are still its rows.
		for (const [table, cwdColumn, timeColumn] of tables) {
			if (!this.has(table)) continue;
			const scoped = scopeSql(scope, cwdColumn, timeColumn);
			parts.push(`SELECT session_id FROM ${table} ${scoped.where}`);
			params.push(...scoped.params);
		}
		if (parts.length === 0) return 0;
		const row = this.database.prepare(`SELECT COUNT(*) AS sessions FROM (${parts.join(" UNION ")})`).get(...params);
		return asInteger(row?.sessions) ?? 0;
	}

	report(scope: DecisionAnalysisScope): DecisionReport {
		return this.snapshot(() => {
			const evaluations: MutableCounts = { total: 0, ok: 0, failed: 0, cancelled: 0, unsettled: 0 };
			const programs = new Map<string, ProgramAccumulator>();
			const models = new Map<string, number>();
			const unreadable = { rows: 0 };
			this.forEachEvaluation(scope, false, (row) => {
				accumulateEvaluation(evaluations, programs, models, unreadable, row);
			});
			return {
				sessions: this.countSessions(scope),
				evaluations,
				programs: finalizePrograms(programs),
				models: frequencyRecord(models),
				operationGate: this.operationGate(scope),
				routes: this.routes(scope),
				supervision: this.supervision(scope),
				doubts: this.doubts(scope),
				unreadable: unreadable.rows,
			};
		}, "decision ledger report");
	}

	exportCases(scope: DecisionAnalysisScope, write: (replayCase: DecisionReplayCase) => void): number {
		return this.snapshot(() => {
			let written = 0;
			this.forEachEvaluation(scope, true, (row) => {
				const replayCase = replayCaseOf(row);
				if (replayCase === undefined) return;
				write(replayCase);
				written++;
			});
			return written;
		}, "decision ledger export");
	}

	private operationGate(scope: DecisionAnalysisScope): DecisionOperationGateReport {
		if (!this.has("operation_gate_decisions")) return { total: 0, actions: {}, sources: {}, notable: 0 };
		const { where, params } = scopeSql(scope, "cwd", "decided_at");
		const actions = new Map<string, number>();
		const sources = new Map<string, number>();
		const durations: number[] = [];
		let notable = 0;
		const total = this.page(
			`SELECT action, source, notable, duration_ms FROM operation_gate_decisions ${where} ORDER BY id`,
			params,
			(row) => {
				const action = asText(row.action);
				const source = asText(row.source);
				const durationMs = asInteger(row.duration_ms);
				if (action !== undefined) countInto(actions, action);
				if (source !== undefined) countInto(sources, source);
				if (asInteger(row.notable) === 1) notable++;
				if (durationMs !== undefined) durations.push(durationMs);
			},
		);
		const medianMs = median(durations);
		return {
			total,
			actions: frequencyRecord(actions),
			sources: frequencyRecord(sources),
			notable,
			...(medianMs !== undefined ? { medianMs } : {}),
		};
	}

	private routes(scope: DecisionAnalysisScope): DecisionRouteReport {
		if (!this.has("route_decisions")) return { total: 0, routes: {}, executors: {} };
		const { where, params } = scopeSql(scope, "cwd", "decided_at");
		const routes = new Map<string, number>();
		const executors = new Map<string, number>();
		const total = this.page(`SELECT route, executor FROM route_decisions ${where} ORDER BY id`, params, (row) => {
			const route = asText(row.route);
			if (route !== undefined) countInto(routes, route);
			countInto(executors, asText(row.executor) ?? "unassigned");
		});
		return { total, routes: frequencyRecord(routes), executors: frequencyRecord(executors) };
	}

	private supervision(scope: DecisionAnalysisScope): DecisionSupervisionReport {
		if (!this.has("supervision_actions")) return { total: 0, actions: {} };
		const { where, params } = scopeSql(scope, "cwd", "decided_at");
		const actions = new Map<string, number>();
		const total = this.page(
			`SELECT ${this.columnOrNull("supervision_actions", "action")} FROM supervision_actions ${where} ORDER BY id`,
			params,
			(row) => {
				const action = asText(row.action);
				if (action !== undefined) countInto(actions, action);
			},
		);
		return { total, actions: frequencyRecord(actions) };
	}

	private doubts(scope: DecisionAnalysisScope): Record<string, number> {
		if (!this.has("semantic_doubt_decisions") || !this.has("semantic_evaluations")) return {};
		const { where, params } = withProgram(scopeSql(scope, "e.cwd", "e.started_at"), scope, "e.program_id");
		const rows = this.database
			.prepare(
				`SELECT d.disposition AS disposition, COUNT(*) AS rows FROM semantic_doubt_decisions d
				 JOIN semantic_evaluations e ON e.session_id = d.session_id AND e.evaluation_id = d.evaluation_id
				 ${where} GROUP BY d.disposition`,
			)
			.all(...params);
		const dispositions = new Map<string, number>();
		for (const row of rows) {
			const disposition = asText(row.disposition);
			const count = asInteger(row.rows);
			if (disposition !== undefined && count !== undefined) dispositions.set(disposition, count);
		}
		return frequencyRecord(dispositions);
	}

	close(): void {
		this.database[Symbol.dispose]();
	}
}

interface MutableCounts {
	total: number;
	ok: number;
	failed: number;
	cancelled: number;
	unsettled: number;
}

interface ProgramAccumulator {
	total: number;
	ok: number;
	failed: number;
	cancelled: number;
	uncertain: number;
	cached: number;
	durations: number[];
	exits: Map<string, number>;
	verdicts: Map<string, number>;
}

function accumulateEvaluation(
	evaluations: MutableCounts,
	programs: Map<string, ProgramAccumulator>,
	models: Map<string, number>,
	unreadable: { rows: number },
	row: AnalyzedEvaluation,
): void {
	evaluations.total++;
	if (row.outcome === "ok") evaluations.ok++;
	else if (row.outcome === "failed") evaluations.failed++;
	else if (row.outcome === "cancelled") evaluations.cancelled++;
	else evaluations.unsettled++;
	countInto(models, row.model ?? "unknown");
	if (row.broken) unreadable.rows++;
	let program = programs.get(row.programId);
	if (program === undefined) {
		program = {
			total: 0,
			ok: 0,
			failed: 0,
			cancelled: 0,
			uncertain: 0,
			cached: 0,
			durations: [],
			exits: new Map(),
			verdicts: new Map(),
		};
		programs.set(row.programId, program);
	}
	program.total++;
	if (row.outcome === "ok") program.ok++;
	else if (row.outcome === "failed") program.failed++;
	else if (row.outcome === "cancelled") program.cancelled++;
	if (row.questions.some((state) => state.uncertain)) program.uncertain++;
	if (row.trace?.cached === true) program.cached++;
	if (row.verdict !== undefined) countInto(program.verdicts, row.verdict);
	if (row.trace?.exit !== undefined) countInto(program.exits, row.trace.exit);
	if (row.outcome !== undefined && row.endedAt !== undefined)
		program.durations.push(Math.max(0, row.endedAt - row.startedAt));
}

function finalizePrograms(programs: Map<string, ProgramAccumulator>): DecisionProgramReport[] {
	const out: DecisionProgramReport[] = [];
	for (const [programId, program] of programs) {
		const medianMs = median(program.durations);
		const p90Ms = percentile(program.durations, 90);
		out.push({
			programId,
			total: program.total,
			ok: program.ok,
			failed: program.failed,
			cancelled: program.cancelled,
			uncertain: program.uncertain,
			cached: program.cached,
			...(medianMs !== undefined ? { medianMs } : {}),
			...(p90Ms !== undefined ? { p90Ms } : {}),
			exits: frequencyRecord(program.exits),
			verdicts: trimVerdicts(program.verdicts),
		});
	}
	return out.sort((left, right) => right.total - left.total || left.programId.localeCompare(right.programId));
}

/** Every string of a value through System One's secret redaction; numbers, flags and the shape stay as they are. */
function redacted<T>(value: T): T {
	if (typeof value === "string") return redactSecrets(value) as T;
	if (Array.isArray(value)) return value.map((item) => redacted(item)) as T;
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redacted(item)])) as T;
}

/**
 * A case only when the row is complete: settled, ended, and every stored JSON column decoded. Its texts were redacted
 * when they were recorded where the recorder does that (the trace); a case leaves the ledger for a file, so every text
 * of it passes the redaction once more here.
 */
function replayCaseOf(row: AnalyzedEvaluation): DecisionReplayCase | undefined {
	if (row.outcome === undefined || row.endedAt === undefined || row.broken) return undefined;
	return redacted<DecisionReplayCase>({
		case: row.evaluationId,
		sessionId: row.sessionId,
		cwd: row.cwd,
		programId: row.programId,
		label: row.label,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		outcome: row.outcome,
		reasons: row.reasons,
		questions: row.questions,
		expected: null,
		...(row.consequence !== undefined ? { consequence: row.consequence } : {}),
		...(row.scope !== undefined ? { scope: row.scope } : {}),
		...(row.namespace !== undefined ? { namespace: row.namespace } : {}),
		...(row.model !== undefined ? { model: row.model } : {}),
		...(row.verdict !== undefined ? { verdict: row.verdict } : {}),
		...(row.trace !== undefined ? { trace: row.trace } : {}),
	});
}

/**
 * Opens the ledger for analysis. Returns undefined when the file does not exist; throws when its schema
 * version is not the one this build knows. The file is created by nothing here: a missing ledger is a
 * session that never wrote one, not an error.
 */
export function openDecisionLedgerAnalysis(databasePath: string): DecisionLedgerAnalysis | undefined {
	if (!existsSync(databasePath)) return undefined;
	const database = openSqliteDatabase({ databasePath, busyTimeoutMs: BUSY_TIMEOUT_MS });
	try {
		const row = database.prepare("SELECT value FROM ledger_meta WHERE key = 'schema_version'").get();
		const stored = asText(row?.value);
		if (stored === undefined || Number(stored) !== DECISION_LEDGER_SCHEMA_VERSION)
			throw new Error(
				`Decision ledger at ${databasePath} has schema version ${stored ?? "unknown"}, not ${DECISION_LEDGER_SCHEMA_VERSION}.`,
			);
		return new LedgerAnalysis(database, readLayout(database));
	} catch (error) {
		database[Symbol.dispose]();
		throw error;
	}
}
