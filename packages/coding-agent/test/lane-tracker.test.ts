import { describe, expect, it } from "vitest";
import {
	cloneLaneRecordForStorage,
	isLaneRecord,
	isLaneTerminalStatus,
	type LaneRecord,
	type LaneTerminalStatus,
	LaneTracker,
} from "../src/core/autonomy/lane-tracker.ts";

function createTracker(): { tracker: LaneTracker; ticks: string[] } {
	const ticks: string[] = [];
	let tick = 0;
	const tracker = new LaneTracker({
		now: () => {
			const stamp = `2026-07-01T00:00:0${tick++}.000Z`;
			ticks.push(stamp);
			return stamp;
		},
	});
	return { tracker, ticks };
}

describe("LaneTracker", () => {
	it("starts a lane as running with a start timestamp and counts it active", () => {
		const { tracker } = createTracker();

		const record = tracker.start({ type: "research", goalId: "g1" });

		expect(record.laneId).toBe("research-1");
		expect(record.type).toBe("research");
		expect(record.status).toBe("running");
		expect(record.startedAt).toBe("2026-07-01T00:00:00.000Z");
		expect(record.goalId).toBe("g1");
		expect(record.completedAt).toBeUndefined();
		expect(tracker.getActiveCount()).toBe(1);
		expect(tracker.getActiveCount("research")).toBe(1);
		expect(tracker.getActiveCount("worker")).toBe(0);
	});

	it("completes a lane with terminal details and stops counting it active", () => {
		const { tracker } = createTracker();
		const started = tracker.start({ type: "research" });

		const completed = tracker.complete(started.laneId, {
			status: "succeeded",
			reasonCode: "research_completed",
			costUsd: 0.12,
			evidenceEntryId: "entry-1",
		});

		expect(completed).toBeDefined();
		expect(completed?.status).toBe("succeeded");
		expect(completed?.reasonCode).toBe("research_completed");
		expect(completed?.costUsd).toBe(0.12);
		expect(completed?.evidenceEntryId).toBe("entry-1");
		expect(completed?.completedAt).toBe("2026-07-01T00:00:01.000Z");
		expect(tracker.getActiveCount()).toBe(0);
		expect(tracker.getRecords()).toHaveLength(1);
		expect(tracker.getRecords()[0]?.status).toBe("succeeded");
	});

	it("assigns distinct per-type lane ids and counts types independently", () => {
		const { tracker } = createTracker();

		const first = tracker.start({ type: "research" });
		const second = tracker.start({ type: "research" });
		const worker = tracker.start({ type: "worker" });

		expect(first.laneId).toBe("research-1");
		expect(second.laneId).toBe("research-2");
		expect(worker.laneId).toBe("worker-3");
		expect(tracker.getActiveCount()).toBe(3);
		expect(tracker.getActiveCount("research")).toBe(2);
		expect(tracker.getActiveCount("worker")).toBe(1);
	});

	it("returns undefined and keeps the first terminal state on double completion", () => {
		const { tracker } = createTracker();
		const started = tracker.start({ type: "research" });

		const first = tracker.complete(started.laneId, { status: "failed", reasonCode: "model_error" });
		const second = tracker.complete(started.laneId, { status: "succeeded" });

		expect(first?.status).toBe("failed");
		expect(second).toBeUndefined();
		expect(tracker.getRecords()[0]?.status).toBe("failed");
		expect(tracker.getRecords()[0]?.reasonCode).toBe("model_error");
	});

	it("returns undefined for an unknown lane id", () => {
		const { tracker } = createTracker();

		expect(tracker.complete("research-99", { status: "canceled" })).toBeUndefined();
	});

	it("accepts every terminal status", () => {
		const { tracker } = createTracker();
		const statuses: LaneTerminalStatus[] = ["succeeded", "failed", "canceled", "timeout", "budget_exhausted"];

		for (const status of statuses) {
			const record = tracker.start({ type: "research" });
			const completed = tracker.complete(record.laneId, { status });
			expect(completed?.status).toBe(status);
		}
		expect(tracker.getActiveCount()).toBe(0);
	});

	it("hands out defensive copies so callers cannot mutate tracked state", () => {
		const { tracker } = createTracker();
		const started = tracker.start({ type: "research" });

		started.status = "succeeded";
		const records = tracker.getRecords();
		expect(records[0]?.status).toBe("running");

		records[0]!.status = "failed";
		expect(tracker.getRecords()[0]?.status).toBe("running");
		expect(tracker.getActiveCount()).toBe(1);
	});
});

describe("isLaneTerminalStatus", () => {
	it("accepts terminal statuses and rejects live or unknown ones", () => {
		expect(isLaneTerminalStatus("succeeded")).toBe(true);
		expect(isLaneTerminalStatus("budget_exhausted")).toBe(true);
		expect(isLaneTerminalStatus("running")).toBe(false);
		expect(isLaneTerminalStatus("queued")).toBe(false);
		expect(isLaneTerminalStatus("done")).toBe(false);
		expect(isLaneTerminalStatus(42)).toBe(false);
	});
});

describe("isLaneRecord", () => {
	const valid: LaneRecord = {
		laneId: "research-1",
		type: "research",
		status: "succeeded",
		reasonCode: "research_completed",
		startedAt: "2026-07-01T00:00:00.000Z",
		completedAt: "2026-07-01T00:00:01.000Z",
		costUsd: 0.05,
		goalId: "g1",
		evidenceEntryId: "entry-1",
	};

	it("accepts a fully populated record and a minimal one", () => {
		expect(isLaneRecord(valid)).toBe(true);
		expect(isLaneRecord({ laneId: "worker-1", type: "worker", status: "running" })).toBe(true);
	});

	it("rejects structurally invalid values", () => {
		expect(isLaneRecord(undefined)).toBe(false);
		expect(isLaneRecord("lane")).toBe(false);
		expect(isLaneRecord({ ...valid, laneId: 7 })).toBe(false);
		expect(isLaneRecord({ ...valid, type: "pipeline" })).toBe(false);
		expect(isLaneRecord({ ...valid, status: "done" })).toBe(false);
		expect(isLaneRecord({ ...valid, costUsd: "free" })).toBe(false);
		const { laneId: _laneId, ...missingLaneId } = valid;
		expect(isLaneRecord(missingLaneId)).toBe(false);
	});
});

describe("cloneLaneRecordForStorage", () => {
	it("produces an independent copy", () => {
		const original: LaneRecord = { laneId: "research-1", type: "research", status: "running" };
		const clone = cloneLaneRecordForStorage(original);

		expect(clone).toEqual(original);
		clone.status = "failed";
		expect(original.status).toBe("running");
	});
});
