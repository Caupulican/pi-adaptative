import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { WorkerDispatchScheduler } from "../src/core/delegation/worker-dispatch-scheduler.ts";
import { DEFAULT_WORKER_FLEET_LIMITS } from "../src/core/delegation/worker-fleet-limits.ts";
import type { InFlightWorkKind } from "../src/core/reload-blockers.ts";

function record(index: number): LaneRecord {
	return { laneId: `worker-${index}`, type: "worker", status: "queued" };
}

describe("WorkerDispatchScheduler queue bounds", () => {
	it("keeps dependency-waiting work queued and starts it once readiness changes", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-worker-scheduler-dependency-wait-"));
		let ready = false;
		const run = vi.fn(async () => ({ started: true as const }));
		const scheduler = new WorkerDispatchScheduler({
			agentDir,
			isDisposed: () => false,
			admit: () => (ready ? { action: "start" } : { action: "wait", reason: "dependencies" }),
			getRecord: () => record(0),
			run,
			cancel: vi.fn(),
			warn: vi.fn(),
		});
		try {
			scheduler.enqueue(record(0), { instructions: "wait for prerequisite" });
			scheduler.drain();
			expect(scheduler.queuedCount).toBe(1);
			expect(run).not.toHaveBeenCalled();

			ready = true;
			scheduler.drain();
			expect(scheduler.queuedCount).toBe(0);
			expect(run).toHaveBeenCalledOnce();
			await Promise.resolve();
		} finally {
			scheduler.cancelQueued();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("reaches blocked-dependency cancellation fixed point independent of queue order", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-worker-scheduler-dependency-cascade-"));
		let dependencyCancelled = false;
		const cancel = vi.fn((laneId: string) => {
			if (laneId === "worker-1") dependencyCancelled = true;
		});
		const scheduler = new WorkerDispatchScheduler({
			agentDir,
			isDisposed: () => false,
			admit: (_request, lane) => {
				if (lane.laneId === "worker-0") {
					return dependencyCancelled
						? { action: "cancel", reasonCode: "dependency_failed_or_cancelled" }
						: { action: "wait", reason: "dependencies" };
				}
				return { action: "cancel", reasonCode: "dependency_failed" };
			},
			getRecord: (laneId) => (laneId === "worker-0" ? record(0) : laneId === "worker-1" ? record(1) : undefined),
			run: async () => ({ started: false, skipReason: "not_run" }),
			cancel,
			warn: vi.fn(),
		});
		try {
			// The dependent deliberately appears first: one drain must still settle the full cascade.
			scheduler.enqueue(record(0), { instructions: "dependent" });
			scheduler.enqueue(record(1), { instructions: "failed prerequisite" });
			scheduler.drain();

			expect(cancel.mock.calls.map(([laneId]) => laneId)).toEqual(["worker-1", "worker-0"]);
			expect(scheduler.queuedCount).toBe(0);
		} finally {
			scheduler.cancelQueued();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("retains reentrant reservation availability when cancellation releases a fence during drain", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-worker-scheduler-reentrant-reservation-"));
		let reservationAvailable = false;
		const run = vi.fn(async () => ({ started: true as const }));
		let scheduler!: WorkerDispatchScheduler;
		scheduler = new WorkerDispatchScheduler({
			agentDir,
			isDisposed: () => false,
			admit: (_request, lane) => {
				if (lane.laneId === "worker-0") return { action: "cancel", reasonCode: "dependency_failed" };
				return reservationAvailable ? { action: "start" } : { action: "wait", reason: "write_reservation" };
			},
			getRecord: (laneId) => (laneId === "worker-0" ? record(0) : laneId === "worker-1" ? record(1) : undefined),
			run,
			cancel: () => {
				reservationAvailable = true;
				scheduler.drain(true);
			},
			warn: vi.fn(),
		});
		try {
			scheduler.enqueue(record(1), { instructions: "reservation blocked" });
			scheduler.drain();
			expect(scheduler.queuedCount).toBe(1);

			// Priority insertion makes cancellation happen before the already-blocked lane is inspected.
			scheduler.enqueue(record(0), { instructions: "cancel and release" }, false, true);
			scheduler.drain();

			expect(scheduler.queuedCount).toBe(0);
			expect(run).toHaveBeenCalledOnce();
			await Promise.resolve();
		} finally {
			scheduler.cancelQueued();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("clears a stale reservation marker when admission changes to another wait reason", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-worker-scheduler-changing-wait-"));
		let admission: "write_reservation" | "capacity" | "start" = "write_reservation";
		const run = vi.fn(async () => ({ started: true as const }));
		const scheduler = new WorkerDispatchScheduler({
			agentDir,
			isDisposed: () => false,
			admit: () => (admission === "start" ? { action: "start" } : { action: "wait", reason: admission }),
			getRecord: () => record(0),
			run,
			cancel: vi.fn(),
			warn: vi.fn(),
		});
		try {
			scheduler.enqueue(record(0), { instructions: "wait through changing pressure" });
			scheduler.drain();
			admission = "capacity";
			scheduler.drain(true);
			admission = "start";
			scheduler.drain();

			expect(scheduler.queuedCount).toBe(0);
			expect(run).toHaveBeenCalledOnce();
			await Promise.resolve();
		} finally {
			scheduler.cancelQueued();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("rolls back queue insertion when reload-gate registration fails", () => {
		const scheduler = new WorkerDispatchScheduler({
			agentDir: "/unused",
			registerInFlightWork: () => {
				throw new Error("registration_failed");
			},
			isDisposed: () => false,
			admit: () => ({ action: "wait", reason: "capacity" }),
			getRecord: () => undefined,
			run: async () => ({ started: false, skipReason: "not_run" }),
			cancel: () => undefined,
			warn: () => undefined,
		});

		expect(() => scheduler.enqueue(record(0), { instructions: "must roll back" })).toThrow("registration_failed");
		expect(scheduler.queuedCount).toBe(0);
	});

	it.each(["not-started", "rejected"] as const)(
		"retains %s work for event-driven durable cancellation without rerunning it",
		async (failureMode) => {
			const lane = record(0);
			let cancellationAvailable = false;
			const pendingCancellationDeregister = vi.fn();
			const registerInFlightWork = vi.fn((_agentDir: string, _kind: InFlightWorkKind, label: string) =>
				label.startsWith("worker-cancellation-pending:") ? pendingCancellationDeregister : () => undefined,
			);
			const cancel = vi.fn(() => {
				if (!cancellationAvailable) throw new Error("durable cancellation failed");
			});
			const warn = vi.fn(() => {
				throw new Error("warning observer failed");
			});
			const run = vi.fn(async () => {
				if (failureMode === "rejected") throw new Error("worker run failed");
				return { started: false as const, skipReason: "worker_not_started" };
			});
			const scheduler = new WorkerDispatchScheduler({
				agentDir: "/unused",
				registerInFlightWork,
				isDisposed: () => false,
				admit: () => ({ action: "start" }),
				getRecord: () => lane,
				run,
				cancel,
				warn,
			});

			scheduler.enqueue(lane, { instructions: "first run" });
			scheduler.drain();
			await Promise.resolve();

			// Promise settlement triggers one bounded retry. Repeated failure remains owned without
			// allowing the possibly-started operation to be dispatched again.
			expect(cancel).toHaveBeenCalledTimes(2);
			expect(
				registerInFlightWork.mock.calls.some(([_agentDir, _kind, label]) =>
					label.startsWith("worker-cancellation-pending:"),
				),
			).toBe(true);
			scheduler.enqueue(lane, { instructions: "must not rerun" });
			expect(scheduler.queuedCount).toBe(0);
			expect(run).toHaveBeenCalledOnce();

			cancellationAvailable = true;
			scheduler.drain();

			expect(cancel).toHaveBeenCalledTimes(3);
			expect(pendingCancellationDeregister).toHaveBeenCalledOnce();
			expect(warn).toHaveBeenCalled();
			expect(scheduler.queuedCount).toBe(0);
		},
	);

	it("retains admission-cancel work when durable cancellation throws and retries on the next drain", () => {
		const lane = record(0);
		let cancellationAvailable = false;
		const cancel = vi.fn(() => {
			if (!cancellationAvailable) throw new Error("durable cancellation failed");
		});
		const warn = vi.fn();
		const scheduler = new WorkerDispatchScheduler({
			agentDir: "/unused",
			registerInFlightWork: () => () => undefined,
			isDisposed: () => false,
			admit: () => ({ action: "cancel", reasonCode: "dependency_failed" }),
			getRecord: () => lane,
			run: async () => ({ started: false, skipReason: "must_not_run" }),
			cancel,
			warn,
		});

		scheduler.enqueue(lane, { instructions: "cancel durably" });
		scheduler.drain();

		expect(cancel).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledOnce();
		expect(scheduler.queuedCount).toBe(1);

		cancellationAvailable = true;
		scheduler.drain();

		expect(cancel).toHaveBeenCalledTimes(2);
		expect(scheduler.queuedCount).toBe(0);
	});

	it("routes a synchronous run throw through tracked rejection cleanup", async () => {
		const lane = record(0);
		let runCount = 0;
		const run = vi.fn(() => {
			runCount += 1;
			if (runCount === 1) throw new Error("synchronous worker start failure");
			return Promise.resolve({ started: true as const });
		});
		const cancel = vi.fn();
		const warn = vi.fn();
		const scheduler = new WorkerDispatchScheduler({
			agentDir: "/unused",
			registerInFlightWork: () => () => undefined,
			isDisposed: () => false,
			admit: () => ({ action: "start" }),
			getRecord: () => lane,
			run,
			cancel,
			warn,
		});

		scheduler.enqueue(lane, { instructions: "throw synchronously" });
		expect(() => scheduler.drain()).not.toThrow();
		await Promise.resolve();

		expect(cancel).toHaveBeenCalledWith(lane.laneId, "worker_background_error");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("synchronous worker start failure"));

		scheduler.enqueue(lane, { instructions: "healthy retry" });
		scheduler.drain();
		await Promise.resolve();
		expect(run).toHaveBeenCalledTimes(2);
		expect(scheduler.queuedCount).toBe(0);
	});

	it.each(["start", "cancel"] as const)(
		"contains a throwing reload-gate deregister while preserving %s admission",
		async (action) => {
			const lane = record(0);
			const deregister = vi.fn(() => {
				throw new Error("reload-gate deregistration failed");
			});
			const run = vi.fn(async () => ({ started: true as const }));
			const cancel = vi.fn();
			const warn = vi.fn();
			const scheduler = new WorkerDispatchScheduler({
				agentDir: "/unused",
				registerInFlightWork: () => deregister,
				isDisposed: () => false,
				admit: () =>
					action === "start" ? { action: "start" } : { action: "cancel", reasonCode: "dependency_failed" },
				getRecord: () => lane,
				run,
				cancel,
				warn,
			});

			scheduler.enqueue(lane, { instructions: `${action} after deregistration` });
			expect(() => scheduler.drain()).not.toThrow();
			await Promise.resolve();

			expect(deregister).toHaveBeenCalledOnce();
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("reload-gate deregistration failed"));
			expect(scheduler.queuedCount).toBe(0);
			expect(run).toHaveBeenCalledTimes(action === "start" ? 1 : 0);
			expect(cancel).toHaveBeenCalledTimes(action === "cancel" ? 1 : 0);
		},
	);

	it.each(["not-started", "rejected"] as const)(
		"preserves normal %s cleanup before admitting the lane again",
		async (failureMode) => {
			const lane = record(0);
			let runCount = 0;
			const cancel = vi.fn();
			const warn = vi.fn();
			const run = vi.fn(async () => {
				runCount += 1;
				if (runCount === 1) {
					if (failureMode === "rejected") throw new Error("worker run failed");
					return { started: false as const, skipReason: "worker_not_started" };
				}
				return { started: true as const };
			});
			const scheduler = new WorkerDispatchScheduler({
				agentDir: "/unused",
				registerInFlightWork: () => () => undefined,
				isDisposed: () => false,
				admit: () => ({ action: "start" }),
				getRecord: () => lane,
				run,
				cancel,
				warn,
			});

			scheduler.enqueue(lane, { instructions: "first run" });
			scheduler.drain();
			await Promise.resolve();
			scheduler.enqueue(lane, { instructions: "second run" });
			scheduler.drain();
			await Promise.resolve();

			expect(run).toHaveBeenCalledTimes(2);
			expect(cancel).toHaveBeenCalledOnce();
			expect(warn).toHaveBeenCalledTimes(failureMode === "rejected" ? 1 : 0);
			expect(scheduler.queuedCount).toBe(0);
		},
	);

	it("reserves one bounded slot for priority verifier work", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-worker-scheduler-"));
		const scheduler = new WorkerDispatchScheduler({
			agentDir,
			isDisposed: () => false,
			admit: () => ({ action: "wait", reason: "capacity" }),
			getRecord: () => undefined,
			run: async () => ({ started: false, skipReason: "not_run" }),
			cancel: () => undefined,
			warn: () => undefined,
		});
		try {
			const ordinaryCeiling = DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 1;
			for (let index = 0; index < ordinaryCeiling; index += 1) {
				scheduler.enqueue(record(index), { instructions: `ordinary-${index}` });
			}
			expect(scheduler.queuedCount).toBe(ordinaryCeiling);
			expect(() => scheduler.enqueue(record(ordinaryCeiling), { instructions: "ordinary-overflow" })).toThrow(
				"worker_dispatch_queue_full",
			);

			scheduler.enqueue(record(ordinaryCeiling), { instructions: "mandatory-verifier" }, false, true);
			expect(scheduler.queuedCount).toBe(DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches);
			expect(() =>
				scheduler.enqueue(record(ordinaryCeiling + 1), { instructions: "priority-overflow" }, false, true),
			).toThrow("worker_dispatch_queue_full");
		} finally {
			scheduler.cancelQueued();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("coalesces released queue slots into an event-driven capacity notification", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-worker-scheduler-capacity-"));
		const scheduler = new WorkerDispatchScheduler({
			agentDir,
			isDisposed: () => false,
			admit: () => ({ action: "wait", reason: "capacity" }),
			getRecord: () => undefined,
			run: async () => ({ started: false, skipReason: "not_run" }),
			cancel: () => undefined,
			warn: () => undefined,
		});
		const capacityAvailable = vi.fn();
		const unsubscribe = scheduler.onQueueCapacityAvailable(capacityAvailable);
		try {
			for (let index = 0; index < DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches; index += 1) {
				scheduler.enqueue(record(index), { instructions: `priority-${index}` }, false, true);
			}
			expect(scheduler.hasQueueCapacity(true)).toBe(false);

			scheduler.dropQueued("worker-0");
			scheduler.dropQueued("worker-1");
			await Promise.resolve();

			expect(capacityAvailable).toHaveBeenCalledTimes(1);
			expect(scheduler.queuedCount).toBe(DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 2);
			expect(scheduler.hasQueueCapacity(true)).toBe(true);
		} finally {
			unsubscribe();
			scheduler.cancelQueued();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("contains throwing queue-capacity listeners and their warning observer", async () => {
		const lane = record(0);
		const warn = vi.fn(() => {
			throw new Error("warning observer failed");
		});
		const scheduler = new WorkerDispatchScheduler({
			agentDir: "/unused",
			registerInFlightWork: () => () => undefined,
			isDisposed: () => false,
			admit: () => ({ action: "wait", reason: "capacity" }),
			getRecord: () => lane,
			run: async () => ({ started: false, skipReason: "must_not_run" }),
			cancel: () => undefined,
			warn,
		});
		const capacityAvailable = vi.fn(() => {
			throw new Error("capacity listener failed");
		});
		const unsubscribe = scheduler.onQueueCapacityAvailable(capacityAvailable);

		scheduler.enqueue(lane, { instructions: "release one queue slot" });
		expect(scheduler.dropQueued(lane.laneId)).toBe(true);
		await Promise.resolve();

		expect(capacityAvailable).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledOnce();
		expect(scheduler.queuedCount).toBe(0);
		unsubscribe();
	});

	it("contains one disposal cancellation failure and releases every queued process blocker", () => {
		const cancel = vi.fn((laneId: string) => {
			if (laneId === "worker-0") throw new Error("durable cancellation unavailable");
		});
		const deregisters = [vi.fn(), vi.fn()];
		const warn = vi.fn();
		let registration = 0;
		const scheduler = new WorkerDispatchScheduler({
			agentDir: "/unused",
			registerInFlightWork: () => deregisters[registration++]!,
			isDisposed: () => true,
			admit: () => ({ action: "wait", reason: "capacity" }),
			getRecord: () => undefined,
			run: async () => ({ started: false, skipReason: "must_not_run" }),
			cancel,
			warn,
		});
		scheduler.enqueue(record(0), { instructions: "first queued lane" });
		scheduler.enqueue(record(1), { instructions: "second queued lane" });

		expect(() => scheduler.cancelQueued()).not.toThrow();

		expect(cancel.mock.calls.map(([laneId]) => laneId)).toEqual(["worker-0", "worker-1"]);
		expect(deregisters[0]).toHaveBeenCalledOnce();
		expect(deregisters[1]).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("durable cancellation unavailable"));
		expect(scheduler.queuedCount).toBe(0);
	});
});
