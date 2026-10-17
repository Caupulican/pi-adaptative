import { isDeepStrictEqual } from "node:util";
import { isLaneRecord, isLaneTerminalStatus, type LaneRecord } from "../autonomy/lane-tracker.ts";
import {
	MAX_ORCHESTRATION_ATTEMPTS,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
} from "../orchestration/contracts.ts";
import { MAX_WORKER_TASK_LABEL_LENGTH } from "./worker-task-label.ts";

export interface WorkerTerminalHandoff {
	terminalAttemptId: string;
	parentAgentId: string;
	childAgentId: string;
	record: LaneRecord;
}

export const WORKER_COMPLETION_ERROR_CAVEMAN_GUIDANCE =
	"CAVEMAN MODE - MANDATORY: completion_error records a failed worker execution; inspect reasonDetail and retained evidence to identify its cause. Provider/model/API/network failures and exhausted retries do not by themselves establish an orchestration defect. A delivered terminal handoff establishes delivery only, not correctness of admission, accounting, execution, or persistence. Investigate worker_protocol_error at the harness boundary. NEVER stop, cancel, or interrupt healthy siblings solely because another worker failed. Continue or replan from the evidence.";

/**
 * The durable bound of every string field a retained lane record carries, in UTF-16 code units: the
 * bound the orchestration codec already enforced on the state the record is projected from. Bounding the
 * snapshot in the same unit as its source means every terminal the durable state admits fits here. A
 * byte ceiling on the serialized record could not promise that: the codec bounds characters, and one
 * character can serialize to six JSON bytes. `waitReason` is process-local queue state that a terminal
 * record never carries, and `costUsd` is a number. With the three handoff identities, one entry holds at
 * most 11,001 code units, so the durable attempt cap bounds the outbox to about 5.4 MiB of string data.
 */
const LANE_RECORD_FIELD_MAX_CHARS: Readonly<Record<Exclude<keyof LaneRecord, "waitReason" | "costUsd">, number>> =
	Object.freeze({
		laneId: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		type: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		status: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		label: MAX_WORKER_TASK_LABEL_LENGTH,
		profileId: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		// `${provider}/${modelId}` of the model binding the attempt ran on.
		modelRef: MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH + 1 + MAX_ORCHESTRATION_MODEL_ID_LENGTH,
		thinkingLevel: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		reasonCode: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		queuedAt: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		startedAt: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		completedAt: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		goalId: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		evidenceEntryId: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		worktreeLaneKey: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		agentStatus: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		agentId: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		attemptId: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		routeSource: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
		routePinSource: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	});

const LANE_RECORD_STRING_FIELDS = Object.keys(LANE_RECORD_FIELD_MAX_CHARS) as Array<
	keyof typeof LANE_RECORD_FIELD_MAX_CHARS
>;

export type WorkerTerminalHandoffDelivery = "delivered" | "retained";
/** `refreshed`: the same attempt's newer projection replaced the retained payload before delivery. */
export type WorkerTerminalHandoffRetention = "retained" | "replay" | "refreshed";

export interface WorkerTerminalHandoffDrainResult {
	attempted: number;
	delivered: number;
	errors: number;
	retained: number;
}

export interface WorkerTerminalHandoffRejection {
	terminalAttemptId: string;
	laneId: string;
	error: unknown;
}

export interface WorkerTerminalHandoffRehydrationResult {
	added: number;
	replayed: number;
	refreshed: number;
	/** Handoffs this pass could not adopt; each stays durable for a later recovery pass. */
	rejected: WorkerTerminalHandoffRejection[];
	drain: WorkerTerminalHandoffDrainResult;
}

export interface WorkerTerminalHandoffCoordinatorOptions {
	deliver(handoff: Readonly<WorkerTerminalHandoff>): WorkerTerminalHandoffDelivery;
	onDeliveryError?(handoff: Readonly<WorkerTerminalHandoff>, error: unknown): void;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
	if (
		typeof value !== "string" ||
		!value ||
		value.trim() !== value ||
		value.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH
	) {
		throw new TypeError(`${label} must be a bounded non-empty canonical string.`);
	}
}

