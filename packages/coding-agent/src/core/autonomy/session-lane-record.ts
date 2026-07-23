import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import { cloneLaneRecordForStorage, isLaneRecord, type LaneRecord } from "./lane-tracker.ts";

export const LANE_RECORD_CUSTOM_TYPE = "lane_record";

export interface LaneRecordSnapshotPayload {
	version: 1;
	record: LaneRecord;
}

export function appendLaneRecordSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	record: LaneRecord,
): string {
	const payload: LaneRecordSnapshotPayload = {
		version: 1,
		record: cloneLaneRecordForStorage(record),
	};
	return sessionManager.appendCustomEntry(LANE_RECORD_CUSTOM_TYPE, payload);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function getLaneRecordSnapshots(entries: readonly SessionEntry[]): LaneRecord[] {
	const records: LaneRecord[] = [];

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== LANE_RECORD_CUSTOM_TYPE) {
			continue;
		}

		const payload = entry.data;
		if (!isPlainRecord(payload)) continue;
		if (payload.version !== 1) continue;
		if (!("record" in payload)) continue;
		const record = payload.record;
		if (isLaneRecord(record)) {
			records.push(cloneLaneRecordForStorage(record));
		}
	}

	return records;
}

/** Latest durable projection per logical lane id, preserving first-seen lane order. */
export function getLatestLaneRecordSnapshots(entries: readonly SessionEntry[]): LaneRecord[] {
	const latest = new Map<string, LaneRecord>();
	for (const record of getLaneRecordSnapshots(entries)) latest.set(record.laneId, record);
	return [...latest.values()].map(cloneLaneRecordForStorage);
}
