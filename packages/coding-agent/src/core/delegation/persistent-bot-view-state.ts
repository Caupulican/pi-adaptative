/**
 * What the roster shows of a bot's run, derived from the worker lanes and the live worker agents a session holds: the lane
 * that speaks for each bot (a running one, else a queued one, else the latest finished) and the live state its view
 * carries. Pure: the bot store's view projection (`projectBotViews`) reads both.
 */
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { PersistentBotLiveState, PersistentBotRecord } from "./persistent-bot-team-store.ts";
import type { WorkerAgentView } from "./worker-agent-control.ts";

/** The worker lane that speaks for each bot (keyed by its agent id, else its lane id). */
export function workerLaneByAgentId(laneRecords: readonly LaneRecord[]): Map<string, LaneRecord> {
	const laneByAgentId = new Map<string, LaneRecord>();
	for (const lane of laneRecords) {
		if (lane.type !== "worker" && lane.type !== "managed-worker") continue;
		const id = lane.agentId ?? lane.laneId;
		const existing = laneByAgentId.get(id);
		if (!existing) {
			laneByAgentId.set(id, lane);
		} else if (lane.status === "running") {
			laneByAgentId.set(id, lane);
		} else if (lane.status === "queued" && existing.status !== "running") {
			laneByAgentId.set(id, lane);
		} else if (existing.status !== "running" && existing.status !== "queued") {
			const existingTs = existing.completedAt ?? existing.startedAt ?? existing.queuedAt ?? "";
			const laneTs = lane.completedAt ?? lane.startedAt ?? lane.queuedAt ?? "";
			if (laneTs >= existingTs) {
				laneByAgentId.set(id, lane);
			}
		}
	}
	return laneByAgentId;
}

/** The live state of a bot's view: its live worker agent first, then its lane, then its record. */
export function botLiveState(
	liveAgent: WorkerAgentView | undefined,
	lane: LaneRecord | undefined,
	botRecord: PersistentBotRecord | undefined,
): PersistentBotLiveState {
	if (
		liveAgent?.dispatch === "running" ||
		lane?.status === "running" ||
		(liveAgent?.activity === "active" && liveAgent.dispatch !== "queued")
	)
		return "running";
	if (liveAgent?.dispatch === "queued" || lane?.status === "queued") return "queued";
	if (botRecord?.retired || liveAgent?.status === "retired") return "retired";
	if (liveAgent?.awaitingParent) return "awaiting_parent";
	if (liveAgent?.lastResult?.status === "failed" || lane?.status === "failed") return "failed";
	return "idle";
}
