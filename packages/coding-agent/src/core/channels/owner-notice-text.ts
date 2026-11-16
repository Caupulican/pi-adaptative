/**
 * The owner-facing words a channel session writes about a channel's state, a held sender, what the daemon's host left
 * and the subscription allowance: pure builders with no session state, so the notice rules (one bounded line, an id
 * named only when the platform assigned it) live in one place next to their bounds. A notice's sentences are the notices
 * catalogue's (`notices.channels`): the model reads them in English, the owner in the interface language.
 */

import type { ChannelSenderIds } from "../gateways/channel-provider.ts";
import { type HarnessNotice, type WordedNotice, wordedNotice } from "../harness-notice.ts";
import { type InterfaceText, interfaceText } from "../language/interface-text.ts";
import { allowanceCauseText } from "../provider-admission/subscription-allowance.ts";
import { MAX_RETAINED_DIAGNOSTIC_CHARS } from "../security/secret-text.ts";
import { type ChannelAwayUntold, heldCount } from "./channel-journal.ts";
import type { ResolvedChannelPolicy } from "./channel-policy.ts";
import {
	type OwnerRoom,
	ownerQuotaWait,
	ownerUsageLine,
	ownerUsageReached,
	type TurnUsageHold,
	toldInstant,
} from "./owner-channel.ts";
import type { OwnerDraftView, OwnerQuotaAllowance, OwnerWaitingView } from "./owner-channel-types.ts";
import { classLabels } from "./owner-control.ts";
import { waitingStatusLine } from "./owner-waiting-notices.ts";

/** The daemon's drafts one summary of what it left names by id and reason; the rest are counted. */
const MAX_NAMED_AWAY_DRAFTS = 3;

/** What the daemon's host left, counted: messages it dropped, conversations it left unanswered, messages it held. */
interface AwayCounts {
	readonly expired: number;
	readonly unanswered: number;
	readonly held: number;
}

/**
 * A sender id the owner is told verbatim: one the platform assigned (`ChannelSenderIds`), plain and short, never prose
 * (a notice enters the owner's turn unfenced). It is named only when the whole notice fits its one bounded line.
 */
const PLAIN_SENDER_ID = /^[A-Za-z0-9._@+-]{1,64}$/;

/**
 * What the owner's chat is told while owner messages wait, in the interface language: at the subscription's exhausted
 * usage (once per reset), at the owner pool's off switch or at its day bound (once per oldest charge); none while a turn
 * may start.
 */
export function ownerHeldPush(
	name: string,
	policy: ResolvedChannelPolicy,
	room: OwnerRoom,
	quota: OwnerQuotaAllowance,
): { readonly key: string; readonly text: string } | undefined {
	const text = interfaceText();
	const words = text.notices.channels.owner;
	const wait = policy.ownerMaxUsdPerDay > 0 ? ownerQuotaWait(text, name, policy, quota) : undefined;
	if (wait && quota.kind === "exhausted")
		return { key: `quota:${quota.retryAt ?? "open"}`, text: words.heldPush(words.turnsPaused(wait), false) };
	if (room.fits) return undefined;
	const off = policy.ownerMaxUsdPerDay === 0;
	const lead = off
		? words.turnsOff(name)
		: words.turnsPaused(
				words.oldestCharge(
					words.daySpend(name, room.usedUsd, policy.ownerMaxUsdPerDay),
					toldInstant(room.oldestUntil),
				),
			);
	return { key: `bound:${room.oldestUntil ?? "off"}`, text: words.heldPush(lead, off) };
}

/**
 * Why an owner turn was stopped, as the owner's chat is told in the interface language: at its dollar bound, at its
 * subscription's usage line (the reading asked only then; with no policy left, the line unnamed) or at the emergency
 * stop (`emergencyStopEngaged`, read by the caller); none for a stop it is not told of.
 */
