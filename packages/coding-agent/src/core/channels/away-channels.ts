/**
 * Channels the daemon serves while no session is open: which ones (`channels.<name>.awayCwd` in the global settings
 * layer, under `routines.away.enabled`), what their turns charge the away spend bound, and who serves each now. Reads
 * only: the journals and the settings. The daemon's host is `away-channel-host.ts`.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "../process-liveness.ts";
import { awaySpendMicros, type RoutineAwayCharge } from "../routines/routine-contract.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { type ChannelBatchRecord, ChannelJournal, type ChannelJournalState, DAY_MS } from "./channel-journal.ts";
import { isValidChannelName, type ResolvedChannelPolicy } from "./channel-policy.ts";

/** Why the daemon delivers no channel turn now for lack of room under the away spend bound. */
export const AWAY_CHANNEL_SPEND_REFUSAL =
	"the away spend bound (routines.away.maxUsdPerDay) has no room for another turn in the last 24 hours; messages wait for an open session";

/** A channel the daemon serves while no session is open, and where. */
export interface AwayChannel {
	readonly name: string;
	readonly policy: ResolvedChannelPolicy;
	readonly cwd: string;
}

/** The channels to serve away: an explicit global policy that names `awayCwd`, while routines run away at all. */
export function awayChannels(
	settings: Pick<SettingsManager, "getAwayChannelPolicies" | "getRoutineAwaySettings">,
): AwayChannel[] {
	if (!settings.getRoutineAwaySettings().enabled) return [];
	const channels: AwayChannel[] = [];
	for (const [name, resolution] of settings.getAwayChannelPolicies()) {
		if (resolution.kind !== "policy" || resolution.policy.mode !== "explicit" || !isValidChannelName(name)) continue;
		const cwd = resolution.policy.awayCwd;
		if (cwd !== undefined) channels.push({ name, policy: resolution.policy, cwd });
	}
	return channels;
}

/**
 * What one channel turn the daemon delivered charges the away spend bound: its full per-run bound while it runs, its
 * recorded spend once answered, and the full bound when it ended without an answer (its spend is not read); each for
 * 24 hours after it was accepted.
 */
function channelAwayCharge(
	batch: ChannelBatchRecord,
	maxUsdPerRun: number,
	nowMs: number,
): RoutineAwayCharge | undefined {
	if (batch.away !== true) return undefined;
	if (batch.state === "accepted") return { micros: awaySpendMicros(maxUsdPerRun) };
	const until = batch.acceptedAt + DAY_MS;
	if (until <= nowMs) return undefined;
	const usd = batch.state === "unanswered" ? maxUsdPerRun : (batch.usd ?? 0);
	return { micros: awaySpendMicros(usd), until };
}

/** The charges of every channel journal of the agent directory (a channel no longer configured included). */
export function readAwayChannelCharges(agentDir: string, maxUsdPerRun: number, nowMs: number): RoutineAwayCharge[] {
	let files: string[];
	try {
		files = readdirSync(join(agentDir, "channels"));
	} catch {
		return [];
	}
	const charges: RoutineAwayCharge[] = [];
	for (const file of files) {
		const name = file.endsWith(".json") ? file.slice(0, -".json".length) : "";
		if (!isValidChannelName(name)) continue;
		for (const batch of new ChannelJournal(agentDir, name).read().result.batches) {
			const charge = channelAwayCharge(batch, maxUsdPerRun, nowMs);
			if (charge) charges.push(charge);
		}
	}
	return charges;
}

export type ChannelServedBy = "this session" | "the daemon" | "another session" | "nobody";

/** Who serves the channel by its journal's holder, as seen from `sessionId` (undefined: from no session). */
export function channelServedBy(holder: ChannelJournalState["holder"], sessionId?: string): ChannelServedBy {
	if (!holder) return "nobody";
	if (holder.sessionId === sessionId) return "this session";
	if (!isProcessAlive(holder.pid)) return "nobody";
	return holder.away ? "the daemon" : "another session";
}

/** One channel served away as `/bot daemon status` lists it. */
export interface AwayChannelStatus {
	readonly name: string;
	readonly cwd: string;
	readonly servedBy: ChannelServedBy;
	/** Reply drafts the daemon wrote that wait for the owner's next session. */
	readonly awayDrafts: number;
}

/** As seen from `sessionId`, the session that reads it (undefined: from no session). */
export function readAwayChannelStatus(
	agentDir: string,
	settings: Pick<SettingsManager, "getAwayChannelPolicies" | "getRoutineAwaySettings">,
	sessionId?: string,
): AwayChannelStatus[] {
	return awayChannels(settings).map(({ name, cwd }) => {
		const state = new ChannelJournal(agentDir, name).read().result;
		return {
			name,
			cwd,
			servedBy: channelServedBy(state.holder, sessionId),
			awayDrafts: state.drafts.filter((draft) => draft.away === true && draft.state === "pending").length,
		};
	});
}
