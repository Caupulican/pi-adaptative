/** Combines durable team, local lane, and remote presence updates for bot-view subscribers. */
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BotTeamChange } from "./persistent-bot-team-store.ts";

/** One bot view follows durable team changes, relevant lane changes, and live remote presence. */
export function subscribeBotTeamUpdates(
	ports: {
		store(listener: () => void): () => void;
		lanes(listener: (records: readonly LaneRecord[]) => void): () => void;
		remote(listener: (change: BotTeamChange) => void): () => void;
		alias(agentId: string): string | undefined;
	},
	listener: (change: BotTeamChange) => void,
): () => void {
	const offStore = ports.store(() => listener("all"));
	const seen = new Map<string, string>();
	let offLanes: (() => void) | undefined;
	let offRemote: (() => void) | undefined;
	try {
		offLanes = ports.lanes((records) => {
			const changed: string[] = [];
			for (const record of records) {
				const agentId = record.agentId ?? record.laneId;
				const signature = JSON.stringify([
					record.status,
					record.attemptId,
					record.costUsd,
					record.startedAt,
					record.completedAt,
					record.reasonCode,
					record.label,
				]);
				if (seen.get(agentId) === signature) continue;
				seen.set(agentId, signature);
				const alias = ports.alias(agentId);
				if (alias) changed.push(alias);
			}
			if (changed.length > 0) listener(changed);
		});
		offRemote = ports.remote(listener);
	} catch (error) {
		offLanes?.();
		offStore();
		throw error;
	}
	return () => {
		offStore();
		offLanes?.();
		offRemote?.();
	};
}