export function ownerStopPush(
	why: "bound" | "quota" | "authority" | "owner" | undefined,
	name: string,
	policy: ResolvedChannelPolicy | undefined,
	quota: (policy: ResolvedChannelPolicy) => OwnerQuotaAllowance,
	emergencyStopEngaged: boolean,
): string | undefined {
	const text = interfaceText();
	const words = text.notices.channels.owner;
	const cause =
		why === "bound"
			? policy && words.turnBound(name, policy.ownerMaxUsdPerTurn)
			: why === "quota"
				? policy
					? ownerUsageReached(text, name, policy, quota(policy))
					: words.usageReached("bound", undefined, undefined)
				: why === "authority" && emergencyStopEngaged
					? words.emergencyStop
					: undefined;
	return cause === undefined ? undefined : words.stopped(cause);
}

/**
 * The status line for the subscription allowance, in the interface language (none when the model is no subscription
 * login, whose metered spend the dollar bounds hold): what holds its turns now, and why.
 */
function quotaStatusLine(
	text: InterfaceText,
	name: string,
	policy: ResolvedChannelPolicy,
	quota: OwnerQuotaAllowance,
): string | undefined {
	const words = text.notices.channels.owner;
	const line = ownerUsageLine(name, policy);
	if (quota.kind === "room")
		return words.usageStatus({ kind: "room", usedPercent: Math.round(quota.usedPercent), ...line });
	const reason = allowanceCauseText(text.notices.subscriptionUsage, quota.cause);
	if (quota.kind === "exhausted") return words.usageStatus({ kind: "exhausted", reason, ...line });
	return quota.subscription ? words.usageStatus({ kind: "unread", reason }) : undefined;
}

/** A sentence told in each catalogue's words: English for the model and the journal, the interface language for the owner. */
export type Worded = (text: InterfaceText) => string;

/** What decides whether an owner turn of a channel may start, each read only once the checks before it pass. */
export interface OwnerTurnFacts {
	/** The channel carries owner authority in this session. */
	readonly authority: boolean;
	emergencyStop(): boolean;
	quota(): OwnerQuotaAllowance;
	room(quota: OwnerQuotaAllowance): OwnerRoom;
}

/**
 * Why no owner turn of a channel may start now (`Worded`), or undefined when one may, by the first that holds: owner
 * authority is off in this session, the emergency stop, the owner pool switched off, the subscription's usage at the
 * owner's line, the pool's day bound.
 */
export function ownerRefusalWords(
	name: string,
	policy: ResolvedChannelPolicy,
	facts: OwnerTurnFacts,
): Worded | undefined {
	if (!facts.authority) return (text) => text.notices.channels.owner.authorityOff;
	if (facts.emergencyStop()) return (text) => text.notices.channels.owner.emergencyStop;
	if (policy.ownerMaxUsdPerDay === 0) return (text) => text.notices.channels.owner.turnsOffCause(name);
	const quota = facts.quota();
	if (quota.kind === "exhausted")
		return (text) => text.notices.channels.owner.usageWait(ownerUsageReached(text, name, policy, quota));
	const room = facts.room(quota);
	return room.fits
		? undefined
		: (text) => text.notices.channels.owner.daySpend(name, room.usedUsd, policy.ownerMaxUsdPerDay);
}

/** What a channel's third-party bounds read: its turns and metered spend in the last 24 hours, its open reply drafts. */
export interface ChannelCapFacts {
	readonly wakes: number;
	readonly usd: number;
	readonly openDrafts: number;
	readonly maxDrafts: number;
	/** The serving session's subscription usage at its limit (`turnUsageHold`), read only once the bounds before it pass. */
	usage(): TurnUsageHold | undefined;
}

/**
 * Why a channel delivers no third party's turn now (`Worded`), or undefined, by the first that holds: its turns' day
 * bound, its metered spend's day bound, the reply drafts waiting for the owner, the serving session's subscription usage.
 */
