/**
 * The owner-facing words a channel session writes about a channel's state, a held sender and the subscription
 * allowance: pure text builders with no session state, so the notice rules (one bounded line, an id named only when the
 * platform assigned it) live in one place next to their bounds.
 */

import type { ChannelSenderIds } from "../gateways/channel-provider.ts";
import { MAX_RETAINED_DIAGNOSTIC_CHARS } from "../security/secret-text.ts";
import type { ResolvedChannelPolicy } from "./channel-policy.ts";
import type { OwnerQuotaAllowance } from "./owner-channel-types.ts";

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
): { readonly reason: string; readonly text: string } | undefined {
	const reason = `${name}:${state}:${detail ?? ""}`;
	switch (state) {
		case "not_configured":
			return {
				reason,
				text: `Channel ${name} is registered but not started: no channels.${name} policy in the global or directory-profile settings.`,
			};
		case "invalid":
			return { reason, text: `Channel ${name} is not started: ${detail ?? "its policy cannot be read"}.` };
		case "served_elsewhere":
			return { reason, text: `Channel ${name} is not started in this session: another open session serves it.` };
		case "suspended":
			if (facts.connectionLost) return { reason, text: `Channel ${name} is not receiving messages: ${detail}.` };
			return {
				reason,
				text: `Channel ${name} did not start (${detail ?? "start failed"}); it is tried again when settings change or ${facts.builtIn ? "a session starts" : "the provider registers again"}.`,
			};
		case "capped":
			return {
				reason,
				text: `Channel ${name} holds new messages: ${detail ?? "its daily bound is reached"}. They wait up to 24 hours.`,
			};
		default:
			return undefined;
	}
}

export function senderNoticeText(name: string, namedId: string | undefined): string {
	return namedId !== undefined
		? `Channel ${name} held a message from sender ${namedId}, who is not in channels.${name}.allowedSenders. To let them start turns, add "${namedId}" to that list.`
		: `Channel ${name} held a verified sender not in channels.${name}.allowedSenders; the channel_reply list action shows its id.`;
}

/** The id a held-sender notice names: a plain platform-assigned id whose notice fits its line, else none. */
export function nameableSenderId(
	name: string,
	senderId: string,
	senderIds: ChannelSenderIds | undefined,
): string | undefined {
	if (senderIds?.assignedBy !== "platform" || !PLAIN_SENDER_ID.test(senderId)) return undefined;
	return senderNoticeText(name, senderId).length <= MAX_RETAINED_DIAGNOSTIC_CHARS ? senderId : undefined;
}
