import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { WorkerDelegationRunOutcome } from "../agent-session-contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import { type WorkerAgentControlPort, WorkerAgentMailbox, type WorkerAgentMessage } from "./worker-agent-control.ts";
import type { WorkerConversation } from "./worker-conversation-store.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import type { WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";

export interface WorkerAgentControlCoordinatorOptions {
	agentDir: string;
	parentSessionId: string;
	processOwnerId: string;
	isControlAvailable(): boolean;
	getLifecycle(): WorkerLifecycle;
	recoveredRequest(attempt: AttemptRuntimeState): WorkerDelegationRequest;
	run(request: WorkerDelegationRequest, record: LaneRecord): Promise<WorkerDelegationRunOutcome>;
	scheduler: Pick<WorkerDispatchScheduler, "enqueue" | "track" | "drain">;
	statusChanged(): void;
	abortLane(laneId: string, reasonCode: string): void;
	cancelLane(laneId: string, reasonCode: string): LaneRecord | undefined;
}

/**
 * Sole owner of model-facing logical-agent controls and their durable inboxes.
 *
 * It deliberately owns no worker execution policy, provider loop, or terminal persistence. Those
 * controller-owned callbacks keep this narrow port from becoming a second lifecycle authority.
 */
export class WorkerAgentControlCoordinator implements WorkerAgentControlPort {
	private readonly options: WorkerAgentControlCoordinatorOptions;
	private readonly mailboxes = new Map<string, WorkerAgentMailbox>();
	private readonly stateListeners = new Set<() => void>();

	constructor(options: WorkerAgentControlCoordinatorOptions) {
		this.options = options;
	}

	getProcessOwnerId(): string {
		return this.options.processOwnerId;
	}

	sendWorkerAgentMessage(agentId: string, message: string): { messageId: string; queued: true } {
		this.requireControl();
		const agent = this.requireKnownAgent(agentId);
		const queued = this.getMailbox(agent.agentId).enqueue({ kind: "follow_up", content: message });
		this.signalStateChanged();
		return { messageId: queued.messageId, queued: true };
	}