export function channelCapWords(
	name: string,
	policy: Pick<ResolvedChannelPolicy, "maxWakesPerDay" | "maxUsdPerDay">,
	facts: ChannelCapFacts,
): Worded | undefined {
	if (facts.wakes >= policy.maxWakesPerDay)
		return (text) => text.notices.channels.cap.wakes(policy.maxWakesPerDay, `channels.${name}.maxWakesPerDay`);
	if (facts.usd >= policy.maxUsdPerDay)
		return (text) => text.notices.channels.cap.spend(facts.usd, `channels.${name}.maxUsdPerDay`);
	if (facts.openDrafts >= facts.maxDrafts) return (text) => text.notices.channels.cap.drafts(facts.maxDrafts);
	const hold = facts.usage();
	if (hold === undefined) return undefined;
	return (text) =>
		text.notices.channels.owner.usageReached(
			"limit",
			allowanceCauseText(text.notices.subscriptionUsage, hold.cause),
			toldInstant(hold.retryAt),
		);
}

/** What the `status` reply reads of a channel's owner pool, its turns, its held drafts and the calls waiting on the owner. */
export interface OwnerStatusFacts {
	readonly room: OwnerRoom;
	readonly refusal: Worded | undefined;
	readonly quota: OwnerQuotaAllowance;
	readonly running: boolean;
	readonly waiting: number;
	/** The held drafts in scope: id, classes, and whether this chat was shown it. */
	readonly drafts: readonly (Pick<OwnerDraftView, "id" | "classes"> & { readonly shown: boolean })[];
	/** The calls waiting on the owner in the hosting session; undefined when none could be read. */
	readonly calls: OwnerWaitingView | undefined;
	/** Pushes held back under `ownerPushPerHour` since the last status. */
	readonly suppressed: number;
}

/** The `status` reply in the interface language, one line each; the drafts past `maxDrafts` are counted. */
export function ownerStatusReply(
	name: string,
	policy: ResolvedChannelPolicy,
	facts: OwnerStatusFacts,
	maxDrafts: number,
): string {
	const text = interfaceText();
	const words = text.notices.channels.owner;
	const listed = facts.drafts
		.slice(0, maxDrafts)
		.map((draft) => words.heldDraft(draft.id, classLabels(draft, text), draft.shown));
	const quotaLine = quotaStatusLine(text, name, policy, facts.quota);
	const waitingLine = waitingStatusLine(words, facts.calls);
	return [
		words.statusSpend(facts.room.usedUsd, policy.ownerMaxUsdPerDay, policy.ownerMaxUsdPerTurn, facts.refusal?.(text)),
		...(quotaLine === undefined ? [] : [quotaLine]),
		words.statusTurns(facts.running, facts.waiting),
		words.statusHeld(listed, facts.drafts.length - listed.length),
		...(waitingLine === undefined ? [] : [waitingLine]),
		...(facts.suppressed > 0 ? [words.statusSuppressed(facts.suppressed, name)] : []),
	].join("\n");
}

/**
 * The notice a channel's state shows the owner, or none for a state that needs no telling. `connectionLost`: the detail
 * is what the started transport reported; `builtIn`: the transport is a shipped one, which a session start tries again.
 */
export function channelStateNotice(
	name: string,
	state: string,
	detail: string | undefined,
	facts: { readonly connectionLost: boolean; readonly builtIn: boolean; readonly worded?: Worded },
): HarnessNotice | undefined {
	const reason = `${name}:${state}:${detail ?? ""}`;
	switch (state) {
		case "not_configured":
			return wordedNotice(reason, (words) => words.notices.channels.notConfigured(name));
		case "invalid":
			return wordedNotice(reason, (words) => words.notices.channels.invalid(name, detail));
		case "served_elsewhere":
			return wordedNotice(reason, (words) => words.notices.channels.servedElsewhere(name));
		case "suspended":
			return wordedNotice(reason, (words) =>
				facts.connectionLost && detail !== undefined
					? words.notices.channels.connectionLost(name, detail)
					: words.notices.channels.startFailed(name, detail, facts.builtIn),
			);
		case "capped":
			// A detail worded in the catalogues (the owner pool's) is told in each reader's language; another is the record's.
			return wordedNotice(reason, (words) => words.notices.channels.capped(name, facts.worded?.(words) ?? detail));
		default:
			return undefined;
	}
}

