/**
 * A leader goal's mail to bots that answer in sessions of their own: the turn of a goal a worker's words come from
 * (`senderGoalTurn`), the mailbox key a bot's reply reaches that worker under (`botReplyMessageKey`), and the hop a mail
 * sent in such a turn carries (`goalMailHop`): one past the reply that started the turn, so the chain a goal's worker
 * and a bot mail each other through stays bounded as the bots' own mail is. Pure over the projection and the goal's
 * mail record (`DelegationRecord.mails`); the leader controller and the bot messaging directory decide with these.
 */

import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { attemptDelegationObjectiveId } from "./delegation-spend.ts";
import type { DelegationMail } from "./leader-delegation-ledger.ts";
import { workerAgentMessageId } from "./worker-agent-control.ts";

/** The running turn of a worker that a leader goal filed, and the mailbox message that started it, when one did. */
export interface SenderGoalTurn {
	readonly objectiveId: string;
	readonly controlMessageId?: string;
}

/** The goal turn `senderAgentId` runs now: its active attempt, when that attempt is filed under a leader goal. */
export function senderGoalTurn(snapshot: TaskRuntimeProjection, senderAgentId: string): SenderGoalTurn | undefined {
	const activeAttemptId = snapshot.agents[senderAgentId]?.activeAttemptId;
	const attempt = activeAttemptId === undefined ? undefined : snapshot.attempts[activeAttemptId];
	const objectiveId = attempt ? attemptDelegationObjectiveId(attempt, snapshot) : undefined;
	if (!attempt || objectiveId === undefined) return undefined;
	const { controlMessageId } = attempt.dispatch;
	return { objectiveId, ...(controlMessageId !== undefined ? { controlMessageId } : {}) };
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
 * The hop of a mail `worker` sends in the goal turn `turn`: one past the reply that started that turn (an answered mail
 * of the same worker, whose reply's mailbox message is the turn's `controlMessageId`), else 1, a chain of its own.
 */
export function goalMailHop(
	mails: readonly DelegationMail[],
	sessionId: string,
	worker: string,
	turn: SenderGoalTurn,
): number {
	if (turn.controlMessageId === undefined) return 1;
	const answered = mails.find(
		(mail) =>
			mail.worker === worker &&
			mail.end?.how === "answered" &&
			workerAgentMessageId(sessionId, botReplyMessageKey(`reply:${mail.mailId}`)) === turn.controlMessageId,
	);
	return answered?.end ? (answered.end.replyHop ?? answered.hop + 1) + 1 : 1;
}
