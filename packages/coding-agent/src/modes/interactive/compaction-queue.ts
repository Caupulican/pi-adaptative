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
	readonly session: Pick<AgentSession, "isStreaming" | "prompt" | "followUp" | "steer" | "clearQueue">;
	updatePendingMessagesDisplay(): void;
	showError(message: string): void;
	isExtensionCommand(text: string): boolean;
	refreshAutonomyFooterStatus(): void;
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

	const restoreQueue = (error: unknown) => {
		host.session.clearQueue();
		host.compactionQueuedMessages = queuedMessages;
		host.updatePendingMessagesDisplay();
		host.showError(
			`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	};

	try {
		if (options?.willRetry) {
			// When retry is pending, queue messages for the retry turn
			for (const message of queuedMessages) {
				if (host.isExtensionCommand(message.text)) {
					await host.session.prompt(message.text);
				} else if (message.mode === "followUp") {
					await host.session.followUp(message.text, message.images);
				} else {
					await host.session.steer(message.text, message.images);
				}
			}
			host.updatePendingMessagesDisplay();
			return;
		}

		// Find first non-extension-command message to use as prompt
		const firstPromptIndex = queuedMessages.findIndex((message) => !host.isExtensionCommand(message.text));
		if (firstPromptIndex === -1) {
			// All extension commands - execute them all
			for (const message of queuedMessages) {
				await host.session.prompt(message.text);
			}
			return;
		}

		// Execute any extension commands before the first prompt
		const preCommands = queuedMessages.slice(0, firstPromptIndex);
		const firstPrompt = queuedMessages[firstPromptIndex];
		const rest = queuedMessages.slice(firstPromptIndex + 1);

		for (const message of preCommands) {
			await host.session.prompt(message.text);
		}

		// Send first prompt (starts streaming). Auto-compaction can finish while the
		// agent is still processing; in that case, queue the message with the same
		// steering/follow-up mode instead of surfacing an internal streamingBehavior error.
		const promptOptions = host.session.isStreaming
			? { images: firstPrompt.images, streamingBehavior: firstPrompt.mode }
			: { images: firstPrompt.images };
		const promptPromise = host.session
			.prompt(firstPrompt.text, promptOptions)
			.catch((error) => {
				restoreQueue(error);
			})
			.finally(() => {
				host.refreshAutonomyFooterStatus();
			});

		// Queue remaining messages
		for (const message of rest) {
			if (host.isExtensionCommand(message.text)) {
				await host.session.prompt(message.text);
			} else if (message.mode === "followUp") {
				await host.session.followUp(message.text, message.images);
			} else {
				await host.session.steer(message.text, message.images);
			}
		}
		host.updatePendingMessagesDisplay();
		void promptPromise;
	} catch (error) {
		restoreQueue(error);
	}
}