function snapshotHandoff(handoff: WorkerTerminalHandoff): WorkerTerminalHandoff {
	assertIdentifier(handoff.terminalAttemptId, "Worker terminal attempt ID");
	assertIdentifier(handoff.parentAgentId, "Worker terminal parent agent ID");
	assertIdentifier(handoff.childAgentId, "Worker terminal child agent ID");
	if (!isLaneRecord(handoff.record)) {
		throw new TypeError("Worker terminal handoff requires a valid lane record.");
	}
	if (!isLaneTerminalStatus(handoff.record.status)) {
		throw new TypeError("Worker terminal handoff requires a terminal lane record.");
	}
	const source = handoff.record;
	// Only the declared lane-record fields are retained, each within its durable bound.
	const record: Partial<Record<keyof LaneRecord, string | number>> = {};
	for (const field of LANE_RECORD_STRING_FIELDS) {
		const value = source[field];
		if (value === undefined) continue;
		if (value.length > LANE_RECORD_FIELD_MAX_CHARS[field]) {
			throw new TypeError(
				`Worker terminal handoff field ${field} exceeds its ${LANE_RECORD_FIELD_MAX_CHARS[field]} character durable bound.`,
			);
		}
		record[field] = value;
	}
	if (source.costUsd !== undefined) record.costUsd = source.costUsd;
	return {
		terminalAttemptId: handoff.terminalAttemptId,
		parentAgentId: handoff.parentAgentId,
		childAgentId: handoff.childAgentId,
		record: record as LaneRecord,
	};
}

function cloneHandoff(handoff: WorkerTerminalHandoff): WorkerTerminalHandoff {
	return { ...handoff, record: { ...handoff.record } };
}

/** The same terminal edge: one attempt, routed between the same agents, for the same lane. */
function sameTerminalEdge(left: WorkerTerminalHandoff, right: WorkerTerminalHandoff): boolean {
	return (
		left.terminalAttemptId === right.terminalAttemptId &&
		left.parentAgentId === right.parentAgentId &&
		left.childAgentId === right.childAgentId &&
		left.record.laneId === right.record.laneId &&
		left.record.attemptId === right.record.attemptId
	);
}

/**
 * The record fields the parent's terminal message is built from besides the lane
 * (`buildWorkerTerminalHandoffContent`). Once a delivery attempt may have written that message under
 * the attempt's idempotency key, a payload that changes them can no longer replace it.
 */
function sameDeliveredContent(left: WorkerTerminalHandoff, right: WorkerTerminalHandoff): boolean {
	return left.record.status === right.record.status && left.record.reasonCode === right.record.reasonCode;
}

/**
 * Bounded process-local outbox for parent terminal handoffs. Delivery is driven only by explicit
 * terminal, capacity, state-change, and recovery calls; this owner never creates a timer or poll.
 */
export class WorkerTerminalHandoffCoordinator {
	private readonly options: WorkerTerminalHandoffCoordinatorOptions;
	private readonly pending = new Map<string, WorkerTerminalHandoff>();
	/** Retained attempts whose delivery has been invoked at least once; cleared with their entry. */
	private readonly deliveryAttempted = new Set<string>();
	private draining = false;
	private redrainRequested = false;
	private disposed = false;

	constructor(options: WorkerTerminalHandoffCoordinatorOptions) {
		this.options = options;
	}

	get retainedCount(): number {
		return this.pending.size;
	}

	retained(): WorkerTerminalHandoff[] {
		return [...this.pending.values()].map(cloneHandoff);
	}

	/**
	 * Retain one terminal handoff snapshot. A structurally identical replay is inert. A newer projection of
	 * the same terminal edge (late usage moves `costUsd` and `completedAt`, a retired agent moves
	 * `agentStatus`) replaces the waiting payload, so delivery carries the current record. Two cases still
	 * fail closed: a different edge under the same attempt id, and a changed status or reason after a
	 * delivery attempt may already have written the parent's message for this attempt.
	 */
	retain(handoff: WorkerTerminalHandoff): WorkerTerminalHandoffRetention {
		this.assertActive();
		return this.adopt(snapshotHandoff(handoff));
	}

	/**
	 * Adopt a durable recovery snapshot one handoff at a time, then make one explicit delivery pass. A
	 * handoff that cannot be adopted is reported and stays durable for a later recovery pass; it never
	 * keeps the other handoffs of the same snapshot from their delivery.
	 */
	rehydrate(handoffs: readonly WorkerTerminalHandoff[]): WorkerTerminalHandoffRehydrationResult {
		this.assertActive();
		let added = 0;
		let replayed = 0;
		let refreshed = 0;
		const rejected: WorkerTerminalHandoffRejection[] = [];
		for (const handoff of handoffs) {
			try {
				const retention = this.adopt(snapshotHandoff(handoff));
				if (retention === "retained") added += 1;
				else if (retention === "replay") replayed += 1;
				else refreshed += 1;
			} catch (error) {
				rejected.push({ terminalAttemptId: handoff.terminalAttemptId, laneId: handoff.record.laneId, error });
			}
		}
		return { added, replayed, refreshed, rejected, drain: this.signal() };
	}

