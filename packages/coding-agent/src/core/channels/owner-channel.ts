/**
 * The authority boundary of the owner channel: whether an inbound event is the owner's own words (`ownerAdmission`),
 * whether a channel can carry owner authority at all (`ownerAuthority`), whether a running owner turn still holds it
 * (`ownerLiveCheck`), and what the owner pool of a channel has spent (`ownerChannelCharges`). Small pure functions over
 * the provider, the event, the policy and the journal; `session-channels.ts` applies them at receive, at offer, at every
 * guarded call of the turn (through the `live` closure) and at every work pass.
 */

import { harnessLog } from "../../kernel/harness-log.ts";
import type { ChannelProvider } from "../gateways/channel-provider.ts";
import { awaySpendMicros, type RoutineAwayCharge } from "../routines/routine-contract.ts";
import { isShippedChannelProvider } from "./built-in-providers.ts";
import {
	type ChannelBatchRecord,
	type ChannelJournalState,
	type ChannelPendingMessage,
	DAY_MS,
	digest,
	pendingOfferTimes,
} from "./channel-journal.ts";
import type { InboundChannelEvent } from "./channel-message.ts";
import { type ChannelPolicyResolution, isOwnerChannelName, type ResolvedChannelPolicy } from "./channel-policy.ts";

/** Whether `senderId` is one of `ids`, both put in the transport's one comparable form. */
export function senderListed(
	ids: readonly string[],
	senderId: string,
	provider: Pick<ChannelProvider, "senderIds"> | undefined,
): boolean {
	const normalize = provider?.senderIds?.normalize ?? ((id: string) => id);
	const sender = normalize(senderId);
	return ids.some((id) => normalize(id) === sender);
}

/**
 * Whether the channel can carry owner authority: the owner listed senders, and the transport is the shipped one of a
 * channel whose platform assigns sender ids and reports private chats (Telegram, Slack). A wrapper's provider never
 * qualifies, whatever facts it sets.
 */
export function ownerAuthority(provider: ChannelProvider | undefined, policy: ResolvedChannelPolicy): boolean {
	return (
		policy.ownerSenders.length > 0 &&
		provider !== undefined &&
		isShippedChannelProvider(provider) &&
		isOwnerChannelName(provider.name) &&
		provider.senderIds?.assignedBy === "platform"
	);
}

/**
 * Whether the event is the owner's own words: the channel carries owner authority, the platform verified the sender, the
 * sender is listed in `ownerSenders`, it is a message (not a reaction) written in the sender's private chat with the bot,
 * and it relays nobody else's words. Any other event, a listed owner's forward included, is a third party's.
 */
export function ownerAdmission(
	provider: ChannelProvider | undefined,
	event: InboundChannelEvent,
	policy: ResolvedChannelPolicy,
): boolean {
	return (
		ownerAuthority(provider, policy) &&
		event.verified &&
		event.kind === "message" &&
		senderListed(policy.ownerSenders, event.senderId, provider) &&
		event.privateChat === true &&
		event.forwarded === false
	);
}

/** The digest an owner turn names its sender by (`OwnerChannelOrigin.senderDigest`); never the raw id. */
export function ownerSenderDigest(
	channel: string,
	senderId: string,
	provider: Pick<ChannelProvider, "senderIds"> | undefined,
): string {
	const normalize = provider?.senderIds?.normalize ?? ((id: string) => id);
	return digest(`${channel}:${normalize(senderId)}`).slice(0, 16);
}

/** The digests of the senders the policy lists now: a conversation is pushed to only while its sender is one. */
export function listedOwnerDigests(
	channel: string,
	policy: ResolvedChannelPolicy,
	provider: Pick<ChannelProvider, "senderIds"> | undefined,
): Set<string> {
	return new Set(policy.ownerSenders.map((id) => ownerSenderDigest(channel, id, provider)));
}

/** The policy as one comparable text: an owner turn holds authority only under the policy it was offered under. */
export function policyFingerprint(policy: ResolvedChannelPolicy): string {
	return JSON.stringify(policy);
}

/** What the `live` closure re-reads at every call. */
export interface OwnerLiveSources {
	readonly channel: string;
	readonly senderDigest: string;
	/** The policy fingerprint when the turn was offered. */
	readonly fingerprint: string;
	getPolicy(): ChannelPolicyResolution | undefined;
	getProvider(): ChannelProvider | undefined;
	/** The emergency stop probe; absent means no owner authority. */
	readonly isEmergencyStopEngaged?: () => boolean;
	/** The channels core still serves (not stopped, not disposed). */
	isServing(): boolean;
}

/**
 * The closure the owner delivery asks at every guarded call of the run a message opens: true only while the channels core
 * serves, the policy is still explicit and unchanged, the provider still carries owner authority, the sender is still
 * listed and the emergency stop probe exists and is not engaged. It reads everything at each call, so a settings reload
 * (the daemon's tick included) or an engaged stop takes effect at the next call. A throw anywhere answers false.
 */
