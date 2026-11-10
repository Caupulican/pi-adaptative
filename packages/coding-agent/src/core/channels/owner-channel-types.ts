/**
 * The interfaces the owner channel is built against. An owner channel is a platform chat the owner lists
 * (`channels.<name>.ownerSenders`): a message from a listed, verified identity in a private chat is the owner's words
 * reaching a persistent session from a phone. The session core delivers and gates those words; the channels core admits,
 * routes and answers them; neither imports the other's internals, so both build against these shapes.
 */

import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { EdgeClass } from "../autonomy/edge-policy.ts";

/** The longest rendering of a held call a phone message carries; a call that does not fit is released at the terminal. */
export const OWNER_DRAFT_RENDERING_MAX_CHARS = 2000;

/** Who sent an owner-channel turn: the channel, a digest of the verified sender (never the raw id), the batch it rode in. */
export interface OwnerChannelOrigin {
	readonly channel: string;
	readonly senderDigest: string;
	/** The channel's batch id for this delivery, so the run it opens finds its turn again. */
	readonly ref: string;
	/**
	 * Set (true) when the channel's policy read `ownerAuthority: "full"` at the offer: the run holds the owner's own
	 * authority for as long as its `live` answers true. Any policy change ends `live`, so this never outlives the setting.
	 */
	readonly full?: true;
}

/**
 * How the channels core hands an owner's words, or an approval it recorded, to the session that hosts the phone
 * conversation. Only the channels core holds one; an extension cannot mint an owner-channel turn.
 */
export interface OwnerChannelDelivery {
	/**
	 * Follow-up delivery: no slash processing, stamped as an owner-channel turn, recorded under the `channel` input
	 * source. `live` is the channels core's answer, asked at every guarded call of the run this message opens, to whether
	 * the channel still holds the owner's authority (sender still listed, shipped provider, emergency stop not engaged);
	 * a run whose `live` is gone or answers false has no authority, so the session never decides that from its own state.
	 */
	deliver(
		text: string,
		origin: OwnerChannelOrigin,
		live: () => boolean,
		onAccepted: (accepted: boolean) => void,
	): void;
	/** The turn that carries a recorded approval: the same owner-channel stamp, a non-owner input source. */
	deliverApproval(
		text: string,
		origin: OwnerChannelOrigin,
		live: () => boolean,
		onAccepted: (accepted: boolean) => void,
	): void;
	/** Reports the cost of the run that `ref` opened as it grows; returns the unsubscribe. */
	observeRunUsage(ref: string, onUsd: (usd: number) => void): () => void;
	/**
	 * Whether the subscription the session's model runs on has allowance: room while every usage window the account reports
	 * is below `maxUsedPercent`. Unknown (also when this member is absent) leaves the dollar bounds in force.
	 */
	quotaAllowance?(maxUsedPercent: number): OwnerQuotaAllowance;
	/** Aborts the run that `ref` opened. */
	abortRun(ref: string): void;
}

/** What the subscription's own usage limits allow now (`SubscriptionAllowance`): decided in code from the account's reported windows. */
export type OwnerQuotaAllowance =
	| { readonly kind: "room"; readonly usedPercent: number }
	| { readonly kind: "exhausted"; readonly usedPercent: number; readonly reason: string }
	/** `subscription`: the model is a subscription login (so the status says why no reading decides); false when none applies. */
	| { readonly kind: "unknown"; readonly reason: string; readonly subscription: boolean };

/** The model-free control words an owner message can be, recognized before any model turn. */
export type OwnerControl =
	| { readonly kind: "approve" | "deny"; readonly draftId: string }
	| { readonly kind: "status" | "stop" };

/**
 * A held outward action as the owner's phone sees it. The `rendering` is built from the complete tool call (secret-shaped
 * values replaced by an explicit marker, control characters made visible, nothing model-written); it is `undefined` when
 * the complete call does not fit `OWNER_DRAFT_RENDERING_MAX_CHARS`, and such a draft is released at the terminal only.
 */
export interface OwnerDraftView {
	/** `H(requestEntryId, callDigest)`; the digest covers the complete tool name and arguments. */
	readonly id: string;
	readonly classes: readonly EdgeClass[];
	readonly toolName: string;
	readonly rendering: string | undefined;
	readonly origin: TurnOriginRecord;
	readonly state: "pending" | "approved" | "released" | "denied" | "dismissed" | "expired";
	readonly preparedAt: string;
}

/** Who decided a draft: the verified owner origin and the digest of the event that carried the decision. */
export type OwnerDecisionBy = OwnerChannelOrigin & { readonly eventDigest: string };

/** What an approval is checked against besides the draft itself. */
export interface OwnerApprovalPolicy {
	/** Classes the owner keeps terminal-only (`channels.<name>.ownerTerminalOnlyClasses`). */
	readonly terminalOnlyClasses: readonly EdgeClass[];
}

/** The owner's decisions over the drafts of the hosting session. Each decision names exactly one draft. */
export interface OwnerDraftDecisions {
	drafts(): readonly OwnerDraftView[];
	/** Records the approval of one draft; the held call is admitted once, when it is re-issued with an identical digest. */
	approve(
		draftId: string,
		by: OwnerDecisionBy,
		policy: OwnerApprovalPolicy,
	): OwnerDraftView["state"] | "absent" | "terminal-only";
	deny(draftId: string, by: OwnerDecisionBy): OwnerDraftView["state"] | "absent";
}

/** A call waiting on the owner in the hosting session, as that session's status shows it. */
export interface OwnerWaitingCall {
	/** Unique in the session and the same for as long as the call waits. */
	readonly key: string;
	/** One line of plain words. */
	readonly what: string;
	/** Epoch milliseconds the call started waiting; absent when no store records a time for it. */
	readonly since?: number;
}

/** The calls waiting on the owner in the hosting session, and the directory that session works in. */
export interface OwnerWaitingView {
	readonly sessionId: string;
	readonly cwd: string;
	readonly calls: readonly OwnerWaitingCall[];
}

/**
 * The decisions plus the stream of newly held drafts and the calls waiting on the owner: what the channels core holds of
 * the session that hosts the owner's work.
 */
export interface OwnerChannelControl extends OwnerDraftDecisions {
	/** Hears each draft the hosting session holds on a remote-owner run (to show it to the phone); returns the unsubscribe. */
	onDraftHeld(listener: (view: OwnerDraftView) => void): () => void;
	/**
	 * The calls waiting on the owner in the hosting session, but a draft held on a remote-owner run: its own chat is
	 * shown that one when it is held.
	 */
	waiting(): OwnerWaitingView;
}

/**
 * The part of the channels core's dependencies the session wiring fills; declared here so both sides build against it.
 * Every member is optional and an absent one fails closed: with no delivery handle, no control handle or no emergency
 * stop probe, the channels core never admits an owner message and every identity follows the third-party path.
 */
export interface SessionChannelsOwnerDeps {
	readonly ownerDelivery?: OwnerChannelDelivery;
	ownerControl?(): OwnerChannelControl | undefined;
	/** Whether the emergency stop file is engaged; no owner offer is made while it is, and without this probe none is made. */
	isEmergencyStopEngaged?(): boolean;
	/**
	 * Hears each change of that stop made in this process (`subscribeEmergencyStop`); returns the unsubscribe. Without it a
	 * change is seen at the channels core's next pass.
	 */
	subscribeEmergencyStop?(listener: () => void): () => void;
}
