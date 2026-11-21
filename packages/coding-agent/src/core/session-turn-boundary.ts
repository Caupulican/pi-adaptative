/**
 * The one boundary of a turn of a headless session (a persistent bot, a channel away), which everything its host counts
 * per turn reads: the time bound, the dollar bound, the spend and outcome a turn reports and a bot turn's supervision. A turn begins at a run start that is not an automatic retry's
 * and ends at the run end no retry follows: an `agent_end` that announces none, or a retry window that closed failed
 * (`auto_retry_end`, an attempt cut during its backoff included). A run end that announced a retry that never began and
 * closed no window (no attempt was prepared) emits nothing more: the turn it ended is ended by the next run start that is
 * not a retry's, before that start begins its own, so two turns never merge.
 *
 * A run that ends because the model saved a self-compaction note (self_compact) is the first part of its turn: the
 * session compacts and the handoff's own run continues the same turn, so the turn holds the compaction and that run.
 * A run end the handoff will not continue (an interrupted run, a session awaiting the owner) ends the turn. A held turn
 * ends once the foreground is idle with no handoff checkpoint scheduled, the fact the run's end decides (it schedules
 * the checkpoint unless the run was aborted): the run's submission ended without one, or the checkpoint finished without
 * starting the handoff's run (its compaction failed, the note was released). It also ends at the next run start that is
 * not the handoff's own.
 */

import type { AgentSession } from "./agent-session.ts";
import { isInterruptedAssistantStopReason } from "./agent-session-contracts.ts";
import { stopPersistedGoalFromSystem } from "./goals/goal-lifecycle.ts";

export interface SessionTurnObserver {
	/** A turn began. */
	started(): void;
	/** The turn that began last ended; called once per turn. */
	ended(): void;
}

/** Observes the turns of `session`; returns the unsubscribe. */
export function observeSessionTurns(
	session: Pick<AgentSession, "subscribe" | "selfCompactionHandoff" | "nativeActivity">,
	observer: SessionTurnObserver,
): () => void {
	// An automatic retry announced its attempt: the run it starts continues the same turn.
	let retrying = false;
	// The run ended to compact the context and the self-compaction handoff continues the turn.
	let held = false;
	let open = false;
	const handoff = session.selfCompactionHandoff;
	const end = () => {
		held = false;
		if (!open) return;
		open = false;
		observer.ended();
	};
	const unsubscribeEvents = session.subscribe((event) => {
		if (event.type === "agent_start") {
			if (!retrying && !(held && handoff.state().hosting)) {
				end();
				open = true;
				observer.started();
			}
			retrying = false;
			held = false;
		} else if (event.type === "auto_retry_start") retrying = true;
		else if (event.type === "auto_retry_end" && !event.success) {
			retrying = false;
			end();
		} else if (event.type === "agent_end" && !event.willRetry) {
			retrying = false;
			const last = event.messages.findLast((message) => message.role === "assistant");
			const interrupted = last?.role === "assistant" && isInterruptedAssistantStopReason(last.stopReason);
			if (open && !interrupted && handoff.state().continues) held = true;
			else end();
		}
	});
	const { foreground, subscribePendingContinuation } = session.nativeActivity;
	const settle = () => {
		if (held && !foreground.isBusy && !handoff.state().scheduled) end();
	};
	const unsubscribeHandoff = subscribePendingContinuation(settle);
	const unsubscribeForeground = foreground.subscribeActivity(settle);
	return () => {
		unsubscribeEvents();
		unsubscribeHandoff();
		unsubscribeForeground();
	};
}

/** A stop of a turn from outside its model: at a bound of the session's, or by its supervision. */
export interface SessionTurnStop {
	/** The owner-facing reason the run is aborted with. */
	readonly reason: string;
	/** The reason the goal the turn served is held with: a `HELD_GOAL_STOP_PREFIXES` prefix, then English for the model. */
	readonly goalHold: string;
}

/**
 * Stops the turn at a bound: the goal it served is held first (a running goal is stopped from the system, blocked with
 * `stop.goalHold`), its self-compaction handoff ends (the saved note is released), then the run is aborted with
 * `stop.reason`, so the stop is not a pause a later run of any origin continues under a fresh budget. An aborted turn arms
 * no continuation, so the hold is what keeps the goal from being left running with nothing to continue it: the owner's
 * next words resume it. A hold that does not save is told through `holdFailed`; the turn is stopped either way.
 */
export function stopSessionTurn(
	session: Pick<AgentSession, "abort" | "selfCompactionHandoff" | "getGoalStateSnapshot" | "saveGoalStateSnapshot">,
	stop: SessionTurnStop,
	holdFailed: (error: unknown) => void,
): Promise<void> {
	try {
		stopPersistedGoalFromSystem(session, { status: "blocked", reason: stop.goalHold });
	} catch (error) {
		holdFailed(error);
	}
	session.selfCompactionHandoff.stop(stop.reason);
	return session.abort(stop.reason, { ordinaryWork: "hold" });
}
