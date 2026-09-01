import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import {
	WorkerNotificationCoordinator,
	type WorkerTerminalHandoffRecord,
} from "../src/core/delegation/worker-notification-coordinator.ts";

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
		const warn = vi.fn();
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: vi.fn(),
			notify,
			warn,
			markDurableDelivered,
		});

		coordinator.recordTerminal(record, "notification-long-foreground");
		await vi.advanceTimersByTimeAsync(0);
		expect(notify).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(1_800_001);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(notify).toHaveBeenCalledOnce();
		expect(markDurableDelivered).not.toHaveBeenCalled();
		// The unsettled handoff crossed the observation threshold: the watchdog must warn (visible
		// signal) but must never call notify again or create a second consumer of the handoff.
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("worker-long-foreground"));
		expect(notify).toHaveBeenCalledOnce();

		resolveNotify();
		await vi.runAllTimersAsync();
		expect(markDurableDelivered).toHaveBeenCalledOnce();
		expect(markDurableDelivered).toHaveBeenCalledWith(["notification-long-foreground"]);
		coordinator.dispose();
	});

	it("keeps a batch stuck behind a never-settling notify() durably visible instead of losing it inside the closure", async () => {
		// Root-cause regression: flush() used to pending.clear() before notify() settled, so a
		// never-settling notify stranded that batch inside the closure with no trace anywhere —
		// every worker terminal queued behind it (workers 2..N) was silently lost from view, not
		// merely delayed. getOutstandingRecords() must always report pending ∪ in-flight.
		vi.useFakeTimers();
		const first: LaneRecord = {
			laneId: "worker-1",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-12T00:00:00.000Z",
		};
		const second: LaneRecord = {
			laneId: "worker-2",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-12T00:01:00.000Z",
		};
		let resolveNotify!: () => void;
		const notifyPending = new Promise<void>((resolve) => {
			resolveNotify = resolve;
		});
		const notify = vi.fn(() => notifyPending);
		const markDurableDelivered = vi.fn();
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [first, second],
			emitStatus: vi.fn(),
			notify,
			warn: vi.fn(),
			markDurableDelivered,
		});

		coordinator.recordTerminal(first, "notification-1");
		await vi.advanceTimersByTimeAsync(0);
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith([expect.objectContaining({ laneId: "worker-1" })]);

		// A second worker terminates while the first notify() is still stuck. It must queue behind
		// the frozen deliveryTail (never a second concurrent notify() consumer)...
		coordinator.recordTerminal(second, "notification-2");
		await vi.advanceTimersByTimeAsync(0);
		expect(notify).toHaveBeenCalledOnce();

		// ...but it must NOT vanish: both records remain durably discoverable while stuck.
		expect(coordinator.getOutstandingRecords()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ laneId: "worker-1" }),
				expect.objectContaining({ laneId: "worker-2" }),
			]),
		);
		expect(coordinator.getOutstandingRecords()).toHaveLength(2);

		resolveNotify();
		await vi.runAllTimersAsync();
		expect(markDurableDelivered).toHaveBeenCalledWith(["notification-1"]);
		expect(coordinator.getOutstandingRecords()).toEqual([]);
		coordinator.dispose();
	});

	it("clears the handoff watchdog once notify settles, emitting no warning for a normal delivery", async () => {
		vi.useFakeTimers();
		const record: LaneRecord = {
			laneId: "worker-fast-handoff",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-12T00:00:00.000Z",
		};
		const notify = vi.fn(async () => undefined);
		const warn = vi.fn();
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: vi.fn(),
			notify,
			warn,
			markDurableDelivered: vi.fn(),
		});

		coordinator.recordTerminal(record, "notification-fast-handoff");
		await vi.runAllTimersAsync();
		expect(notify).toHaveBeenCalledOnce();

		// Advancing well past the observation threshold after settlement must not warn: the watchdog
		// was cleared when notify() resolved.
		await vi.advanceTimersByTimeAsync(1_800_001);
		expect(warn).not.toHaveBeenCalled();
		coordinator.dispose();
	});

	it("cancels an unsettled handoff watchdog when the owning session is disposed", async () => {
		vi.useFakeTimers();
		const record: LaneRecord = {
			laneId: "worker-disposed-handoff",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-12T00:00:00.000Z",
		};
		const warn = vi.fn();
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: vi.fn(),
			notify: () => new Promise<void>(() => {}),
			warn,
			markDurableDelivered: vi.fn(),
		});

		coordinator.recordTerminal(record, "notification-disposed-handoff");
		await vi.advanceTimersByTimeAsync(0);
		coordinator.dispose();
		await vi.advanceTimersByTimeAsync(1_800_001);

		expect(warn).not.toHaveBeenCalled();
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
				completedAt: "2026-08-12T00:00:00.000Z",
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

	it("does not wake twice when the same terminal is recorded while its notification is in flight", async () => {
		vi.useFakeTimers();
		const record: LaneRecord = {
			laneId: "worker-duplicate-in-flight",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-21T20:00:00.000Z",
		};
		let release!: () => void;
		const notifyPending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const notify = vi.fn(() => notifyPending);
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: vi.fn(),
			notify,
			warn: vi.fn(),
			markDurableDelivered: vi.fn(),
		});

		coordinator.recordTerminal(record, "notification-duplicate-in-flight");
		await vi.advanceTimersByTimeAsync(0);
		expect(notify).toHaveBeenCalledOnce();

		coordinator.recordTerminal(record, "notification-duplicate-in-flight");
		await vi.advanceTimersByTimeAsync(0);
		expect(notify).toHaveBeenCalledOnce();

		release();
		await vi.runAllTimersAsync();
		expect(notify).toHaveBeenCalledOnce();
		coordinator.dispose();
	});

	it("does not redispatch after delivery when durable acknowledgment fails", async () => {
		vi.useFakeTimers();
		const record: LaneRecord = {
			laneId: "worker-ack-failure",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-21T20:00:00.000Z",
		};
		const notify = vi.fn(async () => undefined);
		const warn = vi.fn();
		const markDurableDelivered = vi.fn(() => {
			throw new Error("ledger unavailable");
		});
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: vi.fn(),
			notify,
			warn,
			markDurableDelivered,
		});

		coordinator.recordTerminal(record, "notification-ack-failure");
		await vi.runAllTimersAsync();

		expect(notify).toHaveBeenCalledOnce();
		expect(markDurableDelivered).toHaveBeenCalledWith(["notification-ack-failure"]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("after delivery"));
		expect(coordinator.getOutstandingRecords()).toEqual([]);
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

	it("keeps partial, blocked, and canceled handoffs out of the actual failure counter, tallied instead as needing attention", async () => {
		// Root-cause regression: partial/blocked/canceled used to be excluded from BOTH
		// completedSinceFlush and failedSinceFlush, landing in neither tally -- counted nowhere, not
		// merely "not counted as failed". Every LaneTerminalStatus must land in exactly one bucket.
		vi.useFakeTimers();
		const records: LaneRecord[] = [
			{ laneId: "worker-partial", type: "worker", status: "partial" },
			{ laneId: "worker-blocked", type: "worker", status: "blocked" },
			{ laneId: "worker-canceled", type: "worker", status: "canceled" },
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
				attentionSinceFlush: 3,
				terminalSinceFlush: [
					expect.objectContaining({ status: "partial" }),
					expect.objectContaining({ status: "blocked" }),
					expect.objectContaining({ status: "canceled" }),
				],
			}),
		);
		coordinator.dispose();
	});

	it("partitions every terminal status into exactly one of completed, failed, or attention", async () => {
		vi.useFakeTimers();
		const statuses: LaneRecord["status"][] = [
			"succeeded",
			"partial",
			"blocked",
			"failed",
			"canceled",
			"timeout",
			"budget_exhausted",
		];
		const records: LaneRecord[] = statuses.map((status, index) => ({
			laneId: `worker-${index}-${status}`,
			type: "worker",
			status,
		}));
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

		const call = emitStatus.mock.calls.at(-1)?.[0] as {
			completedSinceFlush: number;
			failedSinceFlush: number;
			attentionSinceFlush: number;
		};
		expect(call.completedSinceFlush + call.failedSinceFlush + call.attentionSinceFlush).toBe(records.length);
		expect(call).toMatchObject({ completedSinceFlush: 1, failedSinceFlush: 3, attentionSinceFlush: 3 });
		coordinator.dispose();
	});

	it("marks only the exact observed completion so a reused worker can notify again", async () => {
		vi.useFakeTimers();
		const first: LaneRecord = {
			laneId: "worker-reused",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-21T20:00:00.000Z",
		};
		const second: LaneRecord = {
			...first,
			completedAt: "2026-08-21T20:10:00.000Z",
		};
		const delivered: Array<{ completedAt?: string; observedAt?: string }> = [];
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [second],
			emitStatus: vi.fn(),
			notify: async (records) => {
				delivered.push(...records);
			},
			warn: vi.fn(),
			markDurableDelivered: vi.fn(),
		});

		coordinator.observeTerminals([first], "2026-08-21T20:00:01.000Z");
		coordinator.recordTerminal(first, "notification-first");
		coordinator.recordTerminal(second, "notification-second");
		await vi.runAllTimersAsync();

		expect(delivered[0]).toMatchObject({
			completedAt: first.completedAt,
			observedAt: "2026-08-21T20:00:01.000Z",
		});
		expect(delivered[1]).toMatchObject({ completedAt: second.completedAt });
		expect(delivered[1]).not.toHaveProperty("observedAt");
		coordinator.dispose();
	});

	it("marks a terminal observed at record time while an event-driven parent wait owns it", async () => {
		vi.useFakeTimers();
		const record: LaneRecord = {
			laneId: "task-waited",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-21T20:00:00.000Z",
		};
		const notify = vi.fn(async () => undefined);
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [record],
			emitStatus: vi.fn(),
			notify,
			warn: vi.fn(),
			markDurableDelivered: vi.fn(),
			isObserved: () => true,
		});

		coordinator.recordTerminal(record, "notification-waited");
		await vi.runAllTimersAsync();

		expect(notify).toHaveBeenCalledWith([
			expect.objectContaining({
				laneId: record.laneId,
				completedAt: record.completedAt,
				observedAt: expect.any(String),
			}),
		]);
		coordinator.dispose();
	});

	it("carries the noted owner epoch onto the terminal handoff record", async () => {
		// Mirrors the real production capture site (WorkerDelegationController.prepareWorkerAttempt's
		// fresh-creation branch): the owning surface calls noteLaneOwnerEpoch exactly once, at genuine
		// lane-creation time, well before this same lane ever reaches recordTerminal. recordTerminal
		// reads and consumes that one entry -- see noteLaneOwnerEpoch's and recordTerminal's own doc
		// comments for why an absent entry must never read as a match downstream.
		const record: LaneRecord = {
			laneId: "worker-owner-epoch",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-12T00:00:00.000Z",
		};
		const notify = vi.fn(async () => undefined);
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [],
			emitStatus: vi.fn(),
			notify,
			warn: vi.fn(),
			markDurableDelivered: vi.fn(),
		});

		coordinator.noteLaneOwnerEpoch("worker-owner-epoch", 4);
		coordinator.recordTerminal(record);
		await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());

		expect(notify).toHaveBeenCalledWith([expect.objectContaining({ laneId: "worker-owner-epoch", ownerEpoch: 4 })]);
		coordinator.dispose();
	});

	it("omits ownerEpoch from a terminal handoff whose lane was never noted", async () => {
		// Absent ownership (no noteLaneOwnerEpoch call for this laneId -- a legacy lane, a resumed
		// session, or a creation surface that hasn't been wired yet) must produce a record with the
		// field genuinely OMITTED, not defaulted to some sentinel that could later compare equal to a
		// real epoch.
		const record: LaneRecord = {
			laneId: "worker-unnoted",
			type: "worker",
			status: "succeeded",
			completedAt: "2026-08-12T00:00:01.000Z",
		};
		const notify = vi.fn(async (_records: readonly WorkerTerminalHandoffRecord[]) => undefined);
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [],
			emitStatus: vi.fn(),
			notify,
			warn: vi.fn(),
			markDurableDelivered: vi.fn(),
		});

		coordinator.recordTerminal(record);
		await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());

		const delivered = notify.mock.calls[0]?.[0]?.[0];
		expect(delivered).toEqual(expect.objectContaining({ laneId: "worker-unnoted" }));
		expect(delivered && "ownerEpoch" in delivered).toBe(false);
		coordinator.dispose();
	});
});
