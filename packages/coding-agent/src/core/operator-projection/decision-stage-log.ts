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

/**
 * One stage over the whole objective: totals sum every visit, the details come from the LATEST visit.
 * Kept per stage by the log, independent of the in-memory entry bound, so a stage whose entries were
 * all evicted still has its row.
 */
export interface DecisionStageSummary {
	readonly stage: DecisionStage;
	/** Visits so far, the open one included. */
	readonly passes: number;
	/** Time spent across every visit, the open one's elapsed time included. */
	readonly elapsedMs: number;
	/** Repair-pass number of the latest visit. */
	readonly loop: number;
	/** Reason code of the latest visit. */
	readonly reasonCode?: string;
	/** `current_action` at the latest visit's entry, bounded. */
	readonly note?: string;
}

export interface DecisionStageLogView {
	/** The newest entries, bounded; evicted entries still count in `stages`. */
	readonly entries: readonly DecisionStageEntry[];
	/** Every stage the objective has entered, in the order first entered. Complete past the entry bound. */
	readonly stages: readonly DecisionStageSummary[];
	readonly loop: number;
	readonly open?: DecisionStageEntry;
	/** Set when the durable sink threw; the in-memory history is still shown, the stored one may be behind. */
	readonly sinkFailure?: string;
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

interface LiveEntry extends DecisionStageEntry {
	readonly rowId?: number;
}

/** A stage's running aggregate: closed visits summed, details of the latest visit. */
interface StageAggregate {
	passes: number;
	totalMs: number;
	loop: number;
	reasonCode: string | undefined;
	note: string | undefined;
}

export interface DecisionStageLogOptions {
	/** Durable sink; absent for a process-local log (tests, sessions without a ledger). */
	readonly sink?: DecisionStageSink;
	/**
	 * When an open row is loaded from the sink, its clock restarts at this instant and the start is
	 * persisted: the time the process was down is not work. Absent, the loaded row keeps its start.
	 */
	readonly resumeAt?: number;
}

/**
 * Records the projection's stage transitions and their timing. Every mutation goes through
 * `observe` or `reset` (rehydration happens once, in the constructor); every read goes through
 * `view`, which is pure: it never writes to the log or to the sink.
 */
export class DecisionStageLog {
	private entries: LiveEntry[] = [];
	/** Per stage, in the order first entered. Not bounded by `MAX_STAGE_ENTRIES`: one row per stage at most. */
	private aggregates = new Map<DecisionStage, StageAggregate>();
	private loop = 1;
	private objectiveId?: string;
	private readonly sink?: DecisionStageSink;
	private sinkFailure?: string;

	constructor(options: DecisionStageLogOptions = {}) {
		this.sink = options.sink;
		if (this.sink) this.rehydrate(this.sink, options.resumeAt);
	}

	/** Set when the sink threw; the in-memory log keeps working. The view carries it as `sinkFailure`. */
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
		this.aggregates = new Map();
		this.loop = 1;
		this.objectiveId = objectiveId;
	}

	view(now: number): DecisionStageLogView {
		const open = this.entries.at(-1);
		const openEntry = open !== undefined && open.endedAt === undefined ? open : undefined;
		const stages: DecisionStageSummary[] = [];
		for (const [stage, aggregate] of this.aggregates) {
			const live =
				openEntry !== undefined && openEntry.stage === stage ? Math.max(0, now - openEntry.enteredAt) : undefined;
			stages.push({
				stage,
				passes: aggregate.passes + (live !== undefined ? 1 : 0),
				elapsedMs: aggregate.totalMs + (live ?? 0),
				loop: aggregate.loop,
				...(aggregate.reasonCode ? { reasonCode: aggregate.reasonCode } : {}),
				...(aggregate.note ? { note: aggregate.note } : {}),
			});
		}
		return {
			entries: this.entries,
			stages,
			loop: this.loop,
			...(openEntry ? { open: openEntry } : {}),
			...(this.sinkFailure !== undefined ? { sinkFailure: this.sinkFailure } : {}),
		};
	}

	private closeOpen(now: number): void {
		const open = this.entries.at(-1);
		if (open === undefined || open.endedAt !== undefined) return;
		this.entries[this.entries.length - 1] = { ...open, endedAt: now };
		this.settle(open.stage, open.enteredAt, now);
		if (open.rowId !== undefined) this.persistClose(open.rowId, now);
	}

	private pushEntry(entry: LiveEntry): void {
		this.entries.push(entry);
		this.enter(entry);
		// An evicted entry has already been folded into its stage's aggregate (on entry for the details,
		// on close for the time), so the bound never removes a stage or its accumulated time.
		while (this.entries.length > MAX_STAGE_ENTRIES) this.entries.shift();
	}

	/** A visit starts: the stage gains its row if new and takes this visit's details as the latest. */
	private enter(entry: DecisionStageEntry): void {
		const aggregate = this.aggregates.get(entry.stage) ?? {
			passes: 0,
			totalMs: 0,
			loop: entry.loop,
			reasonCode: undefined,
			note: undefined,
		};
		aggregate.loop = entry.loop;
		aggregate.reasonCode = entry.reasonCode;
		aggregate.note = entry.note;
		this.aggregates.set(entry.stage, aggregate);
	}

	/** A visit ends: its duration and pass join the stage's totals. */
	private settle(stage: DecisionStage, enteredAt: number, endedAt: number): void {
		const aggregate = this.aggregates.get(stage);
		if (aggregate === undefined) return;
		aggregate.totalMs += Math.max(0, endedAt - enteredAt);
		aggregate.passes += 1;
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

	private persistReanchor(rowId: number, enteredAt: number): void {
		if (!this.sink?.reanchor) return;
		try {
			this.sink.reanchor(rowId, enteredAt);
		} catch (error) {
			this.sinkFailure = error instanceof Error ? error.message : String(error);
		}
	}

	/**
	 * Replays the session's durable entries, every one of the newest objective's regardless of the
	 * in-memory bound, so the per-stage aggregates are complete. Closed passes keep their durations.
	 * An open pass does not keep counting across the time the process was down: it restarts at
	 * `resumeAt` and that start is persisted. Earlier objectives stay in the sink.
	 */
	private rehydrate(sink: DecisionStageSink, resumeAt: number | undefined): void {
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
			if (entry.endedAt !== undefined) this.settle(entry.stage, entry.enteredAt, entry.endedAt);
		}
		const index = this.entries.length - 1;
		const open = this.entries[index];
		if (resumeAt === undefined || open === undefined || open.endedAt !== undefined || open.enteredAt === resumeAt)
			return;
		this.entries[index] = { ...open, enteredAt: resumeAt };
		if (open.rowId !== undefined) this.persistReanchor(open.rowId, resumeAt);
	}
}
