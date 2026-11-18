/** Coordinates an explicit model transfer across durable admission, physical settlement and worktree ownership. */
import { conversationTurnOrigin } from "../orchestration/attempt-agent-identity.ts";
import {
	MODEL_TRANSFER_INTERRUPTION,
	type ModelTransferRecord,
	modelTransferIsPending,
} from "../orchestration/model-transfer.ts";
import { type AttemptRuntimeState, terminalAttemptStatus } from "../orchestration/task-runtime-state.ts";
import type { WorkerAgentControlScope } from "./worker-agent-control.ts";
import type { WorkerAgentControlCoordinator } from "./worker-agent-control-coordinator.ts";
import type { WorkerLaneIsolation } from "./worker-lane-isolation.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";
import type { ModelTransferPreflight } from "./worker-model-transfer-admission.ts";

interface HandoffHost {
	lifecycle: WorkerLifecycle;
	control: WorkerAgentControlCoordinator;
	isolation?: WorkerLaneIsolation;
	preflight(source: AttemptRuntimeState, target: string): Promise<ModelTransferPreflight>;
	start(
		source: AttemptRuntimeState,
		transfer: ModelTransferRecord,
		prepared: ModelTransferPreflight,
	): { started: boolean; skipReason?: string };
	isSettled(agentId: string): boolean;
	ownsSource(source: AttemptRuntimeState): boolean;
	claimSource(source: AttemptRuntimeState): () => void;
	warn(message: string): void;
}

interface PendingHandoff {
	transfer: ModelTransferRecord;
	prepared?: ModelTransferPreflight;
	haltRequested?: boolean;
	/** A recovered request may have stopped between the lane CAS and the successor event. */
	mayOwnLane: boolean;
	dirty: boolean;
	work?: Promise<void>;
	lastWarning?: string;
}

export class WorkerModelHandoffCoordinator {
	private readonly pending = new Map<string, PendingHandoff>();
	private readonly byAggregate = new Map<string, PendingHandoff>();
	private readonly retryOnControl = new Set<PendingHandoff>();
	private readonly admissions = new Map<
		string,
		{
			commandId: string;
			target: string;
			result: Promise<ModelTransferRecord>;
		}
	>();
	private readonly off: (() => void)[] = [];
	private recovered = false;
	private closed = false;
	private readonly host: HandoffHost;

	constructor(host: HandoffHost) {
		this.host = host;
	}

	private get runtime() {
		return this.host.lifecycle.ledger.runtime.modelTransfers;
	}

	/** On first recovery only, adopt interrupted commands before normal work drains. */
	recover(): void {
		if (this.recovered || this.closed) return;
		const transfers = this.runtime.listPending();
		this.recovered = true;
		for (const transfer of transfers) this.track(transfer);
	}

	async request(
		agentId: string,
		target: string,
		commandId: string,
		scope: WorkerAgentControlScope = {},
	): Promise<ModelTransferRecord> {
		if (this.closed) throw new Error("The worker controller is shutting down.");
		if (scope.callerAgentId === agentId) throw new Error("A worker cannot hand off its own active turn.");
		const lane = this.host.control.resolveWorkerAgentLane(agentId, scope);
		const source = this.host.lifecycle.getLatestAgentAttempt(agentId);
		if (!lane || !source || source.taskId !== lane.laneId)
			throw new Error("The source has no retained worker attempt.");
		this.recover();
		const replay = this.runtime.findSourceCommand(agentId, commandId);
		if (replay) {
			if (replay.targetModelRef !== target) throw new Error("The handoff command already specifies another model.");
			if (modelTransferIsPending(replay)) {
				this.track(replay);
				const entry = this.pending.get(replay.sourceAttemptId);
				if (entry) this.schedule(entry);
			}
			return replay;
		}
		if (modelTransferIsPending(source.modelTransfer))
			throw new Error("A handoff is already pending on this attempt.");
		if (!this.host.ownsSource(source)) throw new Error("The source belongs to another active host.");
		if (
			this.host.control.senderTurnOrigin(scope.callerAgentId)?.thirdParty &&
			!conversationTurnOrigin(this.host.lifecycle.getTaskRuntimeSnapshot(), source)?.thirdParty
		)
			throw new Error("A third-party message cannot transfer an owner-only task to another model.");
		const inflight = this.admissions.get(source.attemptId);
		if (inflight) {
			if (inflight.commandId === commandId && inflight.target === target) return inflight.result;
			throw new Error("Another model handoff is being admitted on this attempt.");
		}
		const result = this.prepareCommand(source, agentId, target, commandId);
		this.admissions.set(source.attemptId, { commandId, target, result });
		try {
			return await result;
		} finally {
			this.admissions.delete(source.attemptId);
		}
	}

