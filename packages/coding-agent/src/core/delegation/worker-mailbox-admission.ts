/**
 * What a worker attempt's admission of its mailbox messages records before the model reads them
 * (`WorkerAgentControlCoordinator.consumeHostEventMessages`, which every steer and follow-up a running attempt reads
 * passes): a third party's words a message carried taint the attempt, and the session is told which messages the attempt
 * read (`WorkerMailPort.messagesRead`), so a bot's reply a running turn reads continues its chain in that turn. Both are
 * recorded before the messages can be marked delivered, which happens only once the attempt's transcript holds them.
 */

import type { UserMessage } from "@caupulican/pi-ai";
import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import type { HostEventConsumingExecution } from "./worker-host-event-transport.ts";
import type { WorkerMailPort } from "./worker-mail-ledger.ts";

/** Mailbox identity and user content are kept separate from their transcript presentation. */
export interface WorkerMailboxConversationMessage {
	messageId: string;
	instructions: string;
	message: UserMessage;
	/** The third party's words the sender carried (`WorkerAgentMessage.turnOrigin`); admission records them. */
	turnOrigin?: TurnOriginRecord;
}

/** Records what the running attempt `execution` of `agentId` admitted: the third party's words, and what it read. */
export function recordMailboxAdmission(
	runtime: Pick<DurableTaskRuntime, "recordAttemptThirdPartyWords">,
	agentId: string,
	execution: HostEventConsumingExecution,
	admitted: readonly WorkerMailboxConversationMessage[],
	messagesRead: WorkerMailPort["messagesRead"],
): void {
	if (admitted.length === 0) return;
	// A steer or follow-up carrying a third party's words taints the running attempt before the model reads it.
	const thirdParty = admitted.find((candidate) => candidate.turnOrigin?.thirdParty)?.turnOrigin;
	if (thirdParty)
		runtime.recordAttemptThirdPartyWords(execution.attemptId, execution.leaseId, execution.fencingToken, thirdParty);
	messagesRead?.(
		agentId,
		execution.attemptId,
		admitted.map(({ messageId }) => messageId),
	);
}
