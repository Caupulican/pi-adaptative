/**
 * What the roster shows of a bot's run, derived from the worker lanes and the live worker agents a session holds: the lane
 * that speaks for each bot (a running one, else a queued one, else the latest finished), the live state its view carries,
 * the groups it is in and the roster's order. Pure: the bot store's view projection (`projectBotViews`) reads them.
 */
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type {
	PersistentBotLiveState,
	PersistentBotRecord,
	PersistentBotView,
	PersistentTeamRecord,
} from "./persistent-bot-team-store.ts";
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

/** The groups the bot is a member of. */
export function teamIdsOf(teams: Iterable<PersistentTeamRecord>, agentId: string): string[] {
	const teamIds: string[] = [];
	for (const team of teams) if (team.memberAgentIds.includes(agentId)) teamIds.push(team.teamId);
	return teamIds;
}

/** The roster's order: running or queued bots first, then the persistent ones, then the most recently updated. */
export function compareBotViews(a: PersistentBotView, b: PersistentBotView): number {
	const aActive = a.state === "running" || a.state === "queued";
	const bActive = b.state === "running" || b.state === "queued";
	if (aActive !== bActive) return aActive ? -1 : 1;
	if (a.persistent !== b.persistent) return a.persistent ? -1 : 1;
	return b.updatedAt.localeCompare(a.updatedAt);
}
