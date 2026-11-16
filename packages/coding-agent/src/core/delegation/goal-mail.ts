/**
 * A worker's mail to bots that answer in sessions of their own, as the session reads it from its store: the turn a
 * worker's words come from (`senderTurn`: its running attempt, the mailbox message that started it, and the goal it is
 * filed under), the mailbox key a bot's reply reaches that worker under (`botReplyMessageKey`), and whether a reply
 * handed to a worker can still reach a turn of it (`replyTurnOver`), which ends what the session keeps of the reply's hop
 * (`WorkerMailLedger`). Pure over the projection and what the worker's mailbox holds; the leader controller and the bot
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
 * Whether no turn of the worker reads the reply's hop any more: its worker is retired or gone; the turn its mailbox
 * message started (the attempt that message owns) has ended, whatever turn it joined before (a reply that joined a
 * running turn as a steer and was not read before that turn ended may start a turn of its own); or no turn of it runs (the
 * turn it joined, `attemptId`, has ended or there is none) and the worker's mailbox no longer holds the message unread
 * (`messagePending`, read only then): read, refused or forgotten, it starts and joins nothing more.
 */
export function replyTurnOver(
	snapshot: TaskRuntimeProjection,
	turn: ReplyTurn,
	messagePending: () => boolean,
): boolean {
	const agent = snapshot.agents[turn.worker];
	if (!agent || agent.status === "retired") return true;
	const started = Object.values(snapshot.attempts).find(
		(attempt) =>
			attempt.dispatch.logicalLaneId === turn.worker && attempt.dispatch.controlMessageId === turn.messageId,
	);
	if (started !== undefined) return !ACTIVE_ATTEMPT_STATUSES.has(started.status);
	const joined = turn.attemptId === undefined ? undefined : snapshot.attempts[turn.attemptId];
	if (joined !== undefined && ACTIVE_ATTEMPT_STATUSES.has(joined.status)) return false;
	return !messagePending();
}
