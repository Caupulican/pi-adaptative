/**
 * The Decision graph's stage log: which loop stage the run is in, since when, and how long each stage
 * has taken over the objective, summed across repair loops.
 *
 * This is an observer, never a second state machine. `deriveDecisionStage` is a pure projection of
 * the operator projection the harness already publishes; `DecisionStageLog.observe` is called only
 * where a real projection change publishes, so the log cannot drift from what the POV bar showed.
 * Durability is a sink the session supplies (the SQLite decision ledger, keyed by session id and
 * never erased); the log rehydrates from it so timers continue across a restart.
 */

import type { OperatorProjection } from "./types.ts";

/** The loop the graph draws. `done` is terminal and outside the walk. */
export type DecisionStage =
	| "understand"
	| "plan"
	| "build"
	| "dispatch"
	| "observe"
	| "verify"
	| "clarify"
	| "repair"
	| "deliver"
	| "done";

/** Every stage, in loop order; renderers walk this array and nothing else fixes the order. */
export const DECISION_STAGE_ORDER: readonly DecisionStage[] = [
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
];

export interface DecisionStageEntry {
	readonly stage: DecisionStage;
	/** Epoch ms. */
	readonly enteredAt: number;
	/** Epoch ms; absent while this entry is the open one. */
	readonly endedAt?: number;
	/** Repair-pass number this entry belongs to; starts at 1 and increments on entry to `repair`. */
	readonly loop: number;
	/** The projection reason code this stage was derived from, verbatim. */
	readonly reasonCode?: string;
	/** `current_action` at entry, bounded; the pane's click-to-expand detail. */
	readonly note?: string;
}

export interface DecisionStageTotals {
	readonly elapsedMs: number;
	readonly passes: number;
}

export interface DecisionStageLogView {
	readonly entries: readonly DecisionStageEntry[];
	/** Complete for every stage, including entries the in-memory bound evicted. */
	readonly totals: Readonly<Record<DecisionStage, DecisionStageTotals>>;
	readonly loop: number;
	readonly open?: DecisionStageEntry;
}

/** What the log hands its sink when a stage opens. */
export interface DecisionStageSinkEntry extends Omit<DecisionStageEntry, "endedAt"> {
	readonly objectiveId: string;
}

/** What a sink hands back on load: the durable row id joins the entry. */
export interface DecisionStageStoredEntry extends DecisionStageSinkEntry {
	readonly rowId: number;
	readonly endedAt?: number;
}

/**
 * Durable storage for the log. `open` returns the row id `close` later settles. `load` returns every
 * entry of the session, oldest first; the log keeps the newest objective's entries in memory and the
 * sink keeps everything.
 */
export interface DecisionStageSink {
	open(entry: DecisionStageSinkEntry): number;
	close(rowId: number, endedAt: number): void;
	load(): readonly DecisionStageStoredEntry[];
	/** Moves an open row's start to `enteredAt`. The gap before a resume is not work. */
	reanchor?(rowId: number, enteredAt: number): void;
}

/**
 * Reason codes whose next transition is corrective work on something that already failed. Taken
 * verbatim from `GoalContinuationReasonCode`; `stall_limit_reached` is deliberately absent — its
 * action is `stop`, not corrective work.
 */
const REPAIR_REASON_CODES: ReadonlySet<string> = new Set([
	// System One's replan routes: the strategy repeated or the context went stale.
	"strategy_repetition_detected",
	"worker_context_stale",
	"replan_required",
	"verification_repair_required",
	"blocked_requirements_present",
	"lane_sync_conflict",
	"lane_sync_required",
	"worker_wait_timeout",
]);

/**
 * An idle session: the root owns control, is deciding nothing, and the projection sits on its
 * readiness phase. That is a session with no objective, or one whose objective is paused, limited or
 * cancelled, with no turn running. There is no loop, so there is no stage and no clock; an active
 * objective being framed has System One as owner and is not idle.
 */
export function isIdleProjection(projection: OperatorProjection): boolean {
	const { control } = projection;
	return control.owner === "root" && control.state === "deciding" && projection.phase === "understand";
}

/**
 * A row the placeholder projection wrote before idle sessions were excluded: `understand` opened at
 * session start with no objective. The ledger is append-only, so the rows stay; reads leave them out
 * so timers and replays do not carry a clock that measured nothing.
 */
export function isLegacyIdleStageRow(row: { stage: string; reasonCode?: string }): boolean {
	return row.stage === "understand" && row.reasonCode === "no_objective";
}

