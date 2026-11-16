/**
 * Channels the daemon serves while no session is open: which ones (`channels.<name>.awayCwd` in the global settings
 * layer, under `routines.away.enabled`), what their turns charge the away spend bound, and who serves each now. Reads
 * the journals and the settings, and writes only the offers a move of their session to a metered model reserves
 * (`reserveAwayChannelOffers`). The daemon's host is `away-channel-host.ts`.
 */

import { readdirSync } from "node:fs";
import { channelsDir } from "../agent-paths.ts";
import { interfaceText } from "../language/interface-text.ts";
import { isProcessAlive } from "../process-liveness.ts";
import { awayChannelTurnKey, awayMeteredReservations } from "../routines/away-metered-runs.ts";
import {
	awaySpendMicros,
	type RoutineAwayCharge,
	type RoutineAwayChargesRead,
	type RoutineAwayChargesUnread,
} from "../routines/routine-away-spend.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { isMissingFileError } from "../util/atomic-file.ts";
import {
	type ChannelBatchRecord,
	ChannelJournal,
	type ChannelJournalState,
	type ChannelPendingMessage,
	DAY_MS,
	isDraftOpen,
	pendingOfferTimes,
} from "./channel-journal.ts";
import { isValidChannelName, type ResolvedChannelPolicy } from "./channel-policy.ts";
import type { Worded } from "./owner-notice-text.ts";

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

/** The channels served away, by name and directory: what the daemon's start depends on besides the routines. */
export function awayChannelsKey(settings: Parameters<typeof awayChannels>[0]): string {
	return awayChannels(settings)
		.map((channel) => `${channel.name}:${channel.cwd}`)
		.join(",");
}

/**
 * What one channel turn the daemon delivered charges the away spend bound, for 24 hours after it was accepted: its
 * recorded metered (API) spend once answered, and the larger of its full per-run bound and its recorded spend while it
 * runs or when it ended without an answer (a turn is stopped only after a message took it past the bound, and a turn
 * settled by another session has no recorded spend). A turn served on a subscription (`quota`) reserves no per-run
 * bound while it stays there, its usage windows holding it; once its session failed over to a metered model it was
 * reserved (`reservedMetered`, `reserveAwayChannelTurns`) and is charged as a metered turn.
 */
function channelAwayCharge(
	name: string,
	batch: ChannelBatchRecord,
	maxUsdPerRun: number,
	reservedMetered: (key: string) => boolean,
	nowMs: number,
): RoutineAwayCharge | undefined {
	// An owner turn charges its channel's owner pool alone (`owner-channel.ts`), wherever it ran.
	if (batch.away !== true || batch.owner === true) return undefined;
	const until = batch.acceptedAt + DAY_MS;
	if (until <= nowMs) return undefined;
	const usd = batch.usd ?? 0;
	const metered = batch.quota !== true || reservedMetered(awayChannelTurnKey(name, batch.id, until));
	const reserved = metered ? maxUsdPerRun : 0;
	const charged = batch.state === "accepted" || batch.state === "unanswered" ? Math.max(reserved, usd) : usd;
	return { micros: awaySpendMicros(charged), until };
}

/**
 * What the daemon's offers not yet accepted charge: each offered batch its full per-run bound, from the offer on, so
 * no other claim takes the room the turn is about to use; an offer by a host whose model is not metered reserves
 * nothing (`offeredUnmetered`). An offer that is accepted becomes its batch's charge.
 */
function offerAwayCharges(pending: readonly ChannelPendingMessage[], maxUsdPerRun: number, nowMs: number) {
	const charges: RoutineAwayCharge[] = [];
	const reserves = (entry: ChannelPendingMessage) =>
		entry.offeredAway === true && entry.offeredUnmetered !== true && entry.owner !== true;
	for (const offeredAt of pendingOfferTimes(pending, reserves)) {
		const until = offeredAt + DAY_MS;
		if (until > nowMs) charges.push({ micros: awaySpendMicros(maxUsdPerRun), until });
	}
	return charges;
}

/** A failure's kind, told once each: a system error by its code (its message names the file it met), else its name. */
export function failureCause(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" ? code : error instanceof Error ? error.name : "thrown";
}

/**
 * The charges of every channel journal of the agent directory, a channel no longer configured included: what a turn
 * spent in the last 24 hours counts against the day's bound whether or not its channel is still served away. None
 * when the channels directory does not exist; a directory that does not list, or a journal that does not read or parse
 * (`invalid`: which turns it held is unknown; its next update sets it aside), is `unread` with its path and cause.
 */
export function readAwayChannelCharges(agentDir: string, maxUsdPerRun: number, nowMs: number): RoutineAwayChargesRead {
	const dir = channelsDir(agentDir);
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch (error) {
		if (isMissingFileError(error)) return { charges: [] };
		return { unread: { path: dir, cause: failureCause(error) } };
	}
	const charges: RoutineAwayCharge[] = [];
	const reservedMetered = awayMeteredReservations(agentDir);
	for (const file of files) {
		const name = file.endsWith(".json") ? file.slice(0, -".json".length) : "";
		if (!isValidChannelName(name)) continue;
		const journal = new ChannelJournal(agentDir, name);
		let read: ReturnType<ChannelJournal["read"]>;
		try {
			read = journal.read();
		} catch (error) {
			return { unread: { path: journal.path, cause: failureCause(error) } };
		}
		if (read.reset) return { unread: { path: journal.path, cause: "invalid" } };
		const state = read.result;
		for (const batch of state.batches) {
			const charge = channelAwayCharge(name, batch, maxUsdPerRun, reservedMetered, nowMs);
			if (charge) charges.push(charge);
		}
		charges.push(...offerAwayCharges(state.pending, maxUsdPerRun, nowMs));
	}
	return { charges };
}

