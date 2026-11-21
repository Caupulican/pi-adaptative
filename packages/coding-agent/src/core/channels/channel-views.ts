/**
 * What a session shows of its channels: the runtime state of each registered channel, one channel's bounds used and
 * journal summary, and the drafts and held senders the owner's release tool lists. Types only; the channels core
 * (`session-channels.ts`) fills them.
 */
import type { ChannelServedBy } from "./away-channels.ts";

export type ChannelRuntimeState =
	| "not_configured"
	| "invalid"
	| "ignored"
	| "served_elsewhere"
	| "starting"
	| "armed"
	| "suspended"
	| "capped"
	| "stopped";

/** The read-only view of one registered channel. */
export interface ChannelStateView {
	readonly name: string;
	readonly state: ChannelRuntimeState;
	readonly detail?: string;
}

/** One channel's daily bounds used, and what its journal holds undelivered. */
export interface ChannelJournalSummary {
	readonly name: string;
	/** Turns delivered in the last 24 hours against `maxWakesPerDay`. */
	readonly wakes: { readonly used: number; readonly max: number };
	/** Metered (API) dollars the channel's turns cost in the last 24 hours against `maxUsdPerDay`. */
	readonly spendUsd: { readonly used: number; readonly max: number };
	readonly pendingMessages: number;
	readonly pendingDrafts: number;
	/** Messages held back (unverified, not allowlisted, or a burst) since the journal began. */
	readonly heldTotal: number;
	readonly gaps: number;
	/** Who serves the channel now, by its journal: this session, the daemon (no session open), another session, nobody. */
	readonly servedBy: ChannelServedBy;
	/** Reply drafts the daemon wrote while no session was open that still wait for the owner. */
	readonly awayDrafts: number;
	/**
	 * Dollars the channel's owner pool holds over the last 24 hours against `ownerMaxUsdPerDay` (`owner-channel.ts`);
	 * only while the policy lists owner senders.
	 */
	readonly ownerSpendUsd?: { readonly used: number; readonly max: number };
	/** Present while the policy lists owner senders and sets `ownerAuthority: "full"`. */
	readonly ownerFullAuthority?: true;
	/** Present while the dollar bounds are lifted: the highest usage window of the subscription, in percent. */
	readonly ownerQuotaUsedPercent?: number;
}

/** One reply draft as the owner's release tool lists it. */
export interface ChannelDraftView {
	readonly id: string;
	readonly channel: string;
	readonly reason: string;
	readonly createdAt: string;
	readonly text: string;
	/**
	 * `waiting`: nothing claimed it. `sending`: a settle is sending it now. `unknown`: a send was claimed and its session
	 * ended before it recorded the outcome, so the message may or may not have reached its conversation.
	 */
	readonly status: "waiting" | "sending" | "unknown";
}

/** A verified, not allowlisted sender whose id the sender chose, as the owner's release tool lists it (fenced). */
export interface ChannelHeldSenderView {
	readonly channel: string;
	readonly id: string;
	readonly heldAt: string;
}
