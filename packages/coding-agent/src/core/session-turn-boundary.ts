/**
 * The one boundary of a turn of a headless session (a persistent bot, a channel away), which everything its host counts
 * per turn reads: the time bound, the dollar bound, the spend and outcome a turn reports and a bot turn's supervision. A turn begins at a run start that is not an automatic retry's
 * and ends at the run end no retry follows: an `agent_end` that announces none, or a retry window that closed failed
 * (`auto_retry_end`, an attempt cut during its backoff included). A run end that announced a retry that never began and
 * closed no window (no attempt was prepared) emits nothing more: the turn it ended is ended by the next run start that is
 * not a retry's, before that start begins its own, so two turns never merge.
 */

import type { AgentSession } from "./agent-session.ts";

export interface SessionTurnObserver {
	/** A turn began. */
	started(): void;
	/** The turn that began last ended; called once per turn. */
	ended(): void;
}

/** Observes the turns of `session`; returns the unsubscribe. */
export function observeSessionTurns(
	session: Pick<AgentSession, "subscribe">,
	observer: SessionTurnObserver,
): () => void {
	// An automatic retry announced its attempt: the run it starts continues the same turn.
	let retrying = false;
	let open = false;
	const end = () => {
		if (!open) return;
		open = false;
		observer.ended();
	};
	return session.subscribe((event) => {
		if (event.type === "agent_start") {
			if (!retrying) {
				end();
				open = true;
				observer.started();
			}
			retrying = false;
		} else if (event.type === "auto_retry_start") retrying = true;
		else if (
			(event.type === "auto_retry_end" && !event.success) ||
			(event.type === "agent_end" && !event.willRetry)
		) {
			retrying = false;
			end();
		}
	});
}