export function ownerLiveCheck(sources: OwnerLiveSources): () => boolean {
	return () => {
		try {
			if (!sources.isServing()) return false;
			const resolution = sources.getPolicy();
			if (resolution?.kind !== "policy" || resolution.policy.mode !== "explicit") return false;
			const policy = resolution.policy;
			if (policyFingerprint(policy) !== sources.fingerprint) return false;
			const provider = sources.getProvider();
			if (!ownerAuthority(provider, policy)) return false;
			if (!listedOwnerDigests(sources.channel, policy, provider).has(sources.senderDigest)) return false;
			const engaged = sources.isEmergencyStopEngaged;
			return engaged !== undefined && engaged() === false;
		} catch (error) {
			harnessLog.warn("channels", "an owner authority check threw; the owner turn is not authorized", {
				channel: sources.channel,
				error: error instanceof Error ? error.name : typeof error,
			});
			return false;
		}
	};
}

/** One charge of a channel's owner pool, tagged with the pool it belongs to. */
export interface OwnerChannelCharge extends RoutineAwayCharge {
	readonly pool: `owner:${string}`;
	readonly until: number;
}

/**
 * What one owner turn charges its channel's owner pool for 24 hours after it was accepted: the larger of the per-turn
 * bound and its recorded spend while it runs, and its recorded spend once settled, answered or not (a turn the owner
 * stopped costs what it spent, not a whole per-turn bound).
 */
function ownerBatchCharge(
	channel: string,
	batch: ChannelBatchRecord,
	maxUsdPerTurn: number,
	now: number,
): OwnerChannelCharge | undefined {
	if (batch.owner !== true || batch.quota === true) return undefined;
	const until = batch.acceptedAt + DAY_MS;
	if (until <= now) return undefined;
	const usd = batch.usd ?? 0;
	const charged = batch.state === "accepted" ? Math.max(maxUsdPerTurn, usd) : usd;
	return { pool: `owner:${channel}`, micros: awaySpendMicros(charged), until };
}

/** Each owner offer not yet accepted reserves the per-turn bound from the offer on. */
function ownerOfferCharges(
	channel: string,
	pending: readonly ChannelPendingMessage[],
	maxUsdPerTurn: number,
	now: number,
): OwnerChannelCharge[] {
	const charges: OwnerChannelCharge[] = [];
	for (const offeredAt of pendingOfferTimes(pending, (entry) => entry.owner === true)) {
		const until = offeredAt + DAY_MS;
		if (until > now) charges.push({ pool: `owner:${channel}`, micros: awaySpendMicros(maxUsdPerTurn), until });
	}
	return charges;
}

/**
 * The owner pool's charges of one channel: its owner turns and owner offers of the last 24 hours. A turn accepted while
 * the subscription had room (`quota`) charges nothing; while it has room now (`quotaRoom`) an offer reserves nothing.
 */
export function ownerChannelCharges(
	channel: string,
	state: Pick<ChannelJournalState, "batches" | "pending">,
	policy: Pick<ResolvedChannelPolicy, "ownerMaxUsdPerTurn">,
	now: number,
	quotaRoom = false,
): OwnerChannelCharge[] {
	const charges: OwnerChannelCharge[] = [];
	for (const batch of state.batches) {
		const charge = ownerBatchCharge(channel, batch, policy.ownerMaxUsdPerTurn, now);
		if (charge) charges.push(charge);
	}
	if (!quotaRoom) charges.push(...ownerOfferCharges(channel, state.pending, policy.ownerMaxUsdPerTurn, now));
	return charges;
}

/** The owner pool of a channel now: what it holds, and whether another turn fits (`quotaRoom`: the subscription has allowance); when not, when room returns. */
export interface OwnerRoom {
	readonly usedUsd: number;
	readonly fits: boolean;
	/** When the oldest charge leaves the window; undefined when nothing is charged. */
	readonly oldestUntil?: number;
}

export function ownerRoom(
	channel: string,
	state: Pick<ChannelJournalState, "batches" | "pending">,
	policy: ResolvedChannelPolicy,
	now: number,
	quotaRoom = false,
): OwnerRoom {
	const charges = ownerChannelCharges(channel, state, policy, now, quotaRoom);
	const usedMicros = charges.reduce((sum, charge) => sum + charge.micros, 0);
	// The subscription's room lifts the daily dollar bound, never the off switch (`ownerMaxUsdPerDay: 0` starts none).
	const fits =
		policy.ownerMaxUsdPerDay > 0 &&
		(quotaRoom ||
			usedMicros + awaySpendMicros(policy.ownerMaxUsdPerTurn) <= awaySpendMicros(policy.ownerMaxUsdPerDay));
	const oldestUntil = charges.length > 0 ? Math.min(...charges.map((charge) => charge.until)) : undefined;
	return { usedUsd: usedMicros / 1_000_000, fits, ...(oldestUntil !== undefined ? { oldestUntil } : {}) };
}
