/**
 * The model-free control words of the owner channel: `approve <draft-id>`, `deny <draft-id>`, `status`, `stop`. An
 * owner-admitted message that is one of them, as a whole, is answered by the harness and never becomes a turn or reaches
 * a model (`SessionChannels.receive`). Each decision names exactly one held draft; what it may decide is checked here
 * against the draft view and the facts the channels core hands in, and recorded only through `OwnerDraftDecisions`.
 */

import type { EdgeClass } from "../autonomy/edge-policy.ts";
import { hasMaskableSecretText } from "../security/secret-text.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { digest } from "./channel-journal.ts";
import type { OwnerChannelControl, OwnerControl, OwnerDecisionBy, OwnerDraftView } from "./owner-channel-types.ts";

const DRAFT_ID = /^draft-[0-9a-f]{16}$/;
/** Drafts one `status` reply lists; the rest are counted. */
export const MAX_STATUS_DRAFTS = 10;

/** The control word the whole message is, trimmed and lower-cased; undefined for anything else. */
export function parseOwnerControl(text: string): OwnerControl | undefined {
	const words = text.trim().toLowerCase().split(/\s+/);
	if (words.length === 1 && (words[0] === "status" || words[0] === "stop")) return { kind: words[0] };
	if (words.length !== 2) return undefined;
	const [verb, draftId] = words;
	if ((verb === "approve" || verb === "deny") && draftId !== undefined && DRAFT_ID.test(draftId))
		return { kind: verb, draftId };
	return undefined;
}

/**
 * Whether the held draft came from an owner turn on this channel opened by `senderDigest`'s message: the only drafts
 * that identity may decide or see. `openerOf` names the sender digest of the owner batch a turn's ref recorded.
 */
export function draftInScope(
	view: OwnerDraftView,
	channel: string,
	senderDigest: string,
	openerOf: (ref: string) => string | undefined,
): boolean {
	const ref = view.origin.ref;
	return (
		view.origin.k === "owner-channel" &&
		view.origin.channel === channel &&
		ref !== undefined &&
		openerOf(ref) === senderDigest
	);
}

function headLine(view: OwnerDraftView): string {
	return `Held for your decision: ${view.toolName} (${classLabels(view)}), draft ${view.id}.`;
}

/** The phone presentation with the complete call fenced; undefined when the call has no complete rendering. */
function fencedPresentation(view: OwnerDraftView): string | undefined {
	if (view.rendering === undefined) return undefined;
	return `${headLine(view)}\n${wrapUntrustedText(view.rendering, `held-call:${view.id}`, { nonce: digest(`${view.id}:${view.rendering}`).slice(0, 32) })}\nReply approve ${view.id} or deny ${view.id}.`;
}

/**
 * Whether the draft is released only at the terminal: a class the owner keeps there, no complete rendering, or a
 * rendering a push would refuse because it looks like it holds a secret (the phone never sees that call).
 */
export function terminalOnly(view: OwnerDraftView, terminalOnlyClasses: readonly EdgeClass[]): boolean {
	const fenced = fencedPresentation(view);
	return (
		fenced === undefined ||
		hasMaskableSecretText(fenced) ||
		view.classes.some((edgeClass) => terminalOnlyClasses.includes(edgeClass))
	);
}

/** The class labels a phone message names: the closed class names themselves. */
export function classLabels(view: Pick<OwnerDraftView, "classes">): string {
	return view.classes.length > 0 ? view.classes.join(", ") : "unclassified";
}

/**
 * The phone presentation of a held draft: its classes, id and complete rendering fenced as data, and the two words that
 * decide it; or, when the rendering is missing or a class is terminal-only, that it is released at the terminal.
 */
export function draftPresentation(view: OwnerDraftView, terminalOnlyClasses: readonly EdgeClass[]): string {
	const fenced = fencedPresentation(view);
	if (fenced !== undefined && !terminalOnly(view, terminalOnlyClasses)) return fenced;
	const why =
		fenced === undefined
			? "the complete call does not fit a phone message"
			: hasMaskableSecretText(fenced)
				? "the call looks like it holds a secret"
				: "its class is kept for the terminal";
	return `${headLine(view)} Release it at the terminal: ${why}.`;
}

/**
 * The approval turn's text: deterministic, built only from the draft's harness rendering (fenced: the arguments are
 * model-written), asking for exactly that one call.
 */