/** The notice of a held sender: naming the sender's id when `namedId` is given (`nameableSenderId`). */
export function senderNotice(reason: string, name: string, namedId: string | undefined): WordedNotice {
	return wordedNotice(reason, (words) =>
		namedId !== undefined
			? words.notices.channels.senderHeld(name, namedId)
			: words.notices.channels.senderHeldUnnamed(name),
	);
}

/**
 * The line of what the daemon's host left, in one catalogue's words: its drafts by id and reason, the messages it
 * dropped and the conversations it left unanswered, and the messages it held, counted by reason. The most detail that
 * fits `MAX_RETAINED_DIAGNOSTIC_CHARS` in these words; the least is cut at the line's bound by the notice itself.
 */
function awayLine(
	words: InterfaceText["notices"]["channels"]["away"],
	name: string,
	away: ChannelAwayUntold,
	{ expired, unanswered, held }: AwayCounts,
): string {
	const kinds = [
		...(away.held.not_allowed ? [words.notAllowed(away.held.not_allowed, name)] : []),
		...(away.held.unverified ? [words.unverified(away.held.unverified)] : []),
		...(away.held.burst ? [words.burst(away.held.burst, name)] : []),
	];
	const compose = (named: number, heldDetail: boolean): string => {
		const parts: string[] = [];
		if (away.drafts.length > 0) {
			const listed = away.drafts.slice(0, named).map((draft) => `${draft.id}: ${draft.reason}`);
			const more = away.drafts.length - listed.length;
			if (more > 0 && listed.length > 0) listed.push(words.more(more));
			parts.push(words.drafts(away.drafts.length, listed));
		}
		if (expired > 0) parts.push(words.expired(expired));
		if (unanswered > 0) parts.push(words.unanswered(unanswered));
		if (held > 0) parts.push(words.held(held, heldDetail ? kinds : undefined));
		return words.served(name, parts);
	};
	for (let named = Math.min(MAX_NAMED_AWAY_DRAFTS, away.drafts.length); named >= 0; named--)
		for (const heldDetail of [true, false]) {
			const candidate = compose(named, heldDetail);
			if (candidate.length <= MAX_RETAINED_DIAGNOSTIC_CHARS) return candidate;
		}
	return compose(0, false);
}

/** The notice of what the daemon's host left, or none when it left nothing to tell; each language fitted on its own. */
export function channelAwayNotice(reason: string, name: string, away: ChannelAwayUntold): HarnessNotice | undefined {
	const summed = (kind: "expired" | "unanswered") =>
		away.gaps.filter((gap) => gap.reason === kind).reduce((sum, gap) => sum + gap.count, 0);
	const counts: AwayCounts = {
		expired: summed("expired"),
		unanswered: summed("unanswered"),
		held: heldCount(away.held),
	};
	if (away.drafts.length === 0 && counts.expired === 0 && counts.unanswered === 0 && counts.held === 0)
		return undefined;
	return wordedNotice(reason, (words) => awayLine(words.notices.channels.away, name, away, counts));
}

/** The id a held-sender notice names: a plain platform-assigned id whose notice fits its line, else none. */
export function nameableSenderId(
	name: string,
	senderId: string,
	senderIds: ChannelSenderIds | undefined,
): string | undefined {
	if (senderIds?.assignedBy !== "platform" || !PLAIN_SENDER_ID.test(senderId)) return undefined;
	// Decided on the model's English line alone, so the interface language never changes what the model is told.
	return senderNotice("", name, senderId).text.length <= MAX_RETAINED_DIAGNOSTIC_CHARS ? senderId : undefined;
}
