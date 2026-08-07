import { isDeepStrictEqual } from "node:util";
import { isLaneRecord, isLaneTerminalStatus, type LaneRecord } from "../autonomy/lane-tracker.ts";
import { MAX_ORCHESTRATION_ATTEMPTS, MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "../orchestration/contracts.ts";

export interface WorkerTerminalHandoff {
	terminalAttemptId: string;
	parentAgentId: string;
	childAgentId: string;
	record: LaneRecord;
}

/** Per-entry ceiling; combined with the durable attempt cap this bounds retained memory to 4 MiB. */
export const MAX_WORKER_TERMINAL_HANDOFF_BYTES = 16 * 1024;

export type WorkerTerminalHandoffDelivery = "delivered" | "retained";
export type WorkerTerminalHandoffRetention = "retained" | "replay";

export interface WorkerTerminalHandoffDrainResult {
	attempted: number;
	delivered: number;
	errors: number;
	retained: number;
}

export interface WorkerTerminalHandoffRehydrationResult {
	added: number;
	replayed: number;
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
	const snapshot = { ...handoff, record: { ...handoff.record } };
	if (Buffer.byteLength(JSON.stringify(snapshot), "utf-8") > MAX_WORKER_TERMINAL_HANDOFF_BYTES) {
		throw new TypeError(`Worker terminal handoff exceeds its ${MAX_WORKER_TERMINAL_HANDOFF_BYTES} byte limit.`);
	}
	return snapshot;
}

function cloneHandoff(handoff: WorkerTerminalHandoff): WorkerTerminalHandoff {
	return { ...handoff, record: { ...handoff.record } };
}

/**
 * Bounded process-local outbox for parent terminal handoffs. Delivery is driven only by explicit
 * terminal, capacity, state-change, and recovery calls; this owner never creates a timer or poll.
 */
export class WorkerTerminalHandoffCoordinator {
	private readonly options: WorkerTerminalHandoffCoordinatorOptions;
	private readonly pending = new Map<string, WorkerTerminalHandoff>();
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

	/** Retain one terminal handoff snapshot. Structurally identical pending replays are inert; conflicts fail closed. */
	retain(handoff: WorkerTerminalHandoff): WorkerTerminalHandoffRetention {
		this.assertActive();
		const snapshot = snapshotHandoff(handoff);
		const existing = this.pending.get(snapshot.terminalAttemptId);
		if (existing) {
			if (isDeepStrictEqual(existing, snapshot)) return "replay";
			throw new Error(
				`Worker terminal handoff attempt ${snapshot.terminalAttemptId} conflicts with its retained payload.`,
			);
		}
		this.assertCapacity(this.pending.size + 1);
		this.pending.set(snapshot.terminalAttemptId, snapshot);
		if (this.draining) this.redrainRequested = true;
		return "retained";
	}

	/**
	 * Atomically adopt a durable recovery snapshot, then make one explicit delivery pass. Repeated
	 * attempt IDs in the recovery snapshot must carry structurally equivalent data.
	 */
	rehydrate(handoffs: readonly WorkerTerminalHandoff[]): WorkerTerminalHandoffRehydrationResult {
		this.assertActive();
		const staged = new Map(this.pending);
		const additions: WorkerTerminalHandoff[] = [];
		let replayed = 0;
		for (const handoff of handoffs) {
			const snapshot = snapshotHandoff(handoff);
			const existing = staged.get(snapshot.terminalAttemptId);
			if (existing) {
				if (!isDeepStrictEqual(existing, snapshot)) {
					throw new Error(
						`Worker terminal handoff attempt ${snapshot.terminalAttemptId} conflicts with its retained payload.`,
					);
				}
				replayed += 1;
				continue;
			}
			this.assertCapacity(staged.size + 1);
			staged.set(snapshot.terminalAttemptId, snapshot);
			additions.push(snapshot);
		}
		for (const handoff of additions) this.pending.set(handoff.terminalAttemptId, handoff);
		return { added: additions.length, replayed, drain: this.signal() };
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
					if (result !== "delivered" || this.pending.get(retained.terminalAttemptId) !== retained) continue;
					this.pending.delete(retained.terminalAttemptId);
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