	followUpWorkerAgent(
		agentId: string,
		message: string,
	): { started: boolean; steering: boolean; messageId: string; record?: LaneRecord; skipReason?: string } {
		this.requireControl();
		const agent = this.requireKnownAgent(agentId);
		const canonicalAgentId = agent.agentId;
		const active = agent.activeAttemptId
			? this.options.getLifecycle().getTaskRuntimeSnapshot().attempts[agent.activeAttemptId]
			: undefined;
		if (active?.status === "running" || active?.status === "leased") {
			const queued = this.getMailbox(canonicalAgentId).enqueue({ kind: "steer", content: message });
			this.signalStateChanged();
			return { started: false, steering: true, messageId: queued.messageId };
		}
		if (agent.status !== "registered") {
			return { started: false, steering: false, messageId: "", skipReason: `agent_${agent.status}` };
		}
		const queued = this.getMailbox(canonicalAgentId).enqueue({ kind: "follow_up", content: message });
		try {
			const prepared = this.options
				.getLifecycle()
				.prepareAgentTurn({ agentId: canonicalAgentId, instructions: message });
			this.options.scheduler.enqueue(prepared.record, this.options.recoveredRequest(prepared.attempt));
			this.options.statusChanged();
			this.options.scheduler.drain();
			this.signalStateChanged();
			return { started: true, steering: false, messageId: queued.messageId, record: prepared.record };
		} catch (error) {
			return {
				started: false,
				steering: false,
				messageId: queued.messageId,
				skipReason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	interruptWorkerAgent(agentId: string): { interrupted: boolean; reason?: string } {
		this.requireControl();
		const agent = this.requireKnownAgent(agentId);
		const attemptId = agent.activeAttemptId;
		const attempt = attemptId ? this.options.getLifecycle().getTaskRuntimeSnapshot().attempts[attemptId] : undefined;
		if (!attempt || (attempt.status !== "running" && attempt.status !== "leased")) {
			return { interrupted: false, reason: "agent_not_running" };
		}
		try {
			this.options.getLifecycle().suspendAgent(attempt.taskId, agent.agentId, this.options.processOwnerId);
			this.options.abortLane(attempt.taskId, "agent_interrupted");
			this.signalStateChanged();
			return { interrupted: true };
		} catch (error) {
			return { interrupted: false, reason: error instanceof Error ? error.message : String(error) };
		}
	}

	resumeWorkerAgent(agentId: string): { started: boolean; record?: LaneRecord; skipReason?: string } {
		this.requireControl();
		const agent = this.requireKnownAgent(agentId);
		const attemptId = agent.activeAttemptId;
		const attempt = attemptId ? this.options.getLifecycle().getTaskRuntimeSnapshot().attempts[attemptId] : undefined;
		if (!attempt || attempt.status !== "suspended") return { started: false, skipReason: "agent_not_suspended" };
		const record = this.options.getLifecycle().getRecord(attempt.taskId);
		if (!record) return { started: false, skipReason: "orchestration_projection_missing" };
		const promise = this.options.run(this.options.recoveredRequest(attempt), record);
		this.options.scheduler.track(record.laneId, promise);
		this.signalStateChanged();
		return { started: true, record };
	}

	cancelWorkerAgent(agentId: string, reasonCode = "agent_cancelled"): LaneRecord | undefined {
		this.requireControl();
		const agent = this.requireKnownAgent(agentId);
		const attemptId = agent.activeAttemptId;
		const attempt = attemptId ? this.options.getLifecycle().getTaskRuntimeSnapshot().attempts[attemptId] : undefined;
		if (!attempt) return undefined;
		this.options.abortLane(attempt.taskId, reasonCode);
		const record = this.options.cancelLane(attempt.taskId, reasonCode);
		this.signalStateChanged();
		return record;
	}

	/** Event-driven wait: durable projection plus state/mailbox notifications, never output polling. */
	waitForWorkerAgent(
		agentId: string,
		timeoutMs = 30_000,
	): Promise<{ status: "active" | "suspended" | "idle" | "unknown" }> {
		this.requireControl();
		const canonicalAgentId = agentId.trim();
		const boundedTimeoutMs = Number.isFinite(timeoutMs)
			? Math.max(1, Math.min(Math.floor(timeoutMs), 300_000))
			: 30_000;
		const currentStatus = (): "active" | "suspended" | "idle" | "unknown" => {
			const agent = this.options.getLifecycle().getAgent(canonicalAgentId);
			if (!agent) return "unknown";
			if (agent.status === "active" || agent.status === "resuming") return "active";
			if (agent.status === "suspended") return "suspended";
			return "idle";
		};
		const immediate = currentStatus();
		if (immediate !== "active") return Promise.resolve({ status: immediate });
		return new Promise((resolve) => {
			let settled = false;
			const settle = () => {
				if (settled) return;
				const next = currentStatus();
				if (next === "active") return;
				settled = true;
				unsubscribeMailbox();
				unsubscribeState();
				clearTimeout(timeout);
				resolve({ status: next });
			};
			const unsubscribeMailbox = this.getMailbox(canonicalAgentId).subscribe(settle);
			const unsubscribeState = this.subscribeStateChanges(settle);
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				unsubscribeMailbox();
				unsubscribeState();
				resolve({ status: currentStatus() });
			}, boundedTimeoutMs);
			if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
		});
	}

	/** Read mailbox items at a safe boundary and reconcile the narrow append-before-ack crash window. */
	mailboxMessagesForConversation(
		agentId: string,
		conversation: WorkerConversation,
		includeFollowUp: boolean,
	): AgentMessage[] {
		const mailbox = this.getMailbox(agentId);
		const pending = mailbox.pending();
		if (pending.length === 0) return [];
		const delivered = conversation.findDeliveredWorkerControlMessageIds(pending.map((message) => message.messageId));
		for (const messageId of delivered) mailbox.acknowledgeDelivered(messageId);
		return mailbox
			.pending()
			.filter((message) => message.kind === "steer" || includeFollowUp)
			.map((message) => this.mailboxMessage(message));
	}

	/** Acknowledge only after the exact child transcript message has been durably appended. */
	acknowledgeMailboxMessage(agentId: string, message: { role: string; content: unknown }): void {
		if (message.role !== "user" || typeof message.content !== "string") return;
		const messageId = /^\[Worker control (worker-message-[^\]]+)\]\n/.exec(message.content)?.[1];
		if (messageId) this.getMailbox(agentId).acknowledgeDelivered(messageId);
	}

	/** Called by controller-owned execution transitions after lifecycle state changed. */
	signalStateChanged(): void {
		for (const listener of this.stateListeners) listener();
	}

	private requireControl(): void {
		if (!this.options.isControlAvailable()) {
			throw new Error("Worker delegation control is unavailable in this UAC surface.");
		}
	}

	private requireKnownAgent(agentId: string): AgentBindingContract {
		const normalized = agentId.trim();
		if (!normalized) throw new Error("Logical worker agent id is required.");
		const agent = this.options.getLifecycle().getAgent(normalized);
		if (!agent) throw new Error(`Unknown logical worker agent '${normalized}'.`);
		return agent;
	}

	private getMailbox(agentId: string): WorkerAgentMailbox {
		let mailbox = this.mailboxes.get(agentId);
		if (!mailbox) {
			mailbox = new WorkerAgentMailbox({
				agentDir: this.options.agentDir,
				parentSessionId: this.options.parentSessionId,
				agentId,
			});
			this.mailboxes.set(agentId, mailbox);
		}
		return mailbox;
	}

	private subscribeStateChanges(listener: () => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	private mailboxMessage(message: WorkerAgentMessage): AgentMessage {
		return {
			role: "user",
			content: `[Worker control ${message.messageId}]\n${message.content}`,
			timestamp: Date.now(),
		};
	}
}