/**
 * The stage a projection is in. Evaluated in this order on purpose: a reviewable lane outranks a
 * verification reason code (reviewing a returned worker is the owner's stage, not repair), repair
 * outranks verify (`verification_repair_required` is in both sets), and a running worker while a red
 * obligation is open is still repair.
 */
export function deriveDecisionStage(projection: OperatorProjection): DecisionStage {
	const { phase, control } = projection;
	const reasonCode = control.reasonCode ?? "";
	if (phase === "done") return "done";
	if (control.owner === "user") return "clarify";
	if (control.state === "observing") return "observe";
	if (REPAIR_REASON_CODES.has(reasonCode)) return "repair";
	if (phase === "blocked") return "repair";
	if (phase === "deliver") return "deliver";
	if (phase === "verify" || control.state === "verifying") return "verify";
	if (projection.active_actors.some((actor) => actor.kind !== "root")) return "dispatch";
	if (phase === "plan") return "plan";
	if (phase === "understand") return "understand";
	// build and adapt: adaptation is runtime work inside the build step of the loop.
	return "build";
}

const MAX_STAGE_ENTRIES = 256;
const NOTE_LIMIT = 120;

function boundedNote(value: string): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= NOTE_LIMIT ? collapsed : `${collapsed.slice(0, NOTE_LIMIT - 1)}…`;
}

function emptyTotals(): Record<DecisionStage, { elapsedMs: number; passes: number }> {
	const totals = {} as Record<DecisionStage, { elapsedMs: number; passes: number }>;
	for (const stage of DECISION_STAGE_ORDER) totals[stage] = { elapsedMs: 0, passes: 0 };
	return totals;
}

interface LiveEntry extends DecisionStageEntry {
	readonly rowId?: number;
}

export interface DecisionStageLogOptions {
	/** Durable sink; absent for a process-local log (tests, sessions without a ledger). */
	readonly sink?: DecisionStageSink;
}

/**
 * Records the projection's stage transitions and their timing. Every mutation goes through
 * `observe` or `reset`; every read goes through `view`.
 */
export class DecisionStageLog {
	private entries: LiveEntry[] = [];
	private totals = emptyTotals();
	private loop = 1;
	private objectiveId?: string;
	private readonly sink?: DecisionStageSink;
	private sinkFailure?: string;
	/** An open row was loaded from the sink. Its clock restarts at the next read, so downtime is not counted. */
	private resumeClock = false;

	constructor(options: DecisionStageLogOptions = {}) {
		this.sink = options.sink;
		if (this.sink) this.rehydrate(this.sink);
	}

	/** Set when the sink threw; the in-memory log keeps working and the pane can say so. */
	getSinkFailure(): string | undefined {
		return this.sinkFailure;
	}

	/**
	 * Observes one published projection. Returns true when a new stage entry opened, so the caller
	 * can wake the elapsed ticker. Same stage as the open entry records nothing: the clock keeps
	 * running off `enteredAt`. An idle projection opens nothing and closes whatever was open: the
	 * loop is not running, so no stage is and no clock runs.
	 */
	observe(projection: OperatorProjection, now: number): boolean {
		this.anchorResumedClock(now);
		if (this.objectiveId !== undefined && this.objectiveId !== projection.objective_id)
			this.reset(projection.objective_id, now);
		this.objectiveId = projection.objective_id;
		const open = this.entries.at(-1);
		if (isIdleProjection(projection)) {
			if (open !== undefined && open.endedAt === undefined) this.closeOpen(now);
			return false;
		}
		const stage = deriveDecisionStage(projection);
		if (open !== undefined && open.endedAt === undefined && open.stage === stage) return false;
		if (open !== undefined && open.endedAt === undefined) this.closeOpen(now);
		if (stage === "repair" && open?.stage !== "repair") this.loop += 1;
		const entry: DecisionStageEntry = {
			stage,
			enteredAt: now,
			loop: this.loop,
			...(projection.control.reasonCode ? { reasonCode: projection.control.reasonCode } : {}),
			...(projection.current_action ? { note: boundedNote(projection.current_action) } : {}),
		};
		const rowId = this.persistOpen({ ...entry, objectiveId: projection.objective_id });
		this.pushEntry(rowId === undefined ? entry : { ...entry, rowId });
		return true;
	}