	private async prepareCommand(
		source: AttemptRuntimeState,
		agentId: string,
		target: string,
		commandId: string,
	): Promise<ModelTransferRecord> {
		const prepared = await this.host.preflight(source, target);
		if (this.closed) throw new Error("The worker controller is shutting down.");
		const transfer = this.host.control.withModelTransferSourceAdmission(agentId, () =>
			this.runtime.request({
				commandId,
				sourceAgentId: agentId,
				taskId: source.taskId,
				sourceAttemptId: source.attemptId,
				targetModelRef: target,
			}),
		);
		if (modelTransferIsPending(transfer)) this.track(transfer, prepared);
		return transfer;
	}

	private track(transfer: ModelTransferRecord, prepared?: ModelTransferPreflight): void {
		const prior = this.pending.get(transfer.sourceAttemptId);
		if (prior?.transfer.commandId === transfer.commandId) return;
		if (prior) this.untrack(prior);
		const entry: PendingHandoff = { transfer, prepared, mayOwnLane: !prepared, dirty: false };
		if (!this.pending.size) {
			this.off.push(
				this.runtime.subscribe((aggregateId) => this.signal(aggregateId)),
				this.host.control.subscribeStateChanges(() => {
					for (const active of this.retryOnControl) this.schedule(active);
				}),
			);
		}
		this.pending.set(transfer.sourceAttemptId, entry);
		for (const key of this.keys(transfer)) this.byAggregate.set(key, entry);
		this.schedule(entry);
	}

	private keys(t: ModelTransferRecord): readonly string[] {
		return [t.taskId, t.sourceAttemptId, t.successorAttemptId, t.sourceAgentId, t.successorAgentId];
	}

	private untrack(entry: PendingHandoff): void {
		const t = entry.transfer;
		if (this.pending.get(t.sourceAttemptId) === entry) this.pending.delete(t.sourceAttemptId);
		for (const key of this.keys(t)) if (this.byAggregate.get(key) === entry) this.byAggregate.delete(key);
		this.retryOnControl.delete(entry);
		if (!this.pending.size) for (const off of this.off.splice(0)) off();
	}

	/** Called after the local execution has physically released its last resource as well as on ledger changes. */
	signal(id: string): void {
		const active = this.byAggregate.get(id);
		if (active) this.schedule(active);
	}

	private schedule(entry: PendingHandoff): void {
		if (this.closed) return;
		entry.dirty = true;
		if (entry.work) return;
		entry.work = Promise.resolve()
			.then(async () => {
				while (entry.dirty && !this.closed) {
					entry.dirty = false;
					try {
						if (this.waitingForSignal(entry)) continue;
						await this.runtime.withEffectsLock(entry.transfer.sourceAttemptId, () => this.advance(entry));
						this.retryOnControl.delete(entry);
					} catch (error) {
						this.retryOnControl.add(entry);
						this.warnOnce(entry, error);
					}
				}
			})
			.finally(() => {
				entry.work = undefined;
				if (entry.dirty && this.pending.get(entry.transfer.sourceAttemptId) === entry) this.schedule(entry);
			});
	}

	private warnOnce(entry: PendingHandoff, cause: unknown): void {
		const detail = String(cause).slice(0, 500);
		if (detail === entry.lastWarning) return;
		entry.lastWarning = detail;
		this.host.warn(`Worker handoff ${entry.transfer.commandId}: ${detail}`);
	}

	private async changeLane(
		source: AttemptRuntimeState,
		transfer: ModelTransferRecord,
		reverse: boolean,
	): Promise<void> {
		const cwd = source.dispatch.executionContract?.worker.authority.cwd;
		if (!cwd) throw new Error("The source worker execution directory is missing.");
		const { sourceAgentId, successorAgentId } = transfer;
		await this.host.isolation?.transfer(
			cwd,
			reverse ? successorAgentId : sourceAgentId,
			reverse ? sourceAgentId : successorAgentId,
		);
	}

	private readSource(entry: PendingHandoff): AttemptRuntimeState | undefined {
		return this.host.lifecycle.getTaskRuntimeSnapshot().attempts[entry.transfer.sourceAttemptId];
	}

	/** Ordinary state notifications while a worker runs need no cross-process lock or checkout lookup. */
	private waitingForSignal(entry: PendingHandoff): boolean {
		const state = this.host.lifecycle.getTaskRuntimeSnapshot();
		const source = state.attempts[entry.transfer.sourceAttemptId];
		const transfer = source?.modelTransfer;
		if (!source || !transfer || transfer.commandId !== entry.transfer.commandId) return false;
		if (transfer.status === "requested")
			return !!entry.haltRequested && (source.status === "running" || source.status === "leased");
		if (transfer.status !== "successor_admitted" || transfer.successorStarted) return false;
		const successor = state.attempts[transfer.successorAttemptId];
		return !!successor && !terminalAttemptStatus(successor.status);
	}

