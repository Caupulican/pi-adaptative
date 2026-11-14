/** Host-written control messages in a logical worker's durable transcript: the append-or-reconcile of one control message, and the model-facing projection of a mailbox message. */

import type { UserMessage } from "@caupulican/pi-ai";
import type { OrchestrationHome } from "../../kernel/session/session-bundle-paths.ts";
import { stampWorkerControl } from "../../kernel/worker-control-stamp.ts";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import type { SpecialistContextClaim } from "../orchestration/specialist-context-ownership.ts";
import {
	type WorkerAgentActivity,
	type WorkerAgentMessage,
	type WorkerAgentTaskMetadata,
	workerAgentMessageId,
} from "./worker-agent-control.ts";
import { agentConversation, type WorkerConversationStore } from "./worker-conversation-store.ts";
import { workerHostEventMessage } from "./worker-host-event-transport.ts";

export type MandatoryTranscriptControlInput = {
	idempotencyKey: string;
	content: string;
	senderAgentId: string;
	threadId?: string;
	replyToMessageId?: string;
	task: WorkerAgentTaskMetadata;
};

interface WorkerControlTranscriptOptions {
	readonly agentDir: string;
	readonly orchestrationHome: OrchestrationHome;
	readonly parentSessionId: string;
	getConversationClaim?(agent: AgentBindingContract): SpecialistContextClaim | undefined;
}

interface WorkerControlTranscriptPort {
	readonly options: WorkerControlTranscriptOptions;
	readonly conversations: WorkerConversationStore;
	readonly activityForAgent: (agent: AgentBindingContract) => WorkerAgentActivity;
}

export function mailboxMessage(message: WorkerAgentMessage): UserMessage {
	if (message.task?.kind === "host_event") return workerHostEventMessage(message.task.binding, message.content);
	const metadata = [
		message.senderAgentId ? `from=${message.senderAgentId}` : undefined,
		message.threadId ? `thread=${message.threadId}` : undefined,
		message.replyToMessageId ? `replyTo=${message.replyToMessageId}` : undefined,
		message.expectReply ? "replyExpected=true" : undefined,
	].filter((value): value is string => value !== undefined);
	const header = `[Worker control ${message.messageId}${metadata.length > 0 ? ` ${metadata.join(" ")}` : ""}]\n`;
	const projected: UserMessage = {
		role: "user",
		content: `${header}${message.content}`,
		timestamp: Date.now(),
	};
	// The rendered text is for the model; everything that must recognize this message reads its typed identity.
	stampWorkerControl(projected, {
		v: 1,
		k: message.kind,
		id: message.messageId,
		...(message.senderAgentId ? { from: message.senderAgentId } : {}),
		...(message.threadId ? { th: message.threadId } : {}),
		...(message.replyToMessageId ? { to: message.replyToMessageId } : {}),
		...(message.expectReply ? { reply: true as const } : {}),
		body: { from: header.length, to: header.length + message.content.length },
	});
	return projected;
}

/** Writes host-written control messages into a worker's transcript; the coordinator supplies the claim and admission. */
export class WorkerControlTranscript {
	private readonly options: WorkerControlTranscriptOptions;
	private readonly conversations: WorkerConversationStore;
	private readonly activityForAgent: (agent: AgentBindingContract) => WorkerAgentActivity;

	constructor(port: WorkerControlTranscriptPort) {
		this.options = port.options;
		this.conversations = port.conversations;
		this.activityForAgent = port.activityForAgent;
	}

	deliverMandatoryControlToRetiredTranscript(
		target: AgentBindingContract,
		input: MandatoryTranscriptControlInput,
	): string {
		if (target.status !== "retired" || this.activityForAgent(target) === "active") {
			throw new Error("Mandatory transcript fallback requires a terminal logical worker target.");
		}
		const delivery = this.reconcileMandatoryControlTranscript(target, input, true);
		return delivery.messageId;
	}

	reconcileMandatoryControlTranscript(
		target: AgentBindingContract,
		input: MandatoryTranscriptControlInput,
		appendIfMissing: boolean,
	): { messageId: string; delivered: boolean } {
		const messageId = workerAgentMessageId(this.options.parentSessionId, input.idempotencyKey);
		return this.reconcileControlTranscript(
			target,
			{
				messageId,
				kind: "follow_up",
				content: input.content,
				senderAgentId: input.senderAgentId,
				...(input.threadId ? { threadId: input.threadId } : {}),
				...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
				task: input.task,
				createdAt: new Date().toISOString(),
			},
			appendIfMissing,
		);
	}

	reconcileControlTranscript(
		target: AgentBindingContract,
		message: WorkerAgentMessage,
		appendIfMissing: boolean,
	): { messageId: string; delivered: boolean } {
		const messageId = message.messageId;
		if (!target.resumeContext.sessionFile) {
			if (appendIfMissing) {
				throw new Error("Mandatory transcript fallback target has no durable session transcript.");
			}
			return { messageId, delivered: false };
		}
		const projected = mailboxMessage(message);
		const conversation = this.conversations.open({
			...agentConversation(this.options, target),
			...(appendIfMissing ? { projectClaim: this.options.getConversationClaim?.(target) } : {}),
		});
		if (typeof projected.content !== "string") {
			throw new Error("Worker control transcript projection is not textual.");
		}
		const reconciliation = conversation.reconcileWorkerControlMessage(
			{ messageId, content: projected.content },
			projected,
			appendIfMissing,
		);
		return { messageId, delivered: reconciliation.delivered };
	}
}
