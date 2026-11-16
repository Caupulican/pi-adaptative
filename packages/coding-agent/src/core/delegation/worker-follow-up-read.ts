/**
 * The worker loop's read of its mailbox when it would stop (`getFollowUpMessages`): the parent's messages first, else the
 * host's request for a report, else nothing, and the loop ends. Ending is decided in one synchronous step with a last look
 * at the mailbox, and the attempt stops taking the host's notes right there (`WorkerHostTools.settle`): a note the host
 * queued while the read awaited the fitness check of the parent's messages is read in another pass, and one it sends after
 * the settle goes by the settled rule, so none is left in a mailbox the attempt no longer reads.
 */
import type { AgentMessage } from "../../kernel/index.ts";
import type { WorkerMailboxConversationMessage } from "./worker-agent-control-coordinator.ts";

/** The steps of one follow-up read, the executor's own. */
export interface WorkerFollowUpRead {
	/** The attempt's run: aborted, the read ends with its reason. */
	readonly signal: AbortSignal;
	/** The messages pending in the worker's mailbox for its conversation, follow-ups included; read synchronously. */
	read(): readonly WorkerMailboxConversationMessage[];
	/** Checks the parent's messages read against the task (their fitness) before any is taken. */
	check(messages: readonly WorkerMailboxConversationMessage[]): Promise<void>;
	/** The messages the loop takes of those read. */
	admit(messages: readonly WorkerMailboxConversationMessage[]): AgentMessage[];
	/** What the host asks of a worker about to stop (a checkable report); empty when it asks nothing. */
	report(): AgentMessage[];
	/** The attempt stopped reading its mailbox: the host's later notes no longer go to it. */
	settle(): void;
}

/** What the loop is given when it would stop; empty only once the mailbox held nothing new and the attempt settled. */
export async function readWorkerFollowUp(steps: WorkerFollowUpRead): Promise<AgentMessage[]> {
	const read = () => {
		steps.signal.throwIfAborted();
		return steps.read();
	};
	for (;;) {
		const messages = read();
		await steps.check(messages);
		steps.signal.throwIfAborted();
		const accepted = steps.admit(messages);
		// The parent's messages come first, then the host's request.
		if (accepted.length > 0) return accepted;
		const report = steps.report();
		if (report.length > 0) return report;
		// No await from this look to the settle. A message that arrived during the check is read in another pass; one read
		// and not taken stays as it was.
		const seen = new Set(messages.map((message) => message.messageId));
		if (read().some((message) => !seen.has(message.messageId))) continue;
		steps.settle();
		return [];
	}
}
