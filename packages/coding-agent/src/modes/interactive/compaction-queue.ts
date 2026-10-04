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
 */

import type { ImageContent } from "@caupulican/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";

export type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp";
	images?: ImageContent[];
};

export interface CompactionQueueHost {
	compactionQueuedMessages: CompactionQueuedMessage[];
	readonly session: Pick<AgentSession, "prompt">;
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
	accepted: (message: CompactionQueuedMessage) => void,
): Promise<void> {
	// The session reports acceptance (queued, or its own turn starting) before the turn it starts ends.
	const preflightResult = (success: boolean) => {
		if (success) accepted(message);
	};
	if (host.isExtensionCommand(message.text)) {
		await host.session.prompt(message.text, { preflightResult });
	} else {
		await host.session.prompt(message.text, {
			images: message.images,
			streamingBehavior: message.mode,
			preflightResult,
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
	const accepted = (message: CompactionQueuedMessage) => {
		notAccepted.delete(message);
		// A submission still in flight when the batch failed can be accepted after its message was returned.
		if (failed && host.compactionQueuedMessages.includes(message)) {
			host.compactionQueuedMessages = host.compactionQueuedMessages.filter((candidate) => candidate !== message);
			host.updatePendingMessagesDisplay();
		}
	};
	const restoreQueue = (error: unknown) => {
		failed = true;
		const returned = queuedMessages.filter((message) => notAccepted.has(message));
		host.compactionQueuedMessages = [...returned, ...host.compactionQueuedMessages];
		host.updatePendingMessagesDisplay();
		const detail = error instanceof Error ? error.message : String(error);
		host.showError(
			returned.length === 0
				? `A queued message failed after it was accepted: ${detail}`
				: `Failed to send ${returned.length} queued message${returned.length === 1 ? "" : "s"}; ${returned.length === 1 ? "it is" : "they are"} back in the queue: ${detail}`,
		);
	};

	try {
		if (options?.willRetry) {
			// When retry is pending, queue messages for the retry turn
			for (const message of queuedMessages) {
				if (failed) return;
				await submitQueuedMessage(host, message, accepted);
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
				await submitQueuedMessage(host, message, accepted);
			}
			return;
		}

		// Execute any extension commands before the first prompt
		const preCommands = queuedMessages.slice(0, firstPromptIndex);
		const firstPrompt = queuedMessages[firstPromptIndex];
		const rest = queuedMessages.slice(firstPromptIndex + 1);

		for (const message of preCommands) {
			if (failed) return;
			await submitQueuedMessage(host, message, accepted);
		}

		// Send the first prompt (starts streaming). Compaction can end while the foreground is still
		// owned by a recovery round or by the compaction itself; the message then queues with its own
		// steering/follow-up mode instead of failing as busy.
		const promptPromise = submitQueuedMessage(host, firstPrompt, accepted)
			.catch((error) => {
				restoreQueue(error);
			})
			.finally(() => {
				host.refreshAutonomyFooterStatus();
			});

		// Queue remaining messages
		for (const message of rest) {
			if (failed) return;
			await submitQueuedMessage(host, message, accepted);
		}
		host.updatePendingMessagesDisplay();
		void promptPromise;
	} catch (error) {
		restoreQueue(error);
	}
}
