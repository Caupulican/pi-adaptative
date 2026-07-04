import { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import {
	appendLaneRecordSnapshot,
	getLaneRecordSnapshots,
	LANE_RECORD_CUSTOM_TYPE,
} from "../src/core/autonomy/session-lane-record.ts";

function laneRecord(overrides: Partial<LaneRecord> = {}): LaneRecord {
	return {
		laneId: "research-1",
		type: "research",
		status: "succeeded",
		reasonCode: "research_completed",
		startedAt: "2026-07-01T00:00:00.000Z",
		completedAt: "2026-07-01T00:00:01.000Z",
		costUsd: 0.1,
		...overrides,
	};
}

describe("session lane record snapshots", () => {
	it("round-trips appended records in order", () => {
		const sessionManager = SessionManager.inMemory();

		const firstId = appendLaneRecordSnapshot(sessionManager, laneRecord());
		const secondId = appendLaneRecordSnapshot(
			sessionManager,
			laneRecord({ laneId: "research-2", status: "failed", reasonCode: "model_error" }),
		);

		expect(firstId).toBeTruthy();
		expect(secondId).toBeTruthy();

		const records = getLaneRecordSnapshots(sessionManager.getEntries());
		expect(records).toHaveLength(2);
		expect(records[0]?.laneId).toBe("research-1");
		expect(records[0]?.status).toBe("succeeded");
		expect(records[1]?.laneId).toBe("research-2");
		expect(records[1]?.reasonCode).toBe("model_error");
	});

	it("stores a defensive copy and returns clones", () => {
		const sessionManager = SessionManager.inMemory();
		const original = laneRecord();

		appendLaneRecordSnapshot(sessionManager, original);
		original.status = "failed";

		const records = getLaneRecordSnapshots(sessionManager.getEntries());
		expect(records[0]?.status).toBe("succeeded");

		records[0]!.status = "canceled";
		expect(getLaneRecordSnapshots(sessionManager.getEntries())[0]?.status).toBe("succeeded");
	});

	it("skips malformed payloads, wrong versions, and unrelated custom entries", () => {
		const sessionManager = SessionManager.inMemory();

		sessionManager.appendCustomEntry(LANE_RECORD_CUSTOM_TYPE, { version: 1, record: { laneId: 42 } });
		sessionManager.appendCustomEntry(LANE_RECORD_CUSTOM_TYPE, { version: 2, record: laneRecord() });
		sessionManager.appendCustomEntry(LANE_RECORD_CUSTOM_TYPE, "not-a-payload");
		sessionManager.appendCustomEntry("worker_result", { version: 1, result: {} });
		appendLaneRecordSnapshot(sessionManager, laneRecord({ laneId: "research-9" }));

		const records = getLaneRecordSnapshots(sessionManager.getEntries());
		expect(records).toHaveLength(1);
		expect(records[0]?.laneId).toBe("research-9");
	});

	it("returns an empty array when no entries exist", () => {
		expect(getLaneRecordSnapshots([])).toEqual([]);
	});
});