	private async refuse(
		entry: PendingHandoff,
		source: AttemptRuntimeState,
		code: string,
		cause: unknown,
	): Promise<void> {
		const t = entry.transfer;
		if (entry.mayOwnLane) {
			await this.changeLane(source, t, true);
			entry.mayOwnLane = false;
		}
		this.runtime.settle(t.taskId, t.sourceAttemptId, t.commandId, "refused", code);
		this.warnOnce(entry, cause);
	}

	private async advance(entry: PendingHandoff): Promise<void> {
		if (this.closed) return;
		const source = this.readSource(entry);
		const t = source?.modelTransfer;
		if (!source || !t || t.commandId !== entry.transfer.commandId || !modelTransferIsPending(t)) {
			this.untrack(entry);
			return;
		}
		if (!this.host.ownsSource(source)) return;
		if (t.status === "successor_admitted") {
			if (t.successorStarted) {
				if (!this.host.isSettled(t.sourceAgentId)) return;
				const release = this.host.claimSource(source);
				try {
					this.host.control.retireWorkerAgent(t.sourceAgentId);
				} finally {
					release();
				}
				this.runtime.settle(t.taskId, t.sourceAttemptId, t.commandId, "completed");
			} else {
				const successor = this.host.lifecycle.getTaskRuntimeSnapshot().attempts[t.successorAttemptId];
				if (successor && terminalAttemptStatus(successor.status) && this.host.isSettled(t.successorAgentId)) {
					entry.mayOwnLane = true;
					await this.refuse(entry, source, "successor_did_not_start", successor.reasonCode ?? successor.status);
				}
			}
			return;
		}
		if (!entry.prepared) {
			try {
				entry.prepared = await this.host.preflight(source, t.targetModelRef);
			} catch (error) {
				if (!this.closed) await this.refuse(entry, source, "handoff_preflight_refused", error);
				return;
			}
			entry.dirty = true;
			return;
		}
		if (!terminalAttemptStatus(source.status)) {
			if (source.status === "queued" || source.status === "suspended") {
				if (!this.host.isSettled(t.sourceAgentId)) return;
				const release = this.host.claimSource(source);
				try {
					const agent = this.host.lifecycle.getAgent(t.sourceAgentId);
					if (!agent) throw new Error("The model transfer source agent disappeared.");
					this.host.control.cancelAgentAttempt(agent, source, MODEL_TRANSFER_INTERRUPTION, t);
				} finally {
					release();
				}
			} else {
				if (entry.haltRequested) return;
				const halt = this.host.control.interruptWorkerAgent(
					t.sourceAgentId,
					{},
					{
						message: `Handing this task to ${t.targetModelRef}. Report progress and open requirements.`,
						deadlineCode: MODEL_TRANSFER_INTERRUPTION,
					},
				);
				if (!halt.interrupted) {
					await this.refuse(entry, source, "handoff_interrupt_refused", halt.reason);
					return;
				}
				entry.haltRequested = true;
			}
			return;
		}
		if (!this.host.isSettled(t.sourceAgentId)) return;
		if (
			source.status === "completed" ||
			(source.status === "cancelled" && source.reasonCode !== MODEL_TRANSFER_INTERRUPTION)
		) {
			await this.refuse(entry, source, "source_task_closed", source.reasonCode ?? source.status);
			return;
		}
		const release = this.host.claimSource(source);
		try {
			await this.changeLane(source, t, false);
			entry.mayOwnLane = true;
			if (this.closed) return;
			const result = this.host.start(source, t, entry.prepared);
			if (!result.started) throw new Error(result.skipReason ?? "successor_start_refused");
		} catch (error) {
			// Admission can commit before scheduling throws. Its durable state owns subsequent recovery.
			const current = this.readSource(entry)?.modelTransfer;
			if (current?.commandId === t.commandId && current.status === "requested" && !this.closed)
				await this.refuse(entry, source, "successor_admission_refused", error);
		} finally {
			release();
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const off of this.off.splice(0)) off();
		await Promise.allSettled([
			...Array.from(this.admissions.values(), (entry) => entry.result),
			...Array.from(this.pending.values(), (entry) => entry.work),
		]);
		this.pending.clear();
		this.byAggregate.clear();
		this.retryOnControl.clear();
	}
}