	private adopt(snapshot: WorkerTerminalHandoff): WorkerTerminalHandoffRetention {
		const attemptId = snapshot.terminalAttemptId;
		const existing = this.pending.get(attemptId);
		if (existing) {
			if (isDeepStrictEqual(existing, snapshot)) return "replay";
			if (
				!sameTerminalEdge(existing, snapshot) ||
				(this.deliveryAttempted.has(attemptId) && !sameDeliveredContent(existing, snapshot))
			) {
				throw new Error(`Worker terminal handoff attempt ${attemptId} conflicts with its retained payload.`);
			}
			this.pending.set(attemptId, snapshot);
			if (this.draining) this.redrainRequested = true;
			return "refreshed";
		}
		this.assertCapacity(this.pending.size + 1);
		this.pending.set(attemptId, snapshot);
		if (this.draining) this.redrainRequested = true;
		return "retained";
	}

	/** Explicit terminal/capacity/state-change event. Reentrant signals coalesce into a redrain. */
	signal(): WorkerTerminalHandoffDrainResult {
		if (this.disposed) return { attempted: 0, delivered: 0, errors: 0, retained: 0 };
		if (this.draining) {
			this.redrainRequested = true;
			return { attempted: 0, delivered: 0, errors: 0, retained: this.pending.size };
		}

		let attempted = 0;
		let delivered = 0;
		let errors = 0;
		let stagnantPasses = 0;
		this.draining = true;
		this.redrainRequested = true;
		try {
			while (this.redrainRequested && !this.disposed) {
				this.redrainRequested = false;
				const batch = [...this.pending.values()];
				let passChanged = false;
				for (const retained of batch) {
					if (this.disposed || this.pending.get(retained.terminalAttemptId) !== retained) continue;
					attempted += 1;
					this.deliveryAttempted.add(retained.terminalAttemptId);
					let result: WorkerTerminalHandoffDelivery;
					try {
						result = this.options.deliver(cloneHandoff(retained));
						if (result !== "delivered" && result !== "retained") {
							throw new TypeError("Worker terminal handoff delivery returned an invalid result.");
						}
					} catch (error) {
						errors += 1;
						this.reportDeliveryError(retained, error);
						continue;
					}
					// The attempt is delivered even when a refresh of its payload landed during delivery: one
					// handoff per attempt, so the refreshed entry leaves with it instead of delivering twice.
					if (result !== "delivered" || !this.pending.has(retained.terminalAttemptId)) continue;
					this.pending.delete(retained.terminalAttemptId);
					this.deliveryAttempted.delete(retained.terminalAttemptId);
					delivered += 1;
					passChanged = true;
				}

				if (passChanged || batch.some((entry) => this.pending.get(entry.terminalAttemptId) !== entry)) {
					stagnantPasses = 0;
				} else {
					stagnantPasses += 1;
				}
				// A self-signalling retained callback cannot spin forever. One unchanged redrain is enough
				// to observe every synchronous state mutation that preceded the nested signal.
				if (this.redrainRequested && stagnantPasses >= 2) this.redrainRequested = false;
			}
		} finally {
			this.draining = false;
			this.redrainRequested = false;
		}
		return { attempted, delivered, errors, retained: this.pending.size };
	}

	clear(): void {
		this.pending.clear();
		this.deliveryAttempted.clear();
		this.redrainRequested = false;
	}

	dispose(): void {
		this.disposed = true;
		this.clear();
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Worker terminal handoff coordinator is disposed.");
	}

	private assertCapacity(size: number): void {
		if (size <= MAX_ORCHESTRATION_ATTEMPTS) return;
		throw new Error(`Worker terminal handoff retention reached its ${MAX_ORCHESTRATION_ATTEMPTS} attempt limit.`);
	}

	private reportDeliveryError(handoff: WorkerTerminalHandoff, error: unknown): void {
		try {
			this.options.onDeliveryError?.(cloneHandoff(handoff), error);
		} catch {
			// Diagnostics cannot consume or unblock a retained terminal handoff.
		}
	}
}
