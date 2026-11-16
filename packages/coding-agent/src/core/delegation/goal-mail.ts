/**
 * A worker's mail to bots that answer in sessions of their own, as the session reads it from its store: the turn a
 * worker's words come from (`senderTurn`: its running attempt, the mailbox message that started it, and the goal it is
 * filed under), the mailbox key a bot's reply reaches that worker under (`botReplyMessageKey`), and whether a turn of the
 * worker still reads, or can yet read, a reply handed to it (`replyTurnOver`), which ends what the session keeps of the
 * reply's hop (`WorkerMailLedger`). Pure over the projection and what the worker's mailbox holds; the leader controller and the bot
 * messaging directory decide with these.
 */

import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { ACTIVE_ATTEMPT_STATUSES, attemptDelegationObjectiveId } from "./delegation-spend.ts";
import type { ReplyTurn, WorkerMailTurn } from "./worker-mail-ledger.ts";

/** The running turn of a worker: its attempt, the mailbox message that started it, and the leader goal it is filed under. */
export interface SenderTurn extends WorkerMailTurn {
	readonly objectiveId?: string;
}

/** The turn `senderAgentId` runs now: its active attempt; undefined when it runs none. */
export function senderTurn(snapshot: TaskRuntimeProjection, senderAgentId: string): SenderTurn | undefined {
	const activeAttemptId = snapshot.agents[senderAgentId]?.activeAttemptId;
	const attempt = activeAttemptId === undefined ? undefined : snapshot.attempts[activeAttemptId];
	if (!attempt) return undefined;
	const objectiveId = attemptDelegationObjectiveId(attempt, snapshot);
	const { controlMessageId } = attempt.dispatch;
	return {
		attemptId: attempt.attemptId,
		...(controlMessageId !== undefined ? { controlMessageId } : {}),
		...(objectiveId !== undefined ? { objectiveId } : {}),
	};
}

/** The mail id a reply answers: `reply:<mail id>`. */
export function mailIdOfReply(replyId: string): string {
	return replyId.startsWith("reply:") ? replyId.slice("reply:".length) : replyId;
}

/** The key a bot's reply `replyId` is written into the mailbox of the worker that mailed it under, once. */
export function botReplyMessageKey(replyId: string): string {
	return `bot-reply:${replyId}`;
}

/**
 * Whether no turn of the worker reads the reply's hop any more, nor can: its worker is retired or gone, or neither the
 * turn its mailbox message started (an attempt whose dispatch that message is) nor the attempt that read it into its
 * turn (`attemptId`, recorded when read) runs, and the worker's mailbox no longer holds the message unread
 * (`messagePending`, read only then): read, refused or forgotten, no turn takes it any more. A message one attempt read
 * and did not see marked delivered stays unread, so a turn that reads it later, or that it starts, still holds the hop.
 */
export function replyTurnOver(
	snapshot: TaskRuntimeProjection,
	turn: ReplyTurn,
	messagePending: () => boolean,
): boolean {
	const agent = snapshot.agents[turn.worker];
	if (!agent || agent.status === "retired") return true;
	const startedRuns = Object.values(snapshot.attempts).some(
		(attempt) =>
			attempt.dispatch.logicalLaneId === turn.worker &&
			attempt.dispatch.controlMessageId === turn.messageId &&
			ACTIVE_ATTEMPT_STATUSES.has(attempt.status),
	);
	if (startedRuns) return false;
	const read = turn.attemptId === undefined ? undefined : snapshot.attempts[turn.attemptId];
	if (read !== undefined && ACTIVE_ATTEMPT_STATUSES.has(read.status)) return false;
	return !messagePending();
}
