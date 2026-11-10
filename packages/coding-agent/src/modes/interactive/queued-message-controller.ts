/**
 * Queued owner input for the interactive mode: steering and follow-up messages waiting on a running turn, messages held
 * for after compaction, the pending-queue display, send-now, and restore-to-editor. The mode builds the QueuedMessageHost port.
 */
import type { ImageContent } from "@caupulican/pi-ai";
import type { Container, EditorComponent, TUI } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { AppKeybinding } from "../../core/keybindings.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import { joinOwnerWords, type OwnerTextRange, type OwnerWords } from "../../core/learning/owner-evidence-ledger.ts";
import type { SessionImageStore } from "../../core/session-image-store.ts";
import * as clipboardInput from "../../presentation/clipboard-input.ts";
import * as compactionQueue from "./compaction-queue.ts";
import type { ActivityLaneComponent } from "./components/activity-lane.ts";
import type { BashExecutionComponent } from "./components/bash-execution.ts";

/** A submitted owner input as the queue holds it: the text, its attached images, and the ranges the owner pasted. */
export type UserInputSubmission = {
	text: string;
	images?: ImageContent[];
	pasted?: readonly OwnerTextRange[];
};

export interface QueuedMessageHost {
	readonly session: AgentSession;
	readonly ui: TUI;
	readonly editor: EditorComponent;
	readonly chatContainer: Container;
	readonly pendingMessagesContainer: Container;
	readonly activityLane: ActivityLaneComponent | undefined;
	readonly extensionRunner: AgentSessionRuntime["extensionRunner"];
	readonly clipboardQueue: clipboardInput.ClipboardQueueState;
	readonly clipboardImageStore: SessionImageStore | undefined;
	pendingBashComponents: BashExecutionComponent[];
	compactionQueuedMessages: compactionQueue.CompactionQueuedMessage[];
	showStatus(message: string): void;
	showError(message: string): void;
	refreshAutonomyFooterStatus(): void;
	getAppKeyDisplay(action: AppKeybinding): string;
}

export class QueuedMessageController {
	private readonly host: QueuedMessageHost;

	constructor(host: QueuedMessageHost) {
		this.host = host;
	}

	handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.host.showStatus(
				this.hasQueuedMessages()
					? interfaceText().queue.messagesStayQueued
					: interfaceText().queue.nothingToRestore,
			);
		} else {
			this.host.showStatus(interfaceText().queue.restored(restored));
		}
	}

	/**
	 * Get all queued messages (read-only): the session's queue, which holds the messages queued for after compaction too
	 * (kept there from the moment they are queued).
	 */
	getAllQueuedMessages(): { steering: string[]; followUp: string[]; commands: string[] } {
		return {
			steering: [...this.host.session.getSteeringMessages()],
			followUp: [...this.host.session.getFollowUpMessages()],
			commands: [...this.host.session.getQueuedExtensionCommands()],
		};
	}

	/**
	 * Take recoverable queued messages and return their contents. Inputs with unreadable image references stay queued.
	 */
	clearAllQueues(): { steering: OwnerWords[]; followUp: OwnerWords[] } {
		const { steering, followUp, commands } = this.host.session.takeAllQueuedInput();
		this.host.compactionQueuedMessages = [];
		// The text returns to the editor, with the ranges the owner pasted, and the images to the pending clipboard queue,
		// so a resubmit sends the complete input again, as pasted as it was.
		return {
			steering: this.restoreInputImages(steering),
			followUp: [...this.restoreInputImages(followUp), ...commands.map((text) => ({ text }))],
		};
	}

	/** The editor's words, expanded (a collapsed paste is its content), with the ranges the owner pasted. */
	editorWords(): OwnerWords {
		return {
			text: this.host.editor.getExpandedText?.() ?? this.host.editor.getText(),
			pasted: this.host.editor.getPastedRanges?.(),
		};
	}

	restoreInputImages(inputs: readonly UserInputSubmission[]): OwnerWords[] {
		return clipboardInput.restoreClipboardImages(
			clipboardInput.bindClipboardQueue(this.host.clipboardQueue, {
				clipboardImageStore: this.host.clipboardImageStore,
			}),
			inputs,
		);
	}

	/** Steering and follow-up messages waiting on the running turn; queued extension commands do not count. */
	hasQueuedMessages(): boolean {
		return this.host.session.getSteeringMessages().length + this.host.session.getFollowUpMessages().length > 0;
	}

	/**
	 * Interrupt the running turn and submit everything queued as one root prompt, images included,
	 * steering first, then follow-ups, each in queue order. Extension commands stay queued.
	 */
	async sendQueuedMessagesNow(): Promise<void> {
		if (this.host.session.isCompacting) {
			this.host.showStatus(interfaceText().queue.compactionInProgress);
			return;
		}
		// The session's queue holds what was queued for after compaction too: taking it leaves that queue nothing to send.
		const { steering, followUp } = this.host.session.takeQueuedMessages();
		this.host.compactionQueuedMessages = [];
		const entries = [...steering, ...followUp];
		if (entries.length === 0) return;
		this.updatePendingMessagesDisplay();
		const { text, pasted } = joinOwnerWords(entries, "\n\n");
		const images = entries.flatMap((entry) => entry.images ?? []);
		this.host.activityLane?.announce(interfaceText().queue.interrupting(entries.length), "neutral");
		try {
			await this.host.session.abort("send now");
			// The aborted prompt still holds the foreground lease until its tail finishes; a root prompt
			// submitted before that is refused as busy.
			await this.host.session.waitForForegroundIdle();
			await this.host.session.prompt(text, {
				images: images.length ? images : undefined,
				pasted,
				processSlashCommands: false,
			});
		} catch (error) {
			// Failed submission returns the complete input through the same clipboard owner as take-back.
			const back = joinOwnerWords(
				[...this.restoreInputImages(entries), this.editorWords()].filter((part) => part.text.trim()),
				"\n\n",
			);
			this.host.editor.setText(back.text, back.pasted);
			const detail = error instanceof Error ? error.message : String(error);
			this.host.showError(interfaceText().queue.sendNowFailed(detail, images.length > 0));
		} finally {
			this.host.refreshAutonomyFooterStatus();
		}
		this.updatePendingMessagesDisplay();
		this.host.ui.requestRender();
	}

	updatePendingMessagesDisplay(): void {
		this.host.pendingMessagesContainer.clear();
		for (const component of this.host.pendingBashComponents) this.host.pendingMessagesContainer.addChild(component);
		const { steering: steeringMessages, followUp: followUpMessages, commands } = this.getAllQueuedMessages();
		const steeringCount = steeringMessages.length;
		const followUpCount = followUpMessages.length;
		const commandCount = commands.length;
		const total = steeringCount + followUpCount + commandCount;
		if (total > 0) {
			const dequeueHint = this.host.getAppKeyDisplay("app.message.dequeue");
			// The label states the delivery boundary; a queued message is never a mystery in flight.
			// Extension commands execute against the session after the run; send-now never sends them,
			// so the offer appears only when a message would actually go.
			const words = interfaceText().queue;
			const details = [
				steeringCount > 0
					? words.steering(steeringCount, this.host.session.steeringMode === "one-at-a-time")
					: undefined,
				followUpCount > 0 ? words.followUp(followUpCount) : undefined,
				commandCount > 0 ? words.commands(commandCount) : undefined,
				steeringCount + followUpCount > 0 ? words.sendNow : undefined,
				words.editHint(dequeueHint),
			]
				.filter((value): value is string => value !== undefined)
				.join(" · ");
			this.host.activityLane?.wait({ id: "queue:messages", kind: "queue", label: words.queued(total, details) });
		} else {
			this.host.activityLane?.remove("queue:messages");
		}
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		if (options?.abort) {
			void this.host.session.abort("user interrupt").catch((error: unknown) => {
				this.host.showError(
					interfaceText().queue.interruptFailed(error instanceof Error ? error.message : String(error)),
				);
			});
		}
		const allQueued = [...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			return 0;
		}
		const current = options?.currentText !== undefined ? { text: options.currentText } : this.editorWords();
		const combined = joinOwnerWords(
			[...allQueued, current].filter((part) => part.text.trim()),
			"\n\n",
		);
		this.host.editor.setText(combined.text, combined.pasted);
		this.updatePendingMessagesDisplay();
		return allQueued.length;
	}

	queueCompactionMessage(
		text: string,
		mode: "steer" | "followUp",
		images?: ImageContent[],
		pasted?: readonly OwnerTextRange[],
	): void {
		// Kept by the session from now: shown in its queue, takeable, and restored held after a restart.
		const input = this.host.session.keepQueuedInput(mode, text, images, undefined, pasted);
		this.host.compactionQueuedMessages.push({ text, mode, images, pasted, input });
		this.host.editor.addToHistory?.(text, pasted);
		this.host.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.host.showStatus(interfaceText().queue.queuedForAfterCompaction);
	}

	isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.host.extensionRunner;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		const host = this.host;
		return compactionQueue.flushCompactionQueue(
			{
				get compactionQueuedMessages() {
					return host.compactionQueuedMessages;
				},
				set compactionQueuedMessages(value) {
					host.compactionQueuedMessages = value;
				},
				session: this.host.session,
				updatePendingMessagesDisplay: () => this.updatePendingMessagesDisplay(),
				showError: (message) => this.host.showError(message),
				isExtensionCommand: (text) => this.isExtensionCommand(text),
				refreshAutonomyFooterStatus: () => this.host.refreshAutonomyFooterStatus(),
			},
			options,
		);
	}

	/** Move pending bash components from pending area to chat */
	flushPendingBashComponents(): void {
		for (const component of this.host.pendingBashComponents) {
			this.host.pendingMessagesContainer.removeChild(component);
			this.host.chatContainer.addChild(component);
		}
		this.host.pendingBashComponents = [];
	}
}
