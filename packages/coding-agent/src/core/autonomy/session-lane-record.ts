import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import {
	appendSessionSnapshot,
	getSessionSnapshots,
	type SessionSnapshotCodec,
	type SessionSnapshotPayload,
} from "../session-snapshot.ts";
import { cloneLaneRecordForStorage, isLaneRecord, type LaneRecord } from "./lane-tracker.ts";

export const LANE_RECORD_CUSTOM_TYPE = "lane_record";

export type LaneRecordSnapshotPayload = SessionSnapshotPayload<"record", LaneRecord>;

const LANE_RECORD_SNAPSHOT_CODEC: SessionSnapshotCodec<LaneRecord, "record"> = {
	customType: LANE_RECORD_CUSTOM_TYPE,
	valueKey: "record",
	isValue: isLaneRecord,
	clone: cloneLaneRecordForStorage,
};

export function appendLaneRecordSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	record: LaneRecord,
): string {
	return appendSessionSnapshot(sessionManager, LANE_RECORD_SNAPSHOT_CODEC, record);
}

export function getLaneRecordSnapshots(entries: readonly SessionEntry[]): LaneRecord[] {
	return getSessionSnapshots(entries, LANE_RECORD_SNAPSHOT_CODEC);
}

/** Latest durable projection per logical lane id, preserving first-seen lane order. */
export function getLatestLaneRecordSnapshots(entries: readonly SessionEntry[]): LaneRecord[] {
	const latest = new Map<string, LaneRecord>();
	for (const record of getLaneRecordSnapshots(entries)) latest.set(record.laneId, record);
	return [...latest.values()].map(cloneLaneRecordForStorage);
}
