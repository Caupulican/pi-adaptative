import { describe, expect, it, vi } from "vitest";
import type { WorkerDelegationRunOutcome } from "../src/core/agent-session-contracts.ts";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { WorkerDispatchScheduler } from "../src/core/delegation/worker-dispatch-scheduler.ts";

describe("scheduler cancellation intent and start evidence", () => {
	it.each(["preflight", "admission"] as const)(
		"retains %s cancellation intent across another failed write",
		async (phase) => {
			let cancelled = false;
			let refusal = true;
			let failWrite = true;
			let notifyCancellation!: () => void;
			const firstCancellation = new Promise<void>((resolve) => {
				notifyCancellation = resolve;
			});
			const run = vi.fn(
				async (): Promise<WorkerDelegationRunOutcome> => ({ started: false, skipReason: "unexpected_run" }),
			);
			const record: LaneRecord = { laneId: "cancel-intent", agentId: "worker", type: "worker", status: "queued" };
			const decision = () =>
				refusal ? { action: "cancel" as const, reasonCode: "original_refusal" } : { action: "start" as const };
			const scheduler = new WorkerDispatchScheduler({
				agentDir: "owned-test-seam",
				registerInFlightWork: () => () => {},
				isDisposed: () => false,
				getRecord: () => record,
				admit: () => (phase === "admission" ? decision() : { action: "start" }),
				...(phase === "preflight" ? { preflight: async () => decision() } : {}),
				run,
				warn: () => {},
				cancel: (_lane, reason) => {
					notifyCancellation();
					if (failWrite) throw new Error("owned write failure");
					expect(reason).toBe("original_refusal");
					cancelled = true;
				},
			});
			scheduler.enqueue(record, { instructions: "must cancel" });
			const observed = scheduler.observeLane(record.laneId);
			try {
				scheduler.drain();
				await firstCancellation;
				refusal = false;
				scheduler.drain();
				// Drain the asynchronous preflight decision, if the broken scheduler starts a second one.
				await Promise.resolve();
				expect(run).not.toHaveBeenCalled();
				expect(cancelled).toBe(false);
				expect(scheduler.ownsLane(record.laneId)).toBe(true);
				failWrite = false;
				scheduler.drain();
				await expect(observed).resolves.toEqual({ state: "cancelled", reasonCode: "original_refusal" });
			} finally {
				failWrite = false;
				scheduler.cancelQueued();
			}
		},
	);

	it.each(["queued", "canceled", "running"] as const)(
		"announces only actual running state, with projection %s",
		async (status) => {
			const record: LaneRecord = { laneId: "start-evidence", type: "worker", status };
			let projection: LaneRecord = { ...record, status: "queued" };
			let settle!: (outcome: WorkerDelegationRunOutcome) => void;
			const completion = new Promise<WorkerDelegationRunOutcome>((resolve) => {
				settle = resolve;
			});
			const scheduler = new WorkerDispatchScheduler({
				agentDir: "owned-test-seam",
				registerInFlightWork: () => () => {},
				isDisposed: () => false,
				getRecord: () => projection,
				admit: () => ({ action: "start" }),
				run: () => {
					projection = record;
					return completion;
				},
				cancel: () => {},
				warn: () => {},
			});
			scheduler.enqueue(record, { instructions: "start evidence" });
			const early = vi.fn();
			const late = vi.fn();
			const first = scheduler.observeLane(record.laneId, { onStarted: early });
			scheduler.drain();
			const second = scheduler.observeLane(record.laneId, { onStarted: late });
			settle(status === "running" ? { started: true, record } : { started: false, skipReason: "setup_refused" });
			await Promise.all([first, second]);
			expect(early).toHaveBeenCalledTimes(status === "running" ? 1 : 0);
			expect(late).toHaveBeenCalledTimes(status === "running" ? 1 : 0);
		},
	);
});
