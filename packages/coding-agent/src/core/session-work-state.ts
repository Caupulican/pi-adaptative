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
	} else if (input.isSystemOneEvaluating) {
		phase = "system_one_evaluating";
		label = "System One evaluating";
	} else if (input.hasRunningWorker) {
		phase = "waiting_worker";
		label = "Worker in flight";
	} else if (input.hasRunningTool) {
		phase = "waiting_tool";
		label = "Tool executing";
	} else if (input.hasSubmissionLease || input.isRunActive) {
		phase = "foreground_preparing";
		label = "Preparing turn";
	} else if (input.hasPendingContinuation) {
		phase = "continuation_armed";
		label = "Continuation armed";
	} else if (input.isDone) {
		phase = "done";
		label = "Done";
	} else {
		phase = "idle";
		label = "Ready";
	}

	// Busy means any active execution or transition is pending; user must not start uncoordinated new turn.
	const busy = phase !== "idle" && phase !== "waiting_user" && phase !== "blocked" && phase !== "done";

	return {
		phase,
		busy,
		label,
		epoch: input.epoch,
		sessionId: input.sessionId,
		objectiveId: input.objectiveId,
		livenessFault: livenessFault || undefined,
		faultReason,
	};
}
