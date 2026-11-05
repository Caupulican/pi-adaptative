import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { UserMessage } from "@caupulican/pi-ai";
import { stampWorkerControl, workerControlOf } from "../../kernel/worker-control-stamp.ts";
import { type HostEventDeliveryBinding, HostEventError } from "../events/host-event-contract.ts";
import { hostEventEvidenceText } from "../events/host-event-delivery.ts";
import type { HostEventDelivery } from "../events/host-event-state.ts";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import type { SpecialistContextClaim } from "../orchestration/specialist-context-ownership.ts";
import type { WorkerAgentMailbox } from "./worker-agent-control.ts";
import type { WorkerConversation, WorkerConversationStore } from "./worker-conversation-store.ts";
import { selectedWorkerAttempt } from "./worker-lane-projection.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";

interface WorkerHostEventTransportPort {
	readonly agentDir: string;
	readonly conversations: WorkerConversationStore;
	lifecycle(): WorkerLifecycle;
	mailbox(agentId: string): WorkerAgentMailbox;
	claim(agent: AgentBindingContract): SpecialistContextClaim | undefined;
	admit<T>(agent: AgentBindingContract, operation: () => T): T;
	resume(agentId: string): boolean;
	available(): boolean;
}

/** One projection is used at enqueue, physical reconciliation and provider admission. */
export function workerHostEventMessage(binding: HostEventDeliveryBinding, content: string): UserMessage {
	const message: UserMessage = { role: "user", content, timestamp: Date.now() };
	stampWorkerControl(message, { v: 1, k: "host_event", id: binding.messageId, hostEvent: binding });
	return message;
}

function deliveryFenceChanged(error: unknown): boolean {
	return (
		error instanceof HostEventError &&
		["stale_delivery", "stale_execution", "source_catching_up"].includes(error.code)
	);
}

/** Coordinates physical transport only; task, source and receipt authority stays in the runtime. */
export class WorkerHostEventTransport {
	private readonly port: WorkerHostEventTransportPort;
	constructor(port: WorkerHostEventTransportPort) {
		this.port = port;
	}

	deliver(input: HostEventDelivery, signal: AbortSignal): "queued" | "dormant" | "unavailable" {
		signal.throwIfAborted();
		if (!this.port.available()) return "unavailable";
		const runtime = this.port.lifecycle().ledger.runtime;
		const events = runtime.hostEvents;
		const delivery = events.getDelivery(input.deliveryId);
		if (delivery?.target.kind !== "task") throw new HostEventError("invalid", "Worker event has no task target.");
		if (delivery.transcriptReceipt) {
			this.reconcileDelivery(delivery);
			return "queued";
		}
		if (!events.eligible(delivery.deliveryId)) return "dormant";
		const snapshot = runtime.getSnapshot();
		const attempt = selectedWorkerAttempt(snapshot, delivery.target.taskId);
		const agentId = attempt?.agentId ?? attempt?.dispatch.logicalLaneId;
		const agent = agentId ? snapshot.agents[agentId] : undefined;
		if (
			!agent ||
			agent.status === "retired" ||
			agent.resumeContext.provider !== "pi" ||
			!agent.resumeContext.sessionFile
		)
			return "unavailable";
		if (attempt?.status === "suspended") {
			const subscription = snapshot.threadSubscriptions[delivery.target.subscriptionId];
			if (subscription?.wake === "resume_same_task") this.port.resume(agent.agentId);
			return "dormant";
		}
		if (!attempt?.lease || (attempt.status !== "running" && attempt.status !== "leased")) return "dormant";
		const accepted = events.getEvent(delivery.eventId);
		if (!accepted) throw new HostEventError("missing", "Worker event evidence is missing.");
		const content = hostEventEvidenceText(accepted, delivery);
		const initialDelivery = delivery;
		return this.port.admit(agent, () => {
			signal.throwIfAborted();
			let delivery = initialDelivery;
			if (delivery.bindingRetired && !delivery.mailboxSettled) {
				this.reconcileDelivery(delivery);
				delivery = events.getDelivery(input.deliveryId)!;
			}
			const contextClaim = this.port.claim(agent);
			const execution = {
				taskId: attempt.taskId,
				attemptId: attempt.attemptId,
				agentId: agent.agentId,
				leaseId: attempt.lease!.leaseId,
				fencingToken: attempt.lease!.fencingToken,
				sessionId: agent.resumeContext.sessionId,
				sessionFile: agent.resumeContext.sessionFile!,
				...(contextClaim ? { contextClaim } : {}),
			};
			if (delivery.binding && !delivery.bindingRetired) {
				const previous = delivery.binding;
				const physical = this.port.mailbox(previous.execution.agentId).getMessage(previous.messageId);
				let reusable =
					isDeepStrictEqual(previous.execution, execution) &&
					physical?.failedAt === undefined &&
					physical?.deliveredAt === undefined;
				if (reusable) {
					try {
						events.guardedDelivery(previous, "enqueue", () => undefined);
					} catch (error) {
						if (!deliveryFenceChanged(error)) throw error;
						reusable = false;
					}
				}
				if (!reusable) {
					this.reconcile(previous, content);
					delivery = events.getDelivery(input.deliveryId)!;
					if (delivery.transcriptReceipt) return "queued";
				}
			}
			const binding = events.bindDelivery(
				input.deliveryId,
				execution,
				createHash("sha256").update(content).digest("hex"),
			);
			this.port.mailbox(agent.agentId).enqueueHostEvent(binding, content, events);
			return "queued";
		});
	}

