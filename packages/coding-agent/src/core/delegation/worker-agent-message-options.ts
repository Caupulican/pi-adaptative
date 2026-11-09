/**
 * The addressing options a sender passes when it writes into a worker's mailbox: a peer's message, a broadcast, and the
 * orchestrator's session-root message. They name who wrote the message (`senderAgentId`, or `fromLeader` when a leader's
 * words are sent on its behalf) and the host-only tags a model-facing tool never sets. `worker-agent-control.ts` re-exports
 * these types, so callers keep importing them from there.
 */
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";

export interface WorkerAgentMessageOptions {
	senderAgentId?: string;
	threadId?: string;
	expectReply?: boolean;
	/** Host-derived replay identity scoped to the caller, session, tool invocation, and action. */
	idempotencyKey?: string;
	/** Host-only, from the root path (see `SessionRootWorkerAgentMessageOptions`); never a model-facing field. */
	delegationObjectiveId?: string;
	/**
	 * Host-only: the live origin a host-driven write is admitted under, when its sender is not the one whose attempt
	 * is active (a leader's words, sent by the root session). Set only by the session-root path.
	 */
	receiptOrigin?: WorkerReceiptOrigin;
}

export interface WorkerAgentBroadcastOptions {
	senderAgentId?: string;
	threadId?: string;
	expectReply?: boolean;
	/** Call-level replay identity; the coordinator derives one stable identity per canonical target. */
	idempotencyKey: string;
}

export interface SessionRootWorkerAgentMessageOptions {
	threadId?: string;
	expectReply?: boolean;
	idempotencyKey?: string;
	/**
	 * Host-only: the orchestrator's words are for this delegation (its brief, update, resume or answer to the leader).
	 * A model-facing tool never sets it; an owner's chat leaves it out, so that turn is session work.
	 */
	delegationObjectiveId?: string;
	/**
	 * Host-only: the leader whose words these are, by its runtime agent id, when a leader sends them instead of the
	 * orchestrator (a nested goal's outcome or question to its parent, a parent's update to its child). The mailbox names
	 * that leader as the sender, so a reply routes back to it. Absent, the orchestrator is the sender.
	 */
	fromLeader?: string;
}

/** A send may not carry a reply reference: replies go through the dedicated inferred-destination reply control. */
export function rejectGenericReplyOptions(options: WorkerAgentMessageOptions): void {
	if ("replyToMessageId" in options) {
		throw new Error("Worker replies must use the dedicated inferred-destination reply control.");
	}
}