/**
 * The daemon's one reader of its channel turns' charges, for every gate that decides on the away bound with them (the
 * routine supervisor's claims, the channel hosts' turns and moves): a read that fails is told once per cause, until one
 * reads again.
 */
export function awayChannelChargesReader(
	agentDir: string,
	tell: (message: string) => void,
): (maxUsdPerRun: number, nowMs: number) => RoutineAwayChargesRead {
	let told: RoutineAwayChargesUnread | undefined;
	return (maxUsdPerRun, nowMs) => {
		const read = readAwayChannelCharges(agentDir, maxUsdPerRun, nowMs);
		if (!("unread" in read)) told = undefined;
		else if (told?.cause !== read.unread.cause) {
			told = read.unread;
			tell(interfaceText().sessions.awayMeteredRuns.chargesUnread(read.unread.path, read.unread.cause));
		}
		return read;
	};
}

/** What a move of a session away to a metered model reserves first on the away bound, for one channel. */
export interface AwaySubscriptionTurns {
	/** The reservation keys (`awayChannelTurnKey`) of its turns accepted on a subscription (`quota`), none reserved yet. */
	readonly keys: readonly string[];
	/** The batch ids of the turns offered to it while it spent unmetered (`offeredUnmetered`), not accepted yet. */
	readonly offers: readonly string[];
}

/**
 * The turns away of `sessionId` on a subscription that its move to a metered model reserves first: those it accepted
 * and has not ended, and those offered to it and not accepted yet (the turn being prepared runs on the model it moves
 * to). A reservations file that does not read counts the accepted ones reserved already (`awayMeteredReservations`).
 * Undefined when the journal does not parse (it was set aside: which turns it held is unknown); throws when it does not
 * read.
 */
export function unreservedSubscriptionTurns(
	agentDir: string,
	name: string,
	sessionId: string,
): AwaySubscriptionTurns | undefined {
	const read = new ChannelJournal(agentDir, name).read();
	if (read.reset) return undefined;
	const reservedMetered = awayMeteredReservations(agentDir);
	const keys = read.result.batches.flatMap((batch) => {
		if (batch.state !== "accepted" || batch.sessionId !== sessionId) return [];
		if (batch.away !== true || batch.owner === true || batch.quota !== true) return [];
		const key = awayChannelTurnKey(name, batch.id, batch.acceptedAt + DAY_MS);
		return reservedMetered(key) ? [] : [key];
	});
	return { keys, offers: [...unmeteredOffers(read.result.pending, sessionId)] };
}

/** The batch ids of the third parties' offers to `sessionId` away that reserve nothing on the bound (`offeredUnmetered`). */
function unmeteredOffers(pending: readonly ChannelPendingMessage[], sessionId: string): Set<string> {
	const offers = new Set<string>();
	for (const entry of pending)
		if (
			entry.offeredTo === sessionId &&
			entry.offeredAway === true &&
			entry.offeredUnmetered === true &&
			entry.owner !== true &&
			entry.offeredBatch !== undefined
		)
			offers.add(entry.offeredBatch);
	return offers;
}

/**
 * Reserves the offers `batches` to `sessionId` on the away bound as its session moves to a metered model: their entries
 * lose `offeredUnmetered`, so each charges its full per-run bound from its offer on (`offerAwayCharges`) until it is
 * accepted as a metered turn. The caller decided they fit. False when the journal could not be written or no longer
 * parses (it was set aside: `invalid`), `notWritten` telling why.
 */
export function reserveAwayChannelOffers(input: {
	readonly agentDir: string;
	readonly name: string;
	readonly sessionId: string;
	readonly batches: readonly string[];
	readonly nowMs: number;
	notWritten(path: string, cause: string): void;
}): boolean {
	const offers = new Set(input.batches);
	const journal = new ChannelJournal(input.agentDir, input.name);
	let reset: boolean;
	try {
		reset = journal.update(input.nowMs, (state) => {
			for (const entry of state.pending)
				if (
					entry.offeredTo === input.sessionId &&
					entry.offeredBatch !== undefined &&
					offers.has(entry.offeredBatch)
				)
					entry.offeredUnmetered = undefined;
		}).reset;
	} catch (error) {
		input.notWritten(journal.path, error instanceof Error ? error.message : String(error));
		return false;
	}
	if (reset) input.notWritten(journal.path, "invalid");
	return !reset;
}

/** What the channels core asks of the daemon's host while it serves a channel away (`SessionChannelsDeps.away`). */
export interface AwayChannelServing {
	/**
	 * The away spend bound's reason to deliver no turn now, in each catalogue's words (`notices.channels.cap.awaySpend`, or
	 * `awaySpendUnread` while the bound's charges do not read); none while the host spends unmetered (it holds metered
	 * turns alone).
	 */
	capReason(now: number): Worded | undefined;
	/** Whether the host's turns spend metered (API) dollars (`isMeteredSpend`); absent: they do. */
	spendsMetered?(): boolean;
}

/** The daemon's host runs on a model whose spend is not metered: its turns away reserve none of the away bound. */
export function awayHostUnmetered(away: AwayChannelServing | undefined): boolean {
	try {
		return away?.spendsMetered?.() === false;
	} catch {
		return false;
	}
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
			awayDrafts: state.drafts.filter((draft) => draft.away === true && isDraftOpen(draft)).length,
		};
	});
}
