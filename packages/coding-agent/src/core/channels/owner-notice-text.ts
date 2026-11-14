/**
 * The owner-facing words a channel session writes about a channel's state, a held sender, what the daemon's host left
 * and the subscription allowance: pure builders with no session state, so the notice rules (one bounded line, an id
 * named only when the platform assigned it) live in one place next to their bounds. A notice's sentences are the notices
 * catalogue's (`notices.channels`): the model reads them in English, the owner in the interface language.
 */

import type { ChannelSenderIds } from "../gateways/channel-provider.ts";
import { type HarnessNotice, type WordedNotice, wordedNotice } from "../harness-notice.ts";
import type { InterfaceText } from "../language/interface-text.ts";
import { MAX_RETAINED_DIAGNOSTIC_CHARS } from "../security/secret-text.ts";
import { type ChannelAwayUntold, heldCount } from "./channel-journal.ts";
import type { ResolvedChannelPolicy } from "./channel-policy.ts";
import type { OwnerQuotaAllowance } from "./owner-channel-types.ts";

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
 * The one line that tells the owner of a held sender and the key to add them to: with the id only when the notice may
 * name it; any other id is read through `channel_reply` `list`, fenced as data. Without an id the line fits
 * `MAX_RETAINED_DIAGNOSTIC_CHARS` for the longest channel name, so it is never cut.
 */
/** The status line for the subscription allowance (none when the model is no subscription login): whether the dollar bounds apply now, and why. */
export function quotaStatusLine(
	name: string,
	policy: ResolvedChannelPolicy,
	quota: OwnerQuotaAllowance,
): string | undefined {
	const key = `channels.${name}.ownerQuotaMaxUsedPercent`;
	if (quota.kind === "room")
		return `Subscription usage: ${Math.round(quota.usedPercent)}% of ${policy.ownerQuotaMaxUsedPercent}% (${key}); the dollar bounds do not apply.`;
	if (quota.kind === "exhausted")
		return `Subscription usage: ${quota.reason} (${key} ${policy.ownerQuotaMaxUsedPercent}%); the dollar bounds apply.`;
	return quota.subscription ? `Subscription usage: ${quota.reason}; the dollar bounds apply.` : undefined;
}

/**
 * The notice a channel's state shows the owner, or none for a state that needs no telling. `connectionLost`: the detail
 * is what the started transport reported; `builtIn`: the transport is a shipped one, which a session start tries again.
 */
export function channelStateNotice(
	name: string,
	state: string,
	detail: string | undefined,
	facts: { readonly connectionLost: boolean; readonly builtIn: boolean },
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
			return wordedNotice(reason, (words) => words.notices.channels.capped(name, detail));
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
