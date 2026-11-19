/**
 * Canonical session work state projection and predicates.
 * Single source of truth consumed by:
 * - Editor submission routing (steering vs follow-up vs idle turn)
 * - TUI live row and POV bar
 * - Session settlement and continuation scheduler
 * - Working loader
 */

export type CanonicalWorkPhase =
	| "idle"
	| "foreground_preparing"
	| "llm_streaming"
	| "retrying"
	| "system_one_evaluating"
	| "waiting_worker"
	| "waiting_tool"
	| "compacting"
	| "waiting_user"
	| "continuation_armed"
	| "blocked"
	| "done";

export interface SessionWorkStateInput {
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly isRetrying: boolean;
	readonly hasSubmissionLease: boolean;
	readonly isRunActive: boolean;
	readonly isSystemOneEvaluating?: boolean;
	readonly isSemanticEvaluating?: boolean;
	readonly hasRunningWorker?: boolean;
	readonly hasRunningTool?: boolean;
	readonly hasPendingContinuation?: boolean;
	readonly isAwaitingUser?: boolean;
	readonly isBlocked?: boolean;
	readonly isDone?: boolean;
	readonly livenessFault?: boolean;
	readonly epoch?: number;
	readonly sessionId?: string;
	readonly objectiveId?: string;
}

export interface SessionWorkState {
	readonly phase: CanonicalWorkPhase;
	readonly busy: boolean;
	readonly foregroundBusy: boolean;
	readonly label: string;
	readonly epoch?: number;
	readonly sessionId?: string;
	readonly objectiveId?: string;
	readonly livenessFault?: boolean;
	readonly faultReason?: string;
}

/**
 * Derives the canonical work phase and busy status from live runtime signals.
 * Order of precedence guarantees truthful reporting without invisible work or false idle.
 */
export function deriveSessionWorkState(input: SessionWorkStateInput): SessionWorkState {
	let phase: CanonicalWorkPhase = "idle";
	let label = "Ready";
	const livenessFault = Boolean(input.livenessFault);
	let faultReason: string | undefined;

	if (input.isAwaitingUser) {
		phase = "waiting_user";
		label = "Awaiting operator input";
	} else if (input.isBlocked || livenessFault) {
		phase = "blocked";
		label = livenessFault ? "Blocked: liveness fault" : "Blocked";
		if (livenessFault) {
			faultReason = "Active objective has no active owner, worker, evaluation, or continuation";
		}
	} else if (input.isCompacting) {
		phase = "compacting";
		label = "Compacting context";
	} else if (input.isRetrying) {
		phase = "retrying";
		label = "Retrying";
	} else if (input.isStreaming) {
		phase = "llm_streaming";
		label = "Streaming response";
	} else if (input.isSystemOneEvaluating || input.isSemanticEvaluating) {
		phase = "system_one_evaluating";
		label = "System One evaluating";
	} else if (input.hasSubmissionLease || input.isRunActive) {
		phase = "foreground_preparing";
		label = "Preparing turn";
	} else if (input.hasPendingContinuation) {
		phase = "continuation_armed";
		label = "Continuation armed";
	} else if (input.hasRunningWorker) {
		phase = "waiting_worker";
		label = "Worker in flight";
	} else if (input.hasRunningTool) {
		phase = "waiting_tool";
		label = "Tool executing";
	} else if (input.isDone) {
		phase = "done";
		label = "Done";
	} else {
		phase = "idle";
		label = "Ready";
	}

	// Busy means any active execution or transition is pending; user must not start uncoordinated new turn.
	const busy = phase !== "idle" && phase !== "waiting_user" && phase !== "blocked" && phase !== "done";

	const foregroundBusy =
		!input.isAwaitingUser &&
		!input.isBlocked &&
		!livenessFault &&
		!input.isDone &&
		Boolean(
			input.isCompacting ||
				input.isRetrying ||
				input.isStreaming ||
				input.isSystemOneEvaluating ||
				input.isSemanticEvaluating ||
				input.hasSubmissionLease ||
				input.isRunActive ||
				input.hasPendingContinuation,
		);

	return {
		phase,
		busy,
		foregroundBusy,
		label,
		epoch: input.epoch,
		sessionId: input.sessionId,
		objectiveId: input.objectiveId,
		livenessFault: livenessFault || undefined,
		faultReason,
	};
}

/**
 * What the session's worker lanes hold beside its phase, which counts every lane in flight (a worker waiting for its retry
 * included) and ranks a pending human input or a blocked goal before them: what a host that may close an idle session reads.
 */
export interface SessionWorkerFacts {
	/** A worker attempt holds a lease or runs, or a lane with no attempt of its own (research, review) is queued or running. */
	readonly hasRunningWorker: boolean;
	/** Busy as derived with no worker lane in flight: the foreground, a tool, an evaluation or a continuation holds it. */
	readonly busyBesideWorkers: boolean;
	/** The lanes in flight: none, only worker attempts suspended until a retry (`until`, the earliest), or any other work. */
	readonly workerLanes:
		| { readonly kind: "none" }
		| { readonly kind: "retries"; readonly until: number }
		| { readonly kind: "active" };
}

/** The work state of a session with the facts of its worker lanes. */
export type SessionWorkerState = SessionWorkState & SessionWorkerFacts;

/** Whether the only lanes in flight are worker retries none of which comes due by `atMs`; true when no lane is in flight. */
export function onlyWorkerRetriesWaitBeyond(state: Pick<SessionWorkerFacts, "workerLanes">, atMs: number): boolean {
	const lanes = state.workerLanes;
	return lanes.kind === "none" || (lanes.kind === "retries" && lanes.until > atMs);
}
