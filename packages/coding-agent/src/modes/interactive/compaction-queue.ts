/**
 * Compaction-queue flushing extracted from interactive-mode.
 *
 * When auto-compaction runs while the user has queued follow-up/steer messages,
 * `flushCompactionQueue` drains that queue after compaction settles — sending the
 * first non-command message as the resuming prompt, replaying steer/follow-up
 * modes for the rest, executing extension commands inline, and restoring the
 * queue on failure. It mutates the queue through a `CompactionQueueHost` seam
 * (`compactionQueuedMessages` via get/set); interactive-mode keeps a thin wrapper
 * (retained on the prototype for the compaction_end event handler).
 *
 * Each queued message is kept by the session from the moment it is queued (`AgentSession.keepQueuedInput`): held pending
 * input in its durable record, shown and takeable through the session's queue, and restored held after a restart. Its
 * submission sends that kept input (`heldInput`); a message the session never accepted is kept again when it returns.
 */

import type { ImageContent } from "@caupulican/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";
import type { OwnerInputEnd } from "../../core/owner-input-ledger.ts";
import type { PendingInputHandle } from "../../core/pending-input-queue-controller.ts";

export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
	images?: ImageContent[];
	/** The session's kept input for this message, replaced when the message is kept again. */
	input: PendingInputHandle;
};

export interface CompactionQueueHost {
	compactionQueuedMessages: CompactionQueuedMessage[];
	readonly session: Pick<AgentSession, "prompt" | "keepQueuedInput">;
	updatePendingMessagesDisplay(): void;
	showError(message: string): void;
	isExtensionCommand(text: string): boolean;
	refreshAutonomyFooterStatus(): void;
}

/**
 * Every queued message is submitted the way the editor submits one while work is live: through
 * `prompt()` with its queue mode. `prompt()` queues the message when the session is busy and runs it
 * as its own turn when it is not, so the decision never rests on `isStreaming`, which is false while
 * compaction or a recovery round still owns the foreground.
 */
async function submitQueuedMessage(
	host: CompactionQueueHost,
	message: CompactionQueuedMessage,
	settled: (message: CompactionQueuedMessage, accepted: boolean) => void,
): Promise<void> {
	// The session reports acceptance (queued, or its own turn starting) before the turn it starts ends. An input the session
	// ended itself, visibly (held in its queue, taken back by the owner, or cancelled by an interrupt with its full text
	// shown), is the session's too: returning it here would show it twice. Only a refused input was never the session's.
	const preflightResult = (success: boolean, ended?: OwnerInputEnd) =>
		settled(message, success || (ended !== undefined && ended.state !== "refused"));
	if (host.isExtensionCommand(message.text)) {
		await host.session.prompt(message.text, { preflightResult, heldInput: message.input });
	} else {
		await host.session.prompt(message.text, {
			images: message.images,
			streamingBehavior: message.mode,
			preflightResult,
			heldInput: message.input,
		});
	}
}

export async function flushCompactionQueue(
	host: CompactionQueueHost,
	options?: { willRetry?: boolean },
): Promise<void> {
	if (host.compactionQueuedMessages.length === 0) {
		return;
	}

	const queuedMessages = [...host.compactionQueuedMessages];
	host.compactionQueuedMessages = [];
	host.updatePendingMessagesDisplay();

	// Once a submission has failed nothing after it is submitted. What the session accepted stays with the
	// session (queued or running there); only the messages it never accepted return to the queue, in their
	// original order. The session's own queue is never cleared: it holds input that is not this batch's.
	let failed = false;
	const notAccepted = new Set(queuedMessages);
	// Submitted, its verdict not yet given: its kept input is the submission's, so it is kept again only once refused.
	const inFlight = new Set<CompactionQueuedMessage>();
	const keepAgain = (message: CompactionQueuedMessage) => {
		message.input = host.session.keepQueuedInput(message.mode, message.text, message.images, message.input);
	};
	const submit = (message: CompactionQueuedMessage) => {
		inFlight.add(message);
		return submitQueuedMessage(host, message, settled);
	};
	const settled = (message: CompactionQueuedMessage, accepted: boolean) => {
		inFlight.delete(message);
		const returned = failed && host.compactionQueuedMessages.includes(message);
		if (!accepted) {
			// Refused after the batch failed and its message was returned: the session keeps it again with the rest.
			if (returned) keepAgain(message);
			return;
		}
		notAccepted.delete(message);
		// A submission still in flight when the batch failed can be accepted after its message was returned.
		if (returned) {
			host.compactionQueuedMessages = host.compactionQueuedMessages.filter((candidate) => candidate !== message);
			host.updatePendingMessagesDisplay();
		}
	};
	const restoreQueue = (error: unknown) => {
		failed = true;
		const unsent = queuedMessages.filter((message) => notAccepted.has(message));
		// A second failure (a submission in flight when the first one failed) returns only what is not back already.
		const returned = unsent.filter((message) => !host.compactionQueuedMessages.includes(message));
		for (const message of returned) if (!inFlight.has(message)) keepAgain(message);
		host.compactionQueuedMessages = [...returned, ...host.compactionQueuedMessages];
		host.updatePendingMessagesDisplay();
		const detail = error instanceof Error ? error.message : String(error);
		host.showError(
			unsent.length === 0
				? `A queued message failed after it was accepted: ${detail}`
				: returned.length === 0
					? `A queued message failed; it is back in the queue: ${detail}`
					: `Failed to send ${returned.length} queued message${returned.length === 1 ? "" : "s"}; ${returned.length === 1 ? "it is" : "they are"} back in the queue: ${detail}`,
		);
	};

	try {
		if (options?.willRetry) {
			// When retry is pending, queue messages for the retry turn
			for (const message of queuedMessages) {
				if (failed) return;
				await submit(message);
			}
			host.updatePendingMessagesDisplay();
			return;
		}

		// Find first non-extension-command message to use as prompt
		const firstPromptIndex = queuedMessages.findIndex((message) => !host.isExtensionCommand(message.text));
		if (firstPromptIndex === -1) {
			// All extension commands - execute them all
			for (const message of queuedMessages) {
				if (failed) return;
				await submit(message);
			}
			return;
		}

		// Execute any extension commands before the first prompt
		const preCommands = queuedMessages.slice(0, firstPromptIndex);
		const firstPrompt = queuedMessages[firstPromptIndex];
		const rest = queuedMessages.slice(firstPromptIndex + 1);

		for (const message of preCommands) {
			if (failed) return;
			await submit(message);
		}

		// Send the first prompt (starts streaming). Compaction can end while the foreground is still
		// owned by a recovery round or by the compaction itself; the message then queues with its own
		// steering/follow-up mode instead of failing as busy.
		const promptPromise = submit(firstPrompt)
			.catch((error) => {
				restoreQueue(error);
			})
			.finally(() => {
				host.refreshAutonomyFooterStatus();
			});

		// Queue remaining messages
		for (const message of rest) {
			if (failed) return;
			await submit(message);
		}
		host.updatePendingMessagesDisplay();
		void promptPromise;
	} catch (error) {
		restoreQueue(error);
	}
}
