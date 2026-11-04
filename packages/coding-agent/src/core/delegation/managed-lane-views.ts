import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { isBotId } from "./bot-runtime-bindings.ts";
import type { PersistentBotLiveState } from "./persistent-bot-team-store.ts";

/**
 * A live managed lane (an externally hosted worker such as a collaboration agent) as the chat roster shows it.
 * It is not a bot: its id is an opaque lane id, it has no chat, memory or routines, so it is listed read-only
 * and is never a chat target.
 */
export interface ManagedLaneView {
	readonly laneId: string;
	readonly label: string;
	readonly state: Extract<PersistentBotLiveState, "running" | "queued">;
	readonly modelRef?: string;
	readonly updatedAt: string;
}

function laneTimestamp(record: LaneRecord): string {
	return record.completedAt ?? record.startedAt ?? record.queuedAt ?? "";
}

/**
 * The queued and running managed lanes whose id is outside the bot id domain (the complement of what
 * `projectBotViews` projects), one per lane, running before queued. Finished lanes are history, kept by the graph.
 */
export function projectManagedLaneViews(records: readonly LaneRecord[]): ManagedLaneView[] {
	const byLane = new Map<string, LaneRecord>();
	for (const record of records) {
		if (record.type !== "managed-worker") continue;
		if (record.status !== "queued" && record.status !== "running") continue;
		if (isBotId(record.agentId ?? record.laneId)) continue;
		const existing = byLane.get(record.laneId);
		if (
			!existing ||
			(record.status === "running" && existing.status !== "running") ||
			(record.status === existing.status && laneTimestamp(record) >= laneTimestamp(existing))
		)
			byLane.set(record.laneId, record);
	}
	return [...byLane.values()]
		.map(
			(record): ManagedLaneView => ({
				laneId: record.laneId,
				label: record.label ?? record.laneId,
				state: record.status === "running" ? "running" : "queued",
				...(record.modelRef ? { modelRef: record.modelRef } : {}),
				updatedAt: laneTimestamp(record),
			}),
		)
		.sort((a, b) => (a.state === b.state ? b.updatedAt.localeCompare(a.updatedAt) : a.state === "running" ? -1 : 1));
}