export function approvalTurnText(channel: string, view: OwnerDraftView): string {
	const rendering = view.rendering ?? "";
	return (
		`Owner approval on channel ${channel}: the owner approved held draft ${view.id} (${view.toolName}; ${classLabels(view)}). ` +
		"Perform exactly the call shown in the fence below, once, with the same tool and the same arguments, and nothing else; then answer in one line whether it ran.\n" +
		wrapUntrustedText(rendering, `held-call:${view.id}`, { nonce: digest(`${view.id}:${rendering}`).slice(0, 32) })
	);
}

/** What `approve` and `deny` read besides the draft: facts the channels core decided. */
export interface OwnerDecisionFacts {
	readonly channel: string;
	readonly control: OwnerChannelControl | undefined;
	readonly by: OwnerDecisionBy;
	readonly terminalOnlyClasses: readonly EdgeClass[];
	/** The sender digest of the owner batch a turn's ref recorded (`draftInScope`). */
	openerOf(ref: string): string | undefined;
	/** When the draft's presentation was sent to the conversation this decision came from; undefined if never. */
	presentedAt(draftId: string): number | undefined;
	/** When the deciding message was received (the platform's time, never later than admission). */
	readonly receivedAt: number;
	/** Why no turn may start now (the owner pool at its bound, the emergency stop); undefined when one may. */
	turnRefusal(): string | undefined;
	/** A turn already performs this draft. */
	approvalDelivered(draftId: string): boolean;
}

/** The reply to a decision, and on `approved` the draft whose approval turn the channels core delivers. */
export interface OwnerDecisionResult {
	readonly reply: string;
	readonly approved?: OwnerDraftView;
}

function stateReply(id: string, state: OwnerDraftView["state"] | "absent" | "terminal-only"): string {
	switch (state) {
		case "absent":
			return `No held action ${id}.`;
		case "released":
			return `Draft ${id} was already released.`;
		case "terminal-only":
			return `Draft ${id} must be released at the terminal.`;
		case "denied":
			return `Draft ${id} is denied; it will not run.`;
		case "approved":
			return `Draft ${id} is already approved.`;
		case "pending":
			return `Draft ${id} is still held; nothing was decided.`;
		default:
			return `Draft ${id} is no longer held (${state}).`;
	}
}

/** Decide one draft by the owner's `approve` or `deny`; writes only through the decisions handle. */
export function decideOwnerDraft(control: OwnerControl, facts: OwnerDecisionFacts): OwnerDecisionResult {
	if (control.kind !== "approve" && control.kind !== "deny") return { reply: "" };
	const id = control.draftId;
	const handle = facts.control;
	if (!handle) return { reply: "This session cannot take decisions now; decide it at the terminal." };
	const view = handle.drafts().find((draft) => draft.id === id);
	if (!view || !draftInScope(view, facts.channel, facts.by.senderDigest, facts.openerOf))
		return { reply: stateReply(id, "absent") };
	if (control.kind === "deny") {
		if (view.state !== "pending") return { reply: stateReply(id, view.state) };
		const result = handle.deny(id, facts.by);
		return { reply: result === "denied" ? `Denied draft ${id}; it will not run.` : stateReply(id, result) };
	}
	if (view.state !== "pending") return { reply: stateReply(id, view.state) };
	if (terminalOnly(view, facts.terminalOnlyClasses)) return { reply: stateReply(id, "terminal-only") };
	const presentedAt = facts.presentedAt(id);
	// Platform times are whole seconds: an approval sent in the second the presentation went out is after it.
	if (presentedAt === undefined || facts.receivedAt < Math.floor(presentedAt / 1000) * 1000)
		return { reply: `Draft ${id} was not shown to this chat before your approval; send status to see it.` };
	if (facts.approvalDelivered(id)) return { reply: stateReply(id, "approved") };
	const refusal = facts.turnRefusal();
	if (refusal) return { reply: `Approve refused: ${refusal}. deny, status and stop still work.` };
	const result = handle.approve(id, facts.by, { terminalOnlyClasses: facts.terminalOnlyClasses });
	if (result !== "approved") return { reply: stateReply(id, result) };
	return { reply: `Approved draft ${id}; a turn performs it now.`, approved: view };
}
