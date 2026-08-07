import { describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import {
	MAX_WORKER_TERMINAL_HANDOFF_BYTES,
	type WorkerTerminalHandoff,
	WorkerTerminalHandoffCoordinator,
	type WorkerTerminalHandoffDelivery,
} from "../src/core/delegation/worker-terminal-handoff-coordinator.ts";
import { MAX_ORCHESTRATION_ATTEMPTS } from "../src/core/orchestration/contracts.ts";

function terminalRecord(laneId: string, status: LaneRecord["status"] = "succeeded"): LaneRecord {
	return {
		laneId,
		type: "worker",
		status,
		completedAt: "2026-08-07T00:00:00.000Z",
	};
}

function handoff(index: number): WorkerTerminalHandoff {
	return {
		terminalAttemptId: `attempt-${index}`,
		parentAgentId: "parent",
		childAgentId: `child-${index}`,
		record: terminalRecord(`task-${index}`),
	};
}

describe("WorkerTerminalHandoffCoordinator", () => {
	it("retains a full parent-mailbox handoff without timers or polling", () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		try {
			const deliver = vi.fn(() => "retained" as const);
			const coordinator = new WorkerTerminalHandoffCoordinator({ deliver });

			expect(coordinator.retain(handoff(1))).toBe("retained");
			expect(coordinator.signal()).toEqual({ attempted: 1, delivered: 0, errors: 0, retained: 1 });
			expect(deliver).toHaveBeenCalledOnce();
			expect(setTimeoutSpy).not.toHaveBeenCalled();
			expect(setIntervalSpy).not.toHaveBeenCalled();
		} finally {
			setTimeoutSpy.mockRestore();
			setIntervalSpy.mockRestore();
		}
	});

	it("delivers retained work when an explicit capacity event signals it", () => {
		let hasCapacity = false;
		const deliver = vi.fn(() => (hasCapacity ? ("delivered" as const) : ("retained" as const)));
		const coordinator = new WorkerTerminalHandoffCoordinator({ deliver });
		coordinator.retain(handoff(1));

		expect(coordinator.signal().retained).toBe(1);
		hasCapacity = true;
		expect(coordinator.signal()).toEqual({ attempted: 1, delivered: 1, errors: 0, retained: 0 });
		expect(deliver).toHaveBeenCalledTimes(2);
	});

	it("coalesces reentrant state signals into a bounded redrain", () => {
		let coordinator: WorkerTerminalHandoffCoordinator;
		let attempts = 0;
		coordinator = new WorkerTerminalHandoffCoordinator({
			deliver: () => {
				attempts += 1;
				coordinator.signal();
				return attempts === 1 ? "retained" : "delivered";
			},
		});
		coordinator.retain(handoff(1));

		expect(coordinator.signal()).toEqual({ attempted: 2, delivered: 1, errors: 0, retained: 0 });
		expect(attempts).toBe(2);

		let repeatedSignals = 0;
		const alwaysRetained = new WorkerTerminalHandoffCoordinator({
			deliver: () => {
				repeatedSignals += 1;
				alwaysRetained.signal();
				return "retained";
			},
		});
		alwaysRetained.retain(handoff(2));
		expect(alwaysRetained.signal()).toEqual({ attempted: 2, delivered: 0, errors: 0, retained: 1 });
		expect(repeatedSignals).toBe(2);
	});

	it("bounds retained attempt identities to the durable attempt ceiling", () => {
		const coordinator = new WorkerTerminalHandoffCoordinator({ deliver: () => "retained" });
		for (let index = 0; index < MAX_ORCHESTRATION_ATTEMPTS; index += 1) {
			expect(coordinator.retain(handoff(index))).toBe("retained");
		}

		expect(coordinator.retainedCount).toBe(MAX_ORCHESTRATION_ATTEMPTS);
		expect(() => coordinator.retain(handoff(MAX_ORCHESTRATION_ATTEMPTS))).toThrow(
			`Worker terminal handoff retention reached its ${MAX_ORCHESTRATION_ATTEMPTS} attempt limit.`,
		);
	});

	it("rejects an over-capacity recovery batch without partial adoption or delivery", () => {
		const deliver = vi.fn(() => "retained" as const);
		const coordinator = new WorkerTerminalHandoffCoordinator({ deliver });
		for (let index = 0; index < MAX_ORCHESTRATION_ATTEMPTS - 1; index += 1) {
			coordinator.retain(handoff(index));
		}
		const before = coordinator.retained();

		expect(() =>
			coordinator.rehydrate([handoff(MAX_ORCHESTRATION_ATTEMPTS - 1), handoff(MAX_ORCHESTRATION_ATTEMPTS)]),
		).toThrow(`Worker terminal handoff retention reached its ${MAX_ORCHESTRATION_ATTEMPTS} attempt limit.`);
		expect(coordinator.retained()).toEqual(before);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("accepts exact retained replays and rejects conflicting attempt reuse", () => {
		const coordinator = new WorkerTerminalHandoffCoordinator({ deliver: () => "retained" });
		const original = handoff(1);
		expect(coordinator.retain(original)).toBe("retained");
		expect(coordinator.retain({ ...original, record: { ...original.record } })).toBe("replay");

		expect(() =>
			coordinator.retain({
				...original,
				record: { ...original.record, reasonCode: "different-terminal-result" },
			}),
		).toThrow("Worker terminal handoff attempt attempt-1 conflicts with its retained payload.");
		expect(coordinator.retained()).toEqual([original]);
	});

	it("rehydrates recovery-shaped handoffs atomically, deduplicates them, and drains in order", () => {
		let capacity = 1;
		const delivered: string[] = [];
		const coordinator = new WorkerTerminalHandoffCoordinator({
			deliver: (value) => {
				if (capacity === 0) return "retained";
				capacity -= 1;
				delivered.push(value.terminalAttemptId);
				return "delivered";
			},
		});
		const first = handoff(1);
		const second = handoff(2);
		expect(() =>
			coordinator.rehydrate([
				first,
				{ ...first, record: { ...first.record, reasonCode: "conflicting-recovery-payload" } },
			]),
		).toThrow("Worker terminal handoff attempt attempt-1 conflicts with its retained payload.");
		expect(coordinator.retainedCount).toBe(0);
		expect(delivered).toEqual([]);

		expect(coordinator.rehydrate([first, { ...first, record: { ...first.record } }, second])).toEqual({
			added: 2,
			replayed: 1,
			drain: { attempted: 2, delivered: 1, errors: 0, retained: 1 },
		});
		expect(delivered).toEqual(["attempt-1"]);
		expect(coordinator.retained()).toEqual([second]);

		capacity = 1;
		coordinator.signal();
		expect(delivered).toEqual(["attempt-1", "attempt-2"]);
	});

	it("detaches retained state from input, inspection, and delivery callback mutations", () => {
		const original = handoff(1);
		const coordinator = new WorkerTerminalHandoffCoordinator({
			deliver: (value) => {
				value.record.reasonCode = "callback-mutation";
				return "retained";
			},
		});
		coordinator.retain(original);
		original.parentAgentId = "mutated-parent";
		original.record.reasonCode = "input-mutation";
		const inspection = coordinator.retained();
		inspection[0]!.childAgentId = "mutated-child";
		inspection[0]!.record.reasonCode = "inspection-mutation";

		coordinator.signal();
		expect(coordinator.retained()).toEqual([handoff(1)]);
	});

	it("redrains a new handoff retained reentrantly during delivery", () => {
		const delivered: string[] = [];
		let coordinator: WorkerTerminalHandoffCoordinator;
		coordinator = new WorkerTerminalHandoffCoordinator({
			deliver: (value) => {
				delivered.push(value.terminalAttemptId);
				if (value.terminalAttemptId === "attempt-1") coordinator.retain(handoff(2));
				return "delivered";
			},
		});
		coordinator.retain(handoff(1));

		expect(coordinator.signal()).toEqual({ attempted: 2, delivered: 2, errors: 0, retained: 0 });
		expect(delivered).toEqual(["attempt-1", "attempt-2"]);
	});

	it("retains invalid delivery results when the error observer also fails", () => {
		const onDeliveryError = vi.fn(() => {
			throw new Error("diagnostic observer failed");
		});
		const coordinator = new WorkerTerminalHandoffCoordinator({
			deliver: () => "invalid" as unknown as WorkerTerminalHandoffDelivery,
			onDeliveryError,
		});
		coordinator.retain(handoff(1));

		expect(coordinator.signal()).toEqual({ attempted: 1, delivered: 0, errors: 1, retained: 1 });
		expect(coordinator.retained()).toEqual([handoff(1)]);
		expect(onDeliveryError).toHaveBeenCalledWith(
			expect.objectContaining({ terminalAttemptId: "attempt-1" }),
			expect.objectContaining({ message: "Worker terminal handoff delivery returned an invalid result." }),
		);
	});

	it("rejects malformed identifiers and lane records before retaining state", () => {
		const coordinator = new WorkerTerminalHandoffCoordinator({ deliver: () => "retained" });
		for (const malformed of [
			{ ...handoff(1), terminalAttemptId: " attempt-1 " },
			{ ...handoff(1), parentAgentId: " " },
			{ ...handoff(1), childAgentId: 42 as unknown as string },
		]) {
			expect(() => coordinator.retain(malformed)).toThrow("must be a bounded non-empty canonical string");
		}
		expect(() =>
			coordinator.retain({
				...handoff(1),
				record: { ...terminalRecord("task-1"), laneId: "" },
			}),
		).toThrow("Worker terminal handoff requires a valid lane record.");
		expect(() => coordinator.retain({ ...handoff(1), record: terminalRecord("task-1", "running") })).toThrow(
			"Worker terminal handoff requires a terminal lane record.",
		);
		expect(coordinator.retainedCount).toBe(0);
	});

	it("rejects an oversized lane record before retaining or delivering it", () => {
		const deliver = vi.fn(() => "retained" as const);
		const coordinator = new WorkerTerminalHandoffCoordinator({ deliver });
		const oversized = {
			...handoff(1),
			record: {
				...terminalRecord("task-1"),
				reasonCode: "x".repeat(MAX_WORKER_TERMINAL_HANDOFF_BYTES),
			},
		};

		expect(() => coordinator.retain(oversized)).toThrow(
			`Worker terminal handoff exceeds its ${MAX_WORKER_TERMINAL_HANDOFF_BYTES} byte limit.`,
		);
		expect(coordinator.retainedCount).toBe(0);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("retains callback errors and supports explicit clear and dispose", () => {
		const onDeliveryError = vi.fn();
		const coordinator = new WorkerTerminalHandoffCoordinator({
			deliver: () => {
				throw new Error("mailbox write failed");
			},
			onDeliveryError,
		});
		coordinator.retain(handoff(1));

		expect(coordinator.signal()).toEqual({ attempted: 1, delivered: 0, errors: 1, retained: 1 });
		expect(onDeliveryError).toHaveBeenCalledWith(
			expect.objectContaining({ terminalAttemptId: "attempt-1" }),
			expect.objectContaining({ message: "mailbox write failed" }),
		);
		coordinator.clear();
		expect(coordinator.retainedCount).toBe(0);
		coordinator.retain(handoff(2));
		coordinator.dispose();
		expect(coordinator.retainedCount).toBe(0);
		expect(coordinator.signal()).toEqual({ attempted: 0, delivered: 0, errors: 0, retained: 0 });
		expect(() => coordinator.retain(handoff(3))).toThrow("Worker terminal handoff coordinator is disposed.");
	});
});