	/** A new objective is a new loop in memory; the sink keeps the old objective's rows forever. */
	reset(objectiveId: string, now: number): void {
		const open = this.entries.at(-1);
		if (open !== undefined && open.endedAt === undefined) this.closeOpen(now);
		this.entries = [];
		this.totals = emptyTotals();
		this.loop = 1;
		this.objectiveId = objectiveId;
	}

	view(now: number): DecisionStageLogView {
		this.anchorResumedClock(now);
		const open = this.entries.at(-1);
		const openEntry = open !== undefined && open.endedAt === undefined ? open : undefined;
		const totals = {} as Record<DecisionStage, DecisionStageTotals>;
		for (const stage of DECISION_STAGE_ORDER) {
			const base = this.totals[stage];
			const live = openEntry?.stage === stage ? Math.max(0, now - openEntry.enteredAt) : 0;
			totals[stage] = {
				elapsedMs: base.elapsedMs + live,
				passes: base.passes + (openEntry?.stage === stage ? 1 : 0),
			};
		}
		return { entries: this.entries, totals, loop: this.loop, ...(openEntry ? { open: openEntry } : {}) };
	}

	private closeOpen(now: number): void {
		const open = this.entries.at(-1);
		if (open === undefined || open.endedAt !== undefined) return;
		this.entries[this.entries.length - 1] = { ...open, endedAt: now };
		const total = this.totals[open.stage];
		total.elapsedMs += Math.max(0, now - open.enteredAt);
		total.passes += 1;
		if (open.rowId !== undefined) this.persistClose(open.rowId, now);
	}

	private pushEntry(entry: LiveEntry): void {
		this.entries.push(entry);
		// Evicted entries are already folded into `totals` when they closed, so the accumulated time
		// the pane shows never loses history to the bound.
		while (this.entries.length > MAX_STAGE_ENTRIES) this.entries.shift();
	}

	private persistOpen(entry: DecisionStageSinkEntry): number | undefined {
		if (!this.sink) return undefined;
		try {
			return this.sink.open(entry);
		} catch (error) {
			this.sinkFailure = error instanceof Error ? error.message : String(error);
			return undefined;
		}
	}

	private persistClose(rowId: number, endedAt: number): void {
		if (!this.sink) return;
		try {
			this.sink.close(rowId, endedAt);
		} catch (error) {
			this.sinkFailure = error instanceof Error ? error.message : String(error);
		}
	}

	/** Restarts a rehydrated open pass at `now` and persists that start. Closed passes stay. */
	private anchorResumedClock(now: number): void {
		if (!this.resumeClock) return;
		this.resumeClock = false;
		const index = this.entries.length - 1;
		const open = this.entries[index];
		if (open === undefined || open.endedAt !== undefined || open.enteredAt === now) return;
		this.entries[index] = { ...open, enteredAt: now };
		if (open.rowId !== undefined) this.persistReanchor(open.rowId, now);
	}

	private persistReanchor(rowId: number, enteredAt: number): void {
		if (!this.sink?.reanchor) return;
		try {
			this.sink.reanchor(rowId, enteredAt);
		} catch (error) {
			this.sinkFailure = error instanceof Error ? error.message : String(error);
		}
	}

	/**
	 * Replays the session's durable entries. Closed passes keep their durations. An open pass does
	 * not keep counting across the time the process was down: the next read restarts that clock.
	 * Only the newest objective's entries are live; earlier objectives stay in the sink.
	 */
	private rehydrate(sink: DecisionStageSink): void {
		let stored: readonly DecisionStageStoredEntry[];
		try {
			stored = sink.load();
		} catch (error) {
			this.sinkFailure = error instanceof Error ? error.message : String(error);
			return;
		}
		const last = stored.at(-1);
		if (last === undefined) return;
		this.objectiveId = last.objectiveId;
		for (const entry of stored) {
			if (entry.objectiveId !== last.objectiveId) continue;
			this.loop = Math.max(this.loop, entry.loop);
			const live: LiveEntry = {
				stage: entry.stage,
				enteredAt: entry.enteredAt,
				loop: entry.loop,
				rowId: entry.rowId,
				...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
				...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
				...(entry.note ? { note: entry.note } : {}),
			};
			this.pushEntry(live);
			if (entry.endedAt !== undefined) {
				const total = this.totals[entry.stage];
				total.elapsedMs += Math.max(0, entry.endedAt - entry.enteredAt);
				total.passes += 1;
			}
		}
		const open = this.entries.at(-1);
		this.resumeClock = open !== undefined && open.endedAt === undefined;
	}
}
