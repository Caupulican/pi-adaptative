import { describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { WorkerDispatchScheduler } from "../src/core/delegation/worker-dispatch-scheduler.ts";

describe("worker asynchronous dispatch preflight", () => {
	it("does not apply an old probe to a re-enqueued lane with the same id", async () => {
		const oldProbe = Promise.withResolvers<{ action: "start" }>();
		const newProbe = Promise.withResolvers<{ action: "start" }>();
		const dispatched = Promise.withResolvers<void>();
		const record: LaneRecord = { laneId: "replayed", type: "worker", status: "queued" };
		const preflight = vi.fn().mockReturnValueOnce(oldProbe.promise).mockReturnValueOnce(newProbe.promise);
		const run = vi.fn(async () => {
			dispatched.resolve();
			return { started: true as const };
		});
		const scheduler = new WorkerDispatchScheduler({
			agentDir: "synthetic",
			registerInFlightWork: () => () => {},
			isDisposed: () => false,
			admit: () => ({ action: "start" }),
			preflight,
			getRecord: () => record,
			run,
			cancel: () => {},
			warn: () => {},
		});
		scheduler.enqueue(record, { instructions: "Old work" });
		scheduler.drain();
		scheduler.dropQueued(record.laneId);
		scheduler.enqueue(record, { instructions: "New work" });
		scheduler.drain();
		oldProbe.resolve({ action: "start" });
		await oldProbe.promise;
		expect(run).not.toHaveBeenCalled();
		newProbe.resolve({ action: "start" });
		await dispatched.promise;
		expect(run).toHaveBeenCalledExactlyOnceWith({ instructions: "New work" }, record);
	});

	it("retains queue ownership when the post-preflight policy check throws", async () => {
		const warning = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<{ action: "start" }>();
		const record: LaneRecord = { laneId: "fixture", type: "worker", status: "queued" };
		let checks = 0;
		let blockers = 0;
		const run = vi.fn(async () => ({ started: true as const }));
		const scheduler = new WorkerDispatchScheduler({
			agentDir: "synthetic",
			isDisposed: () => false,
			registerInFlightWork: () => {
				blockers++;
				return () => {
					blockers--;
				};
			},
			admit: () => {
				if (++checks === 2) throw new Error("Synthetic policy read failed");
				return { action: "start" };
			},
			preflight: () => ready.promise,
			getRecord: () => record,
			run,
			cancel: () => {},
			warn: () => warning.resolve(),
		});
		scheduler.enqueue(record, { instructions: "Synthetic work" });
		scheduler.drain();
		ready.resolve({ action: "start" });
		await warning.promise;
		expect(run).not.toHaveBeenCalled();
		expect(scheduler.queuedCount).toBe(1);
		expect(blockers).toBe(1);
		scheduler.cancelQueued();
		expect(blockers).toBe(0);
	});

	it("keeps queued work visible and rechecks capacity after validation, without dropping the second worker", async () => {
		const ready = Promise.withResolvers<void>();
		const running = Promise.withResolvers<{ started: true }>();
		const dispatched = Promise.withResolvers<void>();
		let busy = false;
		let blockers = 0;
		const records = new Map<string, LaneRecord>(
			["first", "second"].map((laneId) => [laneId, { laneId, type: "worker", status: "queued" }]),
		);
		const run = vi.fn(() => {
			busy = true;
			dispatched.resolve();
			return running.promise;
		});
		const cancel = vi.fn();
		const scheduler = new WorkerDispatchScheduler({
			agentDir: "synthetic",
			registerInFlightWork: () => {
				blockers++;
				return () => {
					blockers--;
				};
			},
			isDisposed: () => false,
			admit: () => (busy ? { action: "wait", reason: "capacity" } : { action: "start" }),
			preflight: async () => {
				await ready.promise;
				return { action: "start" };
			},
			getRecord: (id) => records.get(id),
			run,
			cancel,
			warn: () => {},
		});
		for (const record of records.values()) scheduler.enqueue(record, { instructions: "Synthetic work" });
		scheduler.drain();
		expect(run).not.toHaveBeenCalled();
		expect(blockers).toBe(2);
		ready.resolve();
		await dispatched.promise;
		expect(run).toHaveBeenCalledTimes(1);
		expect(scheduler.queuedCount).toBe(1);
		expect(blockers).toBe(1);
		expect(cancel).not.toHaveBeenCalled();
		scheduler.cancelQueued();
		running.resolve({ started: true });
	});

	it("does not resurrect canceled work after its filesystem probe completes", async () => {
		const ready = Promise.withResolvers<{ action: "start" }>();
		const run = vi.fn(async () => ({ started: true as const }));
		const record: LaneRecord = { laneId: "fixture", type: "worker", status: "queued" };
		const scheduler = new WorkerDispatchScheduler({
			agentDir: "synthetic",
			registerInFlightWork: () => () => {},
			isDisposed: () => false,
			admit: () => ({ action: "start" }),
			preflight: () => ready.promise,
			getRecord: () => record,
			run,
			cancel: () => {},
			warn: () => {},
		});
		scheduler.enqueue(record, { instructions: "Synthetic work" });
		scheduler.drain();
		scheduler.cancelQueued();
		ready.resolve({ action: "start" });
		await ready.promise;
		await Promise.resolve();
		expect(run).not.toHaveBeenCalled();
		expect(scheduler.queuedCount).toBe(0);
	});
});
