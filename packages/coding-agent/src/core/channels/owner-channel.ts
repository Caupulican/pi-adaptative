/**
 * The authority boundary of the owner channel: whether an inbound event is the owner's own words (`ownerAdmission`),
 * whether a channel can carry owner authority at all (`ownerAuthority`), whether a running owner turn still holds it
 * (`ownerLiveCheck`), and what the owner pool of a channel has spent (`ownerChannelCharges`). Small pure functions over
 * the provider, the event, the policy and the journal; `session-channels.ts` applies them at receive, at offer, at every
 * guarded call of the turn (through the `live` closure) and at every work pass.
 */

import { harnessLog } from "../../kernel/harness-log.ts";
import type { ChannelProvider } from "../gateways/channel-provider.ts";
import type { InterfaceText } from "../language/interface-text.ts";
import { type AllowanceExhaustedCause, allowanceCauseText } from "../provider-admission/subscription-allowance.ts";
import { awaySpendMicros, type RoutineAwayCharge } from "../routines/routine-away-spend.ts";
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
import {
	type ChannelPolicyResolution,
	DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT,
	isOwnerChannelName,
	type ResolvedChannelPolicy,
} from "./channel-policy.ts";
import type { OwnerChannelDelivery, OwnerQuotaAllowance, SessionChannelsOwnerDeps } from "./owner-channel-types.ts";

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
 * stopped costs what it spent, not a whole per-turn bound). A request that still owes the chat a later answer adds its
 * later turns' spend when that answer is settled (`owner-late-answers.ts`).
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
 * its spend was not metered (`quota`) charges nothing; while it is not metered now (`unmetered`) an offer reserves nothing.
 */
export function ownerChannelCharges(
	channel: string,
	state: Pick<ChannelJournalState, "batches" | "pending" | "ownerTaskCommands">,
	policy: Pick<ResolvedChannelPolicy, "ownerMaxUsdPerTurn">,
	now: number,
	unmetered = false,
): OwnerChannelCharge[] {
	const charges: OwnerChannelCharge[] = [];
	for (const batch of state.batches) {
		const charge = ownerBatchCharge(channel, batch, policy.ownerMaxUsdPerTurn, now);
		if (charge) charges.push(charge);
	}
	for (const command of state.ownerTaskCommands ?? []) {
		if (!command.spend || command.admittedAt + DAY_MS <= now) continue;
		const usd =
			command.state === "finished" ? command.spend.usd : Math.max(command.spend.usd, command.spend.reserved);
		charges.push({ pool: `owner:${channel}`, micros: awaySpendMicros(usd), until: command.admittedAt + DAY_MS });
	}
	if (!unmetered) charges.push(...ownerOfferCharges(channel, state.pending, policy.ownerMaxUsdPerTurn, now));
	return charges;
}

/** The owner pool of a channel now: what it holds, and whether another turn fits (`unmetered`: `ownerDollarsApply` is false); when not, when room returns. */
export interface OwnerRoom {
	readonly usedUsd: number;
	readonly fits: boolean;
	/** When the oldest charge leaves the window; undefined when nothing is charged. */
	readonly oldestUntil?: number;
}

/** Whether `turns` more per-turn charges fit the owner pool's day bound beside `usedMicros`; none fit while the pool is off. */
function turnsFit(usedMicros: number, turns: number, policy: ResolvedChannelPolicy): boolean {
	return (
		policy.ownerMaxUsdPerDay > 0 &&
		usedMicros + turns * awaySpendMicros(policy.ownerMaxUsdPerTurn) <= awaySpendMicros(policy.ownerMaxUsdPerDay)
	);
}

function heldMicros(charges: readonly OwnerChannelCharge[]): number {
	return charges.reduce((sum, charge) => sum + charge.micros, 0);
}

export function ownerRoom(
	channel: string,
	state: Pick<ChannelJournalState, "batches" | "pending" | "ownerTaskCommands">,
	policy: ResolvedChannelPolicy,
	now: number,
	unmetered = false,
): OwnerRoom {
	const charges = ownerChannelCharges(channel, state, policy, now, unmetered);
	const usedMicros = heldMicros(charges);
	// Spend that is not metered lifts the daily dollar bound, never the off switch (`ownerMaxUsdPerDay: 0` starts none).
	const fits = unmetered ? policy.ownerMaxUsdPerDay > 0 : turnsFit(usedMicros, 1, policy);
	const oldestUntil = charges.length > 0 ? Math.min(...charges.map((charge) => charge.until)) : undefined;
	return { usedUsd: usedMicros / 1_000_000, fits, ...(oldestUntil !== undefined ? { oldestUntil } : {}) };
}

/**
 * Whether the owner pool has room to reserve `turns` owner turns accepted on a subscription (`quota`) that move to a
 * metered model: each is then charged its per-turn bound (`ownerBatchCharge`) beside what the pool holds.
 */
export function ownerMoveFits(
	channel: string,
	state: Pick<ChannelJournalState, "batches" | "pending" | "ownerTaskCommands">,
	policy: ResolvedChannelPolicy,
	now: number,
	turns: number,
): boolean {
	return turnsFit(heldMicros(ownerChannelCharges(channel, state, policy, now)), turns, policy);
}

