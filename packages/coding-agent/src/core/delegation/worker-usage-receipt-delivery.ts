import type { Usage } from "@caupulican/pi-ai";
import type { SpawnedUsageReceiptDisposition, SpawnedUsageReceiptOptions } from "../cost/spawned-usage-receipt.ts";
import { providerUsageFromAttemptUsage } from "../orchestration/attempt-usage.ts";
import type { OrchestrationEvent } from "../orchestration/contracts.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";

export interface WorkerUsageReceiptDeliveryDeps {
	parentSessionId: string;
	runtime: Pick<DurableTaskRuntime, "getSnapshot" | "acknowledgeUsageReceipt">;
	subscribe(listener: (event: OrchestrationEvent) => void): () => void;
	deliver(usage: Usage, options: SpawnedUsageReceiptOptions): SpawnedUsageReceiptDisposition;
	isDisposed(): boolean;
	warn(message: string): void;
}

/** Delivers durable received charges independently of execution completion and parent notification. */
export class WorkerUsageReceiptDelivery {
	private readonly deps: WorkerUsageReceiptDeliveryDeps;
	private readonly unsubscribe: () => void;
	private disposed = false;
	private scheduled = false;
	private flushing = false;

	constructor(deps: WorkerUsageReceiptDeliveryDeps) {
		this.deps = deps;
		this.unsubscribe = deps.subscribe((event) => {
			if (event.type === "attempt.usage_registered" || event.type === "attempt.usage_recorded") this.signal();
		});
		this.signal();
	}

	/** Called on accepted usage, initial recovery and the parent's foreground-idle persistence boundary. */
	signal(): void {
		if (this.disposed || this.scheduled || this.deps.isDisposed()) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.flush();
		});
	}

	private flush(): void {
		if (this.disposed || this.flushing || this.deps.isDisposed()) return;
		this.flushing = true;
		try {
			// Event-store observers run before the outer runtime adopts its admitted projection.
			// The microtask boundary above prevents acknowledgement from reentering that commit.
			const snapshot = this.deps.runtime.getSnapshot();
			for (const attempt of Object.values(snapshot.attempts)) {
				const receipts = Object.values(attempt.usageReceipts ?? {}).sort(
					(left, right) => Number(left.kind !== "baseline") - Number(right.kind !== "baseline"),
				);
				for (const receipt of receipts) {
					if (this.disposed || this.deps.isDisposed()) return;
					try {
						const reportId =
							receipt.kind === "baseline"
								? `worker:${this.deps.parentSessionId}:${attempt.taskId}`
								: `worker-usage:${this.deps.parentSessionId}:${attempt.attemptId}:${receipt.receiptId}`;
						const disposition = this.deps.deliver(providerUsageFromAttemptUsage(receipt.usage), {
							parentSessionId: this.deps.parentSessionId,
							reportId,
							label: "worker-delegation",
						});
						if (disposition === "foreign_session") return;
						// Never pass an unconfirmed baseline: its legacy report could already cover later usage.
						if (disposition !== "persisted") {
							if (receipt.kind === "baseline") break;
							continue;
						}
						// Parent persistence may synchronously retire this owner (for example through a
						// session-transition observer). Leave the durable receipt pending so the replacement
						// owner can deduplicate the completed parent write before acknowledging it.
						if (this.disposed || this.deps.isDisposed()) return;
						this.deps.runtime.acknowledgeUsageReceipt(attempt.attemptId, receipt.receiptId);
					} catch (error) {
						this.warn(
							`Worker usage receipt ${receipt.receiptId} remains pending: ${error instanceof Error ? error.message : String(error)}`,
						);
						break;
					}
				}
			}
		} catch (error) {
			this.warn(`Worker usage delivery remains pending: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.flushing = false;
		}
	}

	private warn(message: string): void {
		try {
			this.deps.warn(message);
		} catch {
			/* Receipt retention must survive diagnostic failures. */
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
	}
}