	/** Close a physical copy before task handback, context release, or durable retention can advance. */
	reconcileDelivery(input: HostEventDelivery): void {
		const events = this.port.lifecycle().ledger.runtime.hostEvents;
		const delivery = events.getDelivery(input.deliveryId);
		if (!delivery?.binding || delivery.mailboxSettled) return;
		const accepted = events.getEvent(delivery.eventId);
		if (!accepted)
			throw new HostEventError("missing", "Host event evidence was removed before transport settlement.");
		this.reconcile(delivery.binding, hostEventEvidenceText(accepted, delivery));
	}

	/** Lifecycle recovery leaves current live evidence queued; only ended obligations are retired. */
	reconcileInactive(agentId: string): void {
		const runtime = this.port.lifecycle().ledger.runtime;
		const snapshot = runtime.getSnapshot();
		for (const delivery of Object.values(snapshot.eventDeliveries)) {
			if (
				delivery.target.kind !== "task" ||
				delivery.binding?.execution.agentId !== agentId ||
				delivery.mailboxSettled
			)
				continue;
			const subscription = snapshot.threadSubscriptions[delivery.target.subscriptionId];
			if (
				delivery.status === "consumed" ||
				delivery.status === "settled" ||
				runtime.hostEvents.taskDisposition(delivery.target.taskId) === "closed" ||
				!subscription ||
				subscription.revokedOrdinal !== undefined ||
				subscription.revision !== delivery.target.subscriptionRevision
			)
				this.reconcileDelivery(delivery);
		}
	}

	/** The only new worker-event append. Called after all awaited admission work, before loop emission. */
	consume(agentId: string, conversation: WorkerConversation, message: UserMessage): boolean {
		const control = workerControlOf(message);
		if (control?.k !== "host_event" || !control.hostEvent || control.hostEvent.execution.agentId !== agentId)
			throw new HostEventError("invalid", "Worker event candidate has no exact binding.");
		const events = this.port.lifecycle().ledger.runtime.hostEvents;
		const binding = control.hostEvent;
		const mailbox = this.port.mailbox(agentId);
		const physical = mailbox.getMessage(binding.messageId);
		if (
			!physical ||
			physical.failedAt !== undefined ||
			physical.task?.kind !== "host_event" ||
			!isDeepStrictEqual(physical.task.binding, binding)
		)
			return false;
		try {
			let appended = false;
			mailbox.settleHostEvent(binding, events, (pending) => {
				// A copy settled by another owner is only reconciled; it is never appended again.
				appended = conversation.reconcileHostEvent(
					binding,
					message,
					events,
					pending ? "consume" : "reconcile",
				).appended;
			});
			return appended;
		} catch (error) {
			if (deliveryFenceChanged(error)) {
				const current = events.getDelivery(binding.deliveryId);
				if (
					isDeepStrictEqual(current?.binding, binding) &&
					(current?.bindingRetired || current?.status === "settled")
				)
					this.reconcile(binding, physical.content);
				return false;
			}
			throw error;
		}
	}

	/** Original attempt proof is reconciled before an old physical message can be retired or rebound. */
	private reconcile(binding: HostEventDeliveryBinding, content: string): void {
		const runtime = this.port.lifecycle().ledger.runtime;
		const agent = runtime.getSnapshot().agents[binding.execution.agentId];
		if (!agent) throw new HostEventError("missing", "Host event original worker binding is missing.");
		const conversation = this.port.conversations.open({
			agentDir: this.port.agentDir,
			resumeContext: {
				...agent.resumeContext,
				sessionId: binding.execution.sessionId,
				sessionFile: binding.execution.sessionFile,
			},
			expectedLogicalAgentId: agent.contextOrigin?.logicalAgentId ?? agent.agentId,
		});
		const message = workerHostEventMessage(binding, content);
		this.port
			.mailbox(binding.execution.agentId)
			.settleHostEvent(binding, runtime.hostEvents, () =>
				conversation.reconcileHostEvent(binding, message, runtime.hostEvents, "reconcile"),
			);
	}
}
