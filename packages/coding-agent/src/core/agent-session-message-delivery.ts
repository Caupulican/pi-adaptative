/**
 * Delivery of custom and user messages into the session coordinator: a message is steered into a running turn,
 * queued for the next turn, run as a turn of its own, or appended to the transcript, decided under the runtime
 * admission lease. Owner-facing session notices are steered through the same path. The coordinator supplies its
 * owners through one ports object.
 */

import type { ImageContent, TextContent } from "@caupulican/pi-ai";
import type { Agent } from "../kernel/agent.ts";
import type { CustomMessage } from "../kernel/messages.ts";
import type { AgentSessionEvent, PromptOptions } from "./agent-session-contracts.ts";
import type { BackgroundToolTaskController } from "./background-tool-task-controller.ts";
import type { SendUserMessageOptions } from "./extensions/index.ts";
import type { ForegroundLifecycleAdapter } from "./foreground-lifecycle-adapter.ts";
import type { ForegroundRecoveryController, ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import type { RuntimeWorkLease } from "./runtime-generation-admission.ts";
import type { SessionRuntimeAdmissionController } from "./session-runtime-admission-controller.ts";
import { hasRunningBackgroundedToolCall } from "./session-settlement.ts";
import type { SessionWorkState } from "./session-work-state.ts";

export interface AgentSessionMessageDeliveryPorts {
	runtimeAdmission(): SessionRuntimeAdmissionController;
	foregroundRecovery(): ForegroundRecoveryController;
	foregroundLifecycle(): ForegroundLifecycleAdapter;
	backgroundToolTasks(): BackgroundToolTaskController;
	agent(): Agent;
	pendingNextTurnMessages(): CustomMessage[];
	getSessionWorkState(): SessionWorkState;
	sendCustomMessage(
		message: Pick<CustomMessage, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;
	emit(event: AgentSessionEvent): void;
	promptWithRuntimeLease(
		text: string,
		options: PromptOptions | undefined,
		runtimeLease: RuntimeWorkLease | undefined,
	): Promise<void>;
}

export class AgentSessionMessageDelivery {
	private readonly ports: AgentSessionMessageDeliveryPorts;

	constructor(ports: AgentSessionMessageDeliveryPorts) {
		this.ports = ports;
	}

	async deliverCustomMessageWithLease<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
		runtimeLease?: RuntimeWorkLease,
		assertCurrent?: () => void,
	): Promise<void> {
		return this.ports
			.runtimeAdmission()
			.run(
				"custom-message",
				message.customType,
				(reader) => this.admitCustomMessage(message, options, reader),
				undefined,
				runtimeLease,
				assertCurrent,
			);
	}

	private async admitCustomMessage<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
		runtimeLease: RuntimeWorkLease,
	): Promise<void> {
		if (options?.deliverAs === "nextTurn") {
			return this.deliverCustomMessage(message, options);
		}
		const submissionLease = this.ports.foregroundRecovery().tryAcquireSubmission(runtimeLease);
		if (!submissionLease) {
			return this.deliverCustomMessage(message, options);
		}
		try {
			await this.deliverCustomMessage(message, options, submissionLease);
		} finally {
			this.ports.foregroundRecovery().releaseSubmission(submissionLease);
		}
	}

	async deliverCustomMessage<T>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
		submissionLease?: ForegroundSubmissionLease,
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this.ports.pendingNextTurnMessages().push(appMessage);
		} else if (
			this.ports.getSessionWorkState().phase !== "continuation_armed" &&
			this.ports.getSessionWorkState().busy &&
			!this.ports.foregroundRecovery().ownsSubmission(submissionLease)
		) {
			if (options?.deliverAs === "followUp") {
				this.ports.agent().followUp(appMessage);
			} else {
				this.ports.agent().steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this.ports.foregroundRecovery().runAgentPrompt(appMessage, submissionLease);
		} else if (hasRunningBackgroundedToolCall(this.ports.backgroundToolTasks().list())) {
			// Queue rather than splice while a backgrounded call is outstanding, exactly like the
			// isBusy branch above -- see hasRunningBackgroundedToolCall for why lease ownership is not
			// sufficient here. Scoped to the no-trigger case; triggerTurn:true is handled above.
			if (options?.deliverAs === "followUp") {
				this.ports.agent().followUp(appMessage);
			} else {
				this.ports.agent().steer(appMessage);
			}
		} else {
			this.ports.foregroundLifecycle().appendCustomMessage(appMessage);
			this.ports.agent().appendMessage(appMessage);
			this.ports.emit({ type: "message_start", message: appMessage });
			this.ports.emit({ type: "message_end", message: appMessage });
		}
	}

	async deliverUserMessageWithLease(
		content: string | (TextContent | ImageContent)[],
		options: SendUserMessageOptions | undefined,
		runtimeLease?: RuntimeWorkLease,
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Skip skill/template expansion by default. Extensions that intentionally
		// want slash commands to execute (for example self-maintenance reloads)
		// can opt in with processSlashCommands.
		// The sender hears exactly one acceptance verdict: the prompt's own preflight verdict, or a
		// refusal when the submission ended (returned or threw) without reaching one.
		let verdictGiven = false;
		const giveVerdict = (accepted: boolean): void => {
			if (verdictGiven) return;
			verdictGiven = true;
			options?.onAccepted?.(accepted);
		};
		try {
			await this.ports.promptWithRuntimeLease(
				text,
				{
					expandPromptTemplates: false,
					processSlashCommands: options?.processSlashCommands ?? false,
					streamingBehavior: options?.deliverAs,
					images,
					source: "extension",
					...(options?.origin ? { origin: options.origin } : {}),
					preflightResult: giveVerdict,
				},
				runtimeLease,
			);
		} finally {
			giveVerdict(false);
		}
	}

	/**
	 * Steer a displayed custom notice to this session's model (may trigger a turn); a delivery failure is a visible
	 * warning. An imported notice carries its `parentWriteId` in `details`, its exactly-once marker.
	 */
	steerSessionNotice(customType: string, text: string, parentWriteId?: string): void {
		void this.ports
			.sendCustomMessage(
				{ customType, content: text, display: true, ...(parentWriteId ? { details: { parentWriteId } } : {}) },
				{ triggerTurn: true, deliverAs: "steer" },
			)
			.catch((error: unknown) => {
				this.ports.emit({
					type: "warning",
					message: `${customType}: failed to notify session: ${error instanceof Error ? error.message : String(error)}`,
				});
			});
	}
}
