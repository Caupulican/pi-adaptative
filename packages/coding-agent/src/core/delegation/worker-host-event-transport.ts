import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { UserMessage } from "@caupulican/pi-ai";
import { stampWorkerControl, workerControlOf } from "../../kernel/worker-control-stamp.ts";
import { type HostEventDeliveryBinding, HostEventError } from "../events/host-event-contract.ts";
import { hostEventEvidenceText } from "../events/host-event-delivery.ts";
import { hostEventExecutionSuperseded } from "../events/host-event-reducer.ts";
import type { HostEventDelivery } from "../events/host-event-state.ts";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../orchestration/delegation-ledger.ts";
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
	warn(message: string): void;
}

/** The started attempt whose provider boundary is admitting mailbox copies. */
export type HostEventConsumingExecution = Pick<
	StartedDelegationAttempt,
	"taskId" | "attemptId" | "leaseId" | "fencingToken"
>;

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
	private readonly unsettledWarnings = new Map<string, string>();
	constructor(port: WorkerHostEventTransportPort) {
		this.port = port;
	}

	/**
	 * `dormant` leaves the obligation pending for a later state, readiness or control change;
	 * `unavailable` is permanent for the running execution and hands the event back.
	 */
	deliver(input: HostEventDelivery, signal: AbortSignal): "queued" | "dormant" | "unavailable" {
		signal.throwIfAborted();
		// A missing control surface (tool-set switch, teardown, reload) is re-driven by the next
		// orchestration, foreground-activity or runtime-availability notification.
		if (!this.port.available()) return "dormant";
		const runtime = this.port.lifecycle().ledger.runtime;
		const events = runtime.hostEvents;
		let delivery = events.getDelivery(input.deliveryId);
		if (delivery?.target.kind !== "task") throw new HostEventError("invalid", "Worker event has no task target.");
		if (delivery.transcriptReceipt) {
			this.reconcileDelivery(delivery);
			return "queued";
		}
		// Settle a copy bound to an execution that can never run again before any dormant return, so a
		// later attempt of the same agent never meets it in its mailbox.
		if (
			delivery.binding &&
			!delivery.mailboxSettled &&
			(delivery.bindingRetired || hostEventExecutionSuperseded(runtime.getSnapshot(), delivery.binding.execution))
		) {
			this.reconcileDelivery(delivery);
			delivery = events.getDelivery(input.deliveryId);
			if (delivery?.target.kind !== "task") throw new HostEventError("invalid", "Worker event has no task target.");
			if (delivery.transcriptReceipt) return "queued";
		}
		if (!events.eligible(delivery.deliveryId)) return "dormant";
		const snapshot = runtime.getSnapshot();
		const attempt = selectedWorkerAttempt(snapshot, delivery.target.taskId);
		const agentId = attempt?.agentId ?? attempt?.dispatch.logicalLaneId;
		const agent = agentId ? snapshot.agents[agentId] : undefined;
		// A queued, expired or retry-pending task has no executing agent yet.
		if (!attempt || !agent) return "dormant";
		// The selected execution's conversation can never hold a mailbox event: permanent handback.
		if (agent.status === "retired" || agent.resumeContext.provider !== "pi" || !agent.resumeContext.sessionFile)
			return attempt.status === "suspended" || attempt.status === "running" ? "unavailable" : "dormant";
		if (attempt.status === "suspended") {
			const subscription = snapshot.threadSubscriptions[delivery.target.subscriptionId];
			if (subscription?.wake === "resume_same_task") this.port.resume(agent.agentId);
			return "dormant";
		}
		// Binding requires a running execution; a leased attempt is re-driven by its start commit.
		if (attempt.status !== "running" || !attempt.lease) return "dormant";
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

	/**
	 * Lifecycle recovery leaves current live evidence queued; ended obligations and copies bound to an
	 * execution that can never run again are settled in their original transcript.
	 */
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
				delivery.bindingRetired ||
				hostEventExecutionSuperseded(snapshot, delivery.binding.execution) ||
				runtime.hostEvents.taskDisposition(delivery.target.taskId) === "closed" ||
				!subscription ||
				subscription.revokedOrdinal !== undefined ||
				subscription.revision !== delivery.target.subscriptionRevision
			)
				this.reconcileDelivery(delivery);
		}
	}

	/**
	 * Another execution's copy never fails this run: it is excluded from admission and settled by its
	 * lifecycle owners (this call, `deliver`, `reconcileInactive` at every execution transition).
	 */
	private settleStaleCopies(agentId: string): void {
		try {
			this.reconcileInactive(agentId);
			this.unsettledWarnings.delete(agentId);
		} catch (error) {
			// Each provider boundary retries; one diagnostic per distinct failure.
			const message = `Worker host-event copy for ${agentId} remains unsettled: ${error instanceof Error ? error.message : String(error)}`;
			if (this.unsettledWarnings.get(agentId) === message) return;
			this.unsettledWarnings.set(agentId, message);
			this.port.warn(message);
		}
	}

	/** The only new worker-event append. Called after all awaited admission work, before loop emission. */
	consume(
		agentId: string,
		execution: HostEventConsumingExecution,
		conversation: WorkerConversation,
		message: UserMessage,
	): boolean {
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
		// Only the execution a copy was bound to may append it. A copy left by an earlier attempt or
		// fence of this agent (or by its previous task) is that execution's obligation, not this run's.
		if (
			binding.execution.taskId !== execution.taskId ||
			binding.execution.attemptId !== execution.attemptId ||
			binding.execution.leaseId !== execution.leaseId ||
			binding.execution.fencingToken !== execution.fencingToken
		) {
			this.settleStaleCopies(agentId);
			return false;
		}
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
			// A fence (catch-up, settlement, retirement, a moved execution) leaves this run intact;
			// a copy whose execution ended is settled by its lifecycle owners.
			if (deliveryFenceChanged(error)) {
				this.settleStaleCopies(agentId);
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
