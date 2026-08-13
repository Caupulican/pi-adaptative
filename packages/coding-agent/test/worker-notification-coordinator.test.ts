import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { WorkerNotificationCoordinator } from "../src/core/delegation/worker-notification-coordinator.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("WorkerNotificationCoordinator", () => {
	it("does not redispatch one in-flight terminal handoff after the former timeout boundary", async () => {
		vi.useFakeTimers();
		const record: LaneRecord = {
			laneId: "worker-long-foreground",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-12T00:00:00.000Z",
		};
		let resolveNotify!: () => void;
		const notifyPending = new Promise<void>((resolve) => {
			resolveNotify = resolve;
		});
		const notify = vi.fn(() => notifyPending);
		const markDurableDelivered = vi.fn();
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: vi.fn(),
			notify,
			warn: vi.fn(),
			markDurableDelivered,
		});

		coordinator.recordTerminal(record, "notification-long-foreground");
		await vi.advanceTimersByTimeAsync(0);
		expect(notify).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(1_800_001);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(notify).toHaveBeenCalledOnce();
		expect(markDurableDelivered).not.toHaveBeenCalled();

		resolveNotify();
		await vi.runAllTimersAsync();
		expect(markDurableDelivered).toHaveBeenCalledOnce();
		expect(markDurableDelivered).toHaveBeenCalledWith(["notification-long-foreground"]);
		coordinator.dispose();
	});

	it("retains goal ownership on a durable terminal notification", async () => {
		vi.useFakeTimers();
		const record: LaneRecord = {
			laneId: "worker-goal-terminal",
			type: "worker",
			status: "succeeded",
			goalId: "goal-runaway",
			completedAt: "2026-08-12T00:00:00.000Z",
		};
		const notify = vi.fn(async () => undefined);
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: vi.fn(),
			notify,
			warn: vi.fn(),
			markDurableDelivered: vi.fn(),
		});

		coordinator.recordTerminal(record, "notification-goal-terminal");
		await vi.runAllTimersAsync();

		expect(notify).toHaveBeenCalledWith([
			{
				laneId: "worker-goal-terminal",
				status: "succeeded",
				goalId: "goal-runaway",
			},
		]);
		coordinator.dispose();
	});

	it("retries a lone transient terminal notification failure without an unrelated state event", async () => {
		vi.useFakeTimers();
		const record: LaneRecord = {
			laneId: "worker-terminal-retry",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-07T00:00:00.000Z",
		};
		const notify = vi
			.fn<(records: readonly { laneId: string }[]) => Promise<void>>()
			.mockRejectedValueOnce(new Error("simulated transient notification failure"))
			.mockResolvedValue(undefined);
		const markDurableDelivered = vi.fn();
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: vi.fn(),
			notify,
			warn: vi.fn(),
			markDurableDelivered,
		});

		coordinator.recordTerminal(record, "notification-terminal-retry");
		await vi.runAllTimersAsync();

		expect(notify).toHaveBeenCalledTimes(2);
		expect(markDurableDelivered).toHaveBeenCalledOnce();
		expect(markDurableDelivered).toHaveBeenCalledWith(["notification-terminal-retry"]);
		coordinator.dispose();
	});

	it("delivers and commits a terminal notification when status observers throw", async () => {
		vi.useFakeTimers();
		const record: LaneRecord = {
			laneId: "worker-terminal-status-observer",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-07T00:00:00.000Z",
		};
		const notify = vi.fn(async () => undefined);
		const markDurableDelivered = vi.fn();
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: () => {
				throw new Error("simulated status observer failure");
			},
			notify,
			warn: () => {
				throw new Error("simulated warning observer failure");
			},
			markDurableDelivered,
		});

		coordinator.recordTerminal(record, "notification-status-observer");
		await vi.runAllTimersAsync();

		expect(notify).toHaveBeenCalledOnce();
		expect(markDurableDelivered).toHaveBeenCalledWith(["notification-status-observer"]);
		coordinator.dispose();
	});

	it("delivers and commits a terminal notification when worker status projection throws", async () => {
		vi.useFakeTimers();
		const record: LaneRecord = {
			laneId: "worker-terminal-status-projection",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-07T00:00:00.000Z",
		};
		const notify = vi.fn(async () => undefined);
		const markDurableDelivered = vi.fn();
		const emitStatus = vi.fn();
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => {
				throw new Error("simulated worker status projection failure");
			},
			emitStatus,
			notify,
			warn: () => {
				throw new Error("simulated warning observer failure");
			},
			markDurableDelivered,
		});

		coordinator.recordTerminal(record, "notification-status-projection");
		await vi.runAllTimersAsync();

		expect(emitStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				active: 0,
				terminalSinceFlush: [expect.objectContaining({ laneId: record.laneId })],
			}),
		);
		expect(notify).toHaveBeenCalledOnce();
		expect(markDurableDelivered).toHaveBeenCalledWith(["notification-status-projection"]);
		coordinator.dispose();
	});

	it("keeps partial and blocked handoffs out of the actual failure counter", async () => {
		vi.useFakeTimers();
		const records: LaneRecord[] = [
			{ laneId: "worker-partial", type: "worker", status: "partial" },
			{ laneId: "worker-blocked", type: "worker", status: "blocked" },
		];
		const emitStatus = vi.fn();
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => records,
			emitStatus,
			notify: async () => undefined,
			warn: vi.fn(),
			markDurableDelivered: vi.fn(),
		});

		for (const record of records) coordinator.recordTerminal(record);
		await vi.runAllTimersAsync();

		expect(emitStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				completedSinceFlush: 0,
				failedSinceFlush: 0,
				terminalSinceFlush: [
					expect.objectContaining({ status: "partial" }),
					expect.objectContaining({ status: "blocked" }),
				],
			}),
		);
		coordinator.dispose();
	});
});
