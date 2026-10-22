import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { OrchestrationEvent } from "../orchestration/contracts.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import {
	workerReceiptCandidate,
	workerReceiptPublicationAllowed,
} from "../orchestration/worker-receipt-publication.ts";
import { ReceiptDeliveryLoop } from "./receipt-delivery-loop.ts";
import { WorkerReceiptParentLedger } from "./worker-receipt-parent-ledger.ts";

interface WorkerReceiptDeliveryDeps {
	readonly agentDir: string;
	readonly runtime: Pick<DurableTaskRuntime, "getSnapshot" | "acknowledgeWorkerReceipts">;
	getSessionManager(): SessionManager;
	subscribe(listener: (event: OrchestrationEvent) => void): () => void;
	isDisposed(): boolean;
	warn(message: string): void;
}

/** Result-owned obligations survive notification delivery, branch changes and process restart. */
export class WorkerReceiptDelivery {
	private readonly deps: WorkerReceiptDeliveryDeps;
	private readonly loop: ReceiptDeliveryLoop;
	private readonly reported = new Set<string>();
	private readonly parentLedger = new WorkerReceiptParentLedger();

	constructor(deps: WorkerReceiptDeliveryDeps) {
		this.deps = deps;
		this.loop = new ReceiptDeliveryLoop({
			subscribe: (signal) => [
				deps.subscribe((event) => {
					if (event.type === "attempt.finished" || event.type === "task.verification_finished") signal();
				}),
				deps.getSessionManager().onEntriesPersisted(signal),
			],
			isDisposed: () => deps.isDisposed(),
			flush: () => this.flush(),
			warn: (message) => deps.warn(message),
			failureMessage: "Worker receipt recovery remains pending",
		});
	}

	signal(): void {
		this.loop.signal();
	}

	private flush(): void {
		if (!this.loop.active) return;
		const attemptIds = Object.keys(this.deps.runtime.getSnapshot().attempts);
		for (const attemptId of attemptIds) {
			if (!this.loop.active) return;
			const snapshot = this.deps.runtime.getSnapshot();
			const attempt = snapshot.attempts[attemptId];
			if (!attempt) continue;
			if (attempt.receiptAcknowledgement || !workerReceiptPublicationAllowed(snapshot, attempt)) continue;
			const candidate = workerReceiptCandidate(snapshot, attempt);
			if (!candidate) continue;
			let changed = false;
			const unsubscribe = this.deps.subscribe(() => {
				changed = true;
				this.signal();
			});
			try {
				const acknowledgement = this.parentLedger.publish(
					this.deps.agentDir,
					this.deps.getSessionManager(),
					candidate,
					() => {
						if (changed || !this.loop.active) throw new Error("Worker receipt admission changed.");
					},
				);
				if (!acknowledgement || !this.loop.active) continue;
				this.deps.runtime.acknowledgeWorkerReceipts(attempt.attemptId, acknowledgement);
				this.reported.delete(attempt.attemptId);
			} catch (error) {
				if (this.reported.has(attempt.attemptId)) continue;
				this.reported.add(attempt.attemptId);
				this.loop.warn(
					`Worker receipt ${attempt.attemptId} remains pending: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				unsubscribe();
			}
		}
	}

	dispose(): void {
		this.loop.dispose();
	}
}
