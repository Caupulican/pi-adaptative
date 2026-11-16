import type { Usage } from "@caupulican/pi-ai";
import type { SpawnedUsageReceiptDisposition, SpawnedUsageReceiptOptions } from "../cost/spawned-usage-receipt.ts";
import { providerUsageFromAttemptUsage } from "../orchestration/attempt-usage.ts";
import type { OrchestrationEvent } from "../orchestration/contracts.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import { type AttemptRuntimeState, attemptModelBinding } from "../orchestration/task-runtime-state.ts";
import { ReceiptDeliveryLoop } from "./receipt-delivery-loop.ts";

/**
 * What the report id of every usage receipt of attempt `attemptId` a parent session `parentSessionId` records starts with
 * (its receipt's id follows): the attempt a recorded worker charge is of.
 */
export function workerUsageReportIdPrefix(parentSessionId: string, attemptId: string): string {
	return `worker-usage:${parentSessionId}:${attemptId}:`;
}

export interface WorkerUsageReceiptDeliveryDeps {
	parentSessionId: string;
	runtime: Pick<DurableTaskRuntime, "getSnapshot" | "acknowledgeUsageReceipt">;
	subscribe(listener: (event: OrchestrationEvent) => void): () => void;
	deliver(usage: Usage, options: SpawnedUsageReceiptOptions): SpawnedUsageReceiptDisposition;
	isDisposed(): boolean;
	warn(message: string): void;
}

/** The model a receipt was recorded on, as its report carries it (`SpawnedUsageReport.ranOn`), or not known. */
type ReceiptModel = { readonly provider: string; readonly model: string } | "unknown";

/**
 * Delivers durable received charges independently of execution completion and parent notification. A receipt's report
 * names the model the attempt's contract assigned (`provider`, `model`: what earlier builds name, so one of them
 * delivering it again matches the record) and the model it was recorded on (`ranOn`), fixed when this owner first takes
 * it up: a receipt recorded while this owner watched, whose attempt did not move model before, was recorded on the model
 * the attempt runs on then; one of an attempt that never moved, on its contract's model. Any other (recorded before this
 * owner watched by an attempt that has moved since, or recorded and then moved before it was taken up) was recorded on a
 * model not known here: its report fixes all of its cost as metered (`meteredUsd`), which is never laxer.
 */
export class WorkerUsageReceiptDelivery {
	private readonly deps: WorkerUsageReceiptDeliveryDeps;
	private readonly loop: ReceiptDeliveryLoop;
	/** Receipts recorded while this owner watched and not taken up yet, by receipt id: their attempt's id. */
	private readonly recordedHere = new Map<string, string>();
	/** The model each receipt taken up and not acknowledged yet was recorded on, by receipt id. */
	private readonly receiptModels = new Map<string, ReceiptModel>();

	constructor(deps: WorkerUsageReceiptDeliveryDeps) {
		this.deps = deps;
		this.loop = new ReceiptDeliveryLoop({
			subscribe: (signal) => [
				deps.subscribe((event) => {
					const attemptId = event.payload.attemptId;
					if (event.type === "attempt.model_moved" && typeof attemptId === "string") {
						// Recorded on the model it moved from, which this owner does not hold.
						for (const [receiptId, of] of this.recordedHere)
							if (of === attemptId) {
								this.recordedHere.delete(receiptId);
								this.receiptModels.set(receiptId, "unknown");
							}
						return;
					}
					if (event.type === "attempt.usage_registered" || event.type === "attempt.usage_recorded") {
						// A usage event's id is the id of the receipt it records.
						if (typeof attemptId === "string") this.recordedHere.set(event.eventId, attemptId);
						signal();
					}
				}),
			],
			isDisposed: () => deps.isDisposed(),
			flush: () => this.flush(),
			warn: (message) => deps.warn(message),
			failureMessage: "Worker usage delivery remains pending",
		});
	}

	/** Called on accepted usage, initial recovery and the parent's foreground-idle persistence boundary. */
	signal(): void {
		this.loop.signal();
	}

	/** The model receipt `receiptId` of `attempt` was recorded on, fixed the first time it is taken up (see the class). */
	private receiptModel(attempt: AttemptRuntimeState, receiptId: string): ReceiptModel {
		const fixed = this.receiptModels.get(receiptId);
		if (fixed !== undefined) return fixed;
		const binding = attemptModelBinding(attempt);
		const known = this.recordedHere.has(receiptId) || attempt.runningModel === undefined;
		const model: ReceiptModel = binding && known ? { provider: binding.provider, model: binding.modelId } : "unknown";
		this.recordedHere.delete(receiptId);
		this.receiptModels.set(receiptId, model);
		return model;
	}

	private flush(): void {
		if (!this.loop.active) return;
		// Event-store observers run before the outer runtime adopts its admitted projection.
		// The microtask boundary above prevents acknowledgement from reentering that commit.
		const snapshot = this.deps.runtime.getSnapshot();
		// What no attempt holds to deliver any more (acknowledged, pruned, or a usage event that recorded no receipt) is
		// dropped from what this owner keeps of its receipts.
		const held = new Set<string>();
		for (const attempt of Object.values(snapshot.attempts))
			for (const receiptId of Object.keys(attempt.usageReceipts ?? {})) held.add(receiptId);
		for (const receiptId of this.recordedHere.keys()) if (!held.has(receiptId)) this.recordedHere.delete(receiptId);
		for (const receiptId of this.receiptModels.keys()) if (!held.has(receiptId)) this.receiptModels.delete(receiptId);
		for (const attempt of Object.values(snapshot.attempts)) {
			const objectiveId = snapshot.tasks[attempt.taskId]?.task.objectiveId;
			const receipts = Object.values(attempt.usageReceipts ?? {}).sort(
				(left, right) => Number(left.kind !== "baseline") - Number(right.kind !== "baseline"),
			);
			for (const receipt of receipts) {
				if (!this.loop.active) return;
				try {
					// The model the contract assigned, and the one the receipt was recorded on, a failover's included: its spend is
					// classified by that one (metered or not), after the attempt is pruned too. A receipt delivered again keeps the
					// models of its first record.
					const assigned =
						receipt.kind === "baseline" ? undefined : attempt.dispatch.executionContract?.worker.modelBinding;
					const ranOn = receipt.kind === "baseline" ? undefined : this.receiptModel(attempt, receipt.receiptId);
					const usage = providerUsageFromAttemptUsage(receipt.usage);
					const reportId =
						receipt.kind === "baseline"
							? `worker:${this.deps.parentSessionId}:${attempt.taskId}`
							: `${workerUsageReportIdPrefix(this.deps.parentSessionId, attempt.attemptId)}${receipt.receiptId}`;
					const disposition = this.deps.deliver(usage, {
						parentSessionId: this.deps.parentSessionId,
						reportId,
						label: "worker-delegation",
						...(objectiveId?.startsWith("goal:") ? { goalId: objectiveId.slice("goal:".length) } : {}),
						...(assigned ? { provider: assigned.provider, model: assigned.modelId } : {}),
						...(ranOn === "unknown" ? { meteredUsd: usage.cost.total } : ranOn ? { ranOn } : {}),
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
					if (!this.loop.active) return;
					this.deps.runtime.acknowledgeUsageReceipt(attempt.attemptId, receipt.receiptId);
					this.receiptModels.delete(receipt.receiptId);
				} catch (error) {
					this.loop.warn(
						`Worker usage receipt ${receipt.receiptId} remains pending: ${error instanceof Error ? error.message : String(error)}`,
					);
					break;
				}
			}
		}
	}

	dispose(): void {
		this.loop.dispose();
	}
}
