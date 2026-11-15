/**
 * The pure rules a worker mailbox's messages are read by, wherever the mailbox is read: its owner
 * (`WorkerAgentMailbox`), bundle retention, and a bot bundle's move (`bot-bundle-workers.ts`), which reads the
 * mailbox files without opening the mailbox.
 */

/** The facts of one mailbox message the rules read. */
export interface WorkerMailboxMessageFacts {
	readonly deliveredAt?: string;
	readonly failedAt?: string;
	readonly expectReply?: boolean;
	readonly repliedAt?: string;
	readonly task?: { readonly kind: string };
}

/**
 * A mailbox owes work while any message is undelivered and unfailed, a delivered request still awaits
 * its reply, or a reply acknowledgement is mid-flight. Quiescence and bundle retention share this rule.
 */
export function workerMailboxHasOpenObligation(state: {
	readonly messages: readonly WorkerMailboxMessageFacts[];
	readonly replyAcknowledgements: readonly unknown[];
}): boolean {
	return (
		state.replyAcknowledgements.length > 0 ||
		state.messages.some(
			(message) =>
				(message.deliveredAt === undefined && message.failedAt === undefined) ||
				(message.deliveredAt !== undefined &&
					message.expectReply === true &&
					message.repliedAt === undefined &&
					message.failedAt === undefined),
		)
	);
}

/**
 * An executable intent that has not reached the durable transcript boundary: undelivered, unfailed, and carrying a
 * task other than a host event's. Its delivery opens its worker's transcript by the path the worker's records name.
 */
export function isPendingTaskBearingMessage(message: WorkerMailboxMessageFacts): boolean {
	return (
		message.deliveredAt === undefined &&
		message.failedAt === undefined &&
		message.task !== undefined &&
		message.task.kind !== "host_event"
	);
}
