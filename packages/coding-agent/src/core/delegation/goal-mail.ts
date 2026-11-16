/**
 * A worker's mail to bots that answer in sessions of their own, as the session reads it from its store: the turn a
 * worker's words come from (`senderTurn`: its running attempt, the mailbox message that started it, and the goal it is
 * filed under), the mailbox key a bot's reply reaches that worker under (`botReplyMessageKey`), and whether the worker
 * turn a reply started or joined is over (`replyTurnOver`), which ends what the session keeps of the reply's hop
 * (`WorkerMailLedger`). Pure over the projection; the leader controller and the bot messaging directory decide with these.
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
 * Whether the worker turn a reply started (the attempt its mailbox message owns) or joined (`attemptId`) has ended, or
 * its worker is retired or gone: no mail of that turn reads the reply's hop any more. A reply whose message has started
 * no turn yet is not over.
 */
export function replyTurnOver(snapshot: TaskRuntimeProjection, turn: ReplyTurn): boolean {
	const agent = snapshot.agents[turn.worker];
	if (!agent || agent.status === "retired") return true;
	if (turn.attemptId !== undefined) {
		const joined = snapshot.attempts[turn.attemptId];
		return !joined || !ACTIVE_ATTEMPT_STATUSES.has(joined.status);
	}
	const started = Object.values(snapshot.attempts).find(
		(attempt) =>
			attempt.dispatch.logicalLaneId === turn.worker && attempt.dispatch.controlMessageId === turn.messageId,
	);
	return started !== undefined && !ACTIVE_ATTEMPT_STATUSES.has(started.status);
}