/**
 * What the owner pool's bounds read of the session's model now: its subscription's allowance at the line
 * `ownerQuotaMaxUsedPercent` draws (100% when it is 0), or `unknown` with `subscription: false` for a model that is no
 * subscription login (`SubscriptionAllowanceReader` decides that by `isMeteredSpend`). A delivery that reads no usage
 * reports a metered model, so the dollar bounds keep holding it; a reading that fails keeps that stricter reading too
 * (the model's billing is then unknown). `unread` hears each read's failure cause, undefined when it did not fail.
 */
export function readOwnerQuota(
	delivery: Pick<OwnerChannelDelivery, "quotaAllowance"> | undefined,
	policy: Pick<ResolvedChannelPolicy, "ownerQuotaMaxUsedPercent">,
	unread: (cause: string | undefined) => void,
): OwnerQuotaAllowance {
	let quota: OwnerQuotaAllowance | undefined;
	try {
		quota = delivery?.quotaAllowance?.(ownerQuotaLine(policy));
	} catch (error) {
		unread(error instanceof Error ? error.message : String(error));
		return { kind: "unknown", cause: "readFailed", subscription: false };
	}
	unread(undefined);
	return quota ?? { kind: "unknown", cause: "noReader", subscription: false };
}

/**
 * Whether the owner pool's dollar bounds hold the spend of the reading's model: metered (API) spend alone, by the owner's
 * cost rule, and a model whose billing could not be read. A subscription login is held by its usage windows instead:
 * its turns run while they have room or its account reports no reading, and a turn stops once they are exhausted.
 */
export function ownerDollarsApply(quota: OwnerQuotaAllowance): boolean {
	return quota.kind === "unknown" && !quota.subscription;
}

/** The usage line of a subscription login's owner turns, in percent: `ownerQuotaMaxUsedPercent`, or the provider's own limit (100) when it is 0. */
export function ownerQuotaLine(policy: Pick<ResolvedChannelPolicy, "ownerQuotaMaxUsedPercent">): number {
	return policy.ownerQuotaMaxUsedPercent > 0 ? policy.ownerQuotaMaxUsedPercent : 100;
}

/** An instant the owner is told, as ISO text; undefined stays unknown. */
export function toldInstant(ms: number | undefined): string | undefined {
	return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** The owner's usage line of a channel's subscription turns, as the words name it: its setting key and percent. */
export function ownerUsageLine(name: string, policy: Pick<ResolvedChannelPolicy, "ownerQuotaMaxUsedPercent">) {
	return { key: `channels.${name}.ownerQuotaMaxUsedPercent`, percent: ownerQuotaLine(policy) };
}

/**
 * That a subscription login's usage reached the owner's line, in `text`'s words: with what the reading reports
 * (`allowanceCauseText`) and its reset while it is exhausted, the line alone otherwise (a turn stopped at it whose next
 * reading has room again).
 */
export function ownerUsageReached(
	text: InterfaceText,
	name: string,
	policy: Pick<ResolvedChannelPolicy, "ownerQuotaMaxUsedPercent">,
	quota: OwnerQuotaAllowance,
): string {
	const exhausted = quota.kind === "exhausted" ? quota : undefined;
	const { key, percent } = ownerUsageLine(name, policy);
	const cause = exhausted ? [allowanceCauseText(text.notices.subscriptionUsage, exhausted.cause)] : [];
	const detail = [...cause, `${key} ${percent}%`].join("; ");
	return text.notices.channels.owner.usageReached("bound", detail, toldInstant(exhausted?.retryAt));
}

/**
 * Why a subscription login's owner turns are held now, in `text`'s words, or undefined: its usage windows are exhausted
 * at the owner's line. No new turn starts and a running one stops; the owner's messages wait, and the pass at the reset
 * the account reports (`retryAt`) or the next event delivers them.
 */
export function ownerQuotaWait(
	text: InterfaceText,
	name: string,
	policy: Pick<ResolvedChannelPolicy, "ownerQuotaMaxUsedPercent">,
	quota: OwnerQuotaAllowance,
): string | undefined {
	return quota.kind === "exhausted" ? ownerUsageReached(text, name, policy, quota) : undefined;
}

/** Why a third party's turn waits on its session's subscription usage: what the reading reports, and its reset. */
export interface TurnUsageHold {
	readonly cause: AllowanceExhaustedCause;
	readonly retryAt?: number;
}

/**
 * Why a third party's turn waits: the serving session's own subscription (the model the turn runs on) reports its usage
 * at the line workers wait at (`DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT`) or at the provider's limit, past which a turn is
 * refused or billed as extra usage; it waits for the reset the account reports, or the next
 * channel pass with room. None for a metered model (the channel's dollar bounds hold it) or a reading that fails (the
 * provider's refusal then holds it). Told in each catalogue's words by `channelCapWords`.
 */
export function turnUsageHold(source: Pick<SessionChannelsOwnerDeps, "turnAllowance">): TurnUsageHold | undefined {
	let quota: OwnerQuotaAllowance | undefined;
	try {
		quota = source.turnAllowance?.(DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT);
	} catch {
		return undefined;
	}
	if (quota?.kind !== "exhausted") return undefined;
	return { cause: quota.cause, ...(quota.retryAt !== undefined ? { retryAt: quota.retryAt } : {}) };
}

/** The session wiring handed in all three owner dependencies; an absent one fails closed (third-party path). */
export function ownerChannelWired(deps: SessionChannelsOwnerDeps): boolean {
	return (
		deps.ownerDelivery !== undefined && deps.ownerControl !== undefined && deps.isEmergencyStopEngaged !== undefined
	);
}
