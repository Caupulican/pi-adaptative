/**
 * How a delivered channel batch's turn ended, read from the session branch that ran it: answered, still waiting for its
 * turn, or unanswered and why. It owns the reading of that branch (the turn-origin stamps that name the batch and the
 * assistant answer after them) and nothing else; it writes no journal and no transcript.
 */
import type { Api, Model } from "@caupulican/pi-ai";
import { assistantAnswerTextParts, isAssistantCommentary } from "../../kernel/assistant-answer.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { isMeteredSpend, type ModelBilling } from "../orchestration/risk-budget.ts";
import { ORDINARY_WORK_CONTINUATION_TYPE, ordinaryWorkContinuationRef } from "../ordinary-work-policy.ts";
import { entryTurnOrigin, isDecisiveOrigin, isHostContextEntry, isOutsideInputKind } from "../turn-origin.ts";
import { type ChannelBatchRecord, DAY_MS } from "./channel-journal.ts";
import type { OwnerChannelDelivery } from "./owner-channel-types.ts";

/** The branches a batch's turn can run on: this session's, and the owner's when an owner batch runs in another session. */
type BatchSession = Pick<SessionManager, "getBranch"> & Partial<Pick<SessionManager, "getSessionId">>;

export interface BatchBranchSource {
	getSessionManager(): BatchSession;
	isForegroundBusy?(): boolean;
	readonly ownerDelivery?: Pick<OwnerChannelDelivery, "holdsForeground" | "isAnsweringBatch">;
	getOwnerSessionManager?(): BatchSession;
	/**
	 * The models and the billing kind of their credentials (the model registry) a turn's spend is counted by: the channel's
	 * dollar bounds count metered (API) spend only. Without it every assistant message's spend counts as metered.
	 */
	getModelRegistry?(): BatchSpendBilling;
}

/** The model registry members the metered reading uses. */
export interface BatchSpendBilling extends ModelBilling {
	find(provider: string, modelId: string): Model<Api> | undefined;
}

/** What an assistant message cost in metered (API) spend: none when its model runs on a subscription (`isMeteredSpend`). */
function meteredUsd(usd: number, provider: string, modelId: string, billing: BatchSpendBilling | undefined): number {
	if (usd === 0 || !billing) return usd;
	return isMeteredSpend(billing.find(provider, modelId), billing) ? usd : 0;
}

/** Why a delivered conversation got no reply: never delivered, a decisive turn of someone else came first, or no answer. */
export type UnansweredReason =
	| "not_delivered"
	| "owner_steered"
	| "owner_channel_joined"
	| "mixed"
	| "aborted"
	| "empty_answer"
	| "no_answer";

/** How a delivered batch's turn ended, read from the session branch. */
export type BatchOutcome =
	| { readonly kind: "waiting"; readonly usd: number }
	| { readonly kind: "answered"; readonly text: string; readonly truncated?: true; readonly usd: number }
	| { readonly kind: "unanswered"; readonly reason: UnansweredReason; readonly usd: number };

/** The metered foreground answers to the stamped input, through any host-reserved revisions of that same opening. */
export function readBatchOutcome(
	source: BatchBranchSource,
	name: string,
	batch: ChannelBatchRecord,
	now: number,
): BatchOutcome {
	const owner = batch.owner === true ? source.getOwnerSessionManager?.() : undefined;
	const session = owner ?? source.getSessionManager();
	const branch = session.getBranch();
	const index = branch.findLastIndex((entry) => {
		const origin = entryTurnOrigin(entry);
		return (
			origin?.k === (batch.owner ? "owner-channel" : "inbound-channel") &&
			origin.channel === name &&
			origin.ref === batch.id
		);
	});
	const expired = now - batch.acceptedAt >= DAY_MS;
	const opening = branch[index];
	if (!opening) return expired ? { kind: "unanswered", reason: "not_delivered", usd: 0 } : { kind: "waiting", usd: 0 };
	const billing = source.getModelRegistry?.();
	let usd = 0;
	let sawCommentary = false;
	let candidate: { text: string; truncated?: true } | undefined;
	let awaitingReservation = false;
	let failedEntryId: string | undefined;
	let retryRequestId: string | undefined;
	let generation = 0;
	let revision = 0;
	const finish = (reason: UnansweredReason): BatchOutcome =>
		candidate ? { kind: "answered", ...candidate, usd } : { kind: "unanswered", reason, usd };
	for (let i = index + 1; i < branch.length; i++) {
		const entry = branch[i];
		if (!entry || isHostContextEntry(entry)) continue;
		if (entry.type === "request_snapshot" && (failedEntryId || retryRequestId)) {
			if (!failedEntryId || entry.retryOfAssistantEntryId !== failedEntryId) return finish("no_answer");
			retryRequestId = entry.requestId;
			failedEntryId = undefined;
			continue;
		}
		if (entry.type === "provider_request_terminal" && entry.requestId === retryRequestId) return finish("no_answer");
		if (batch.owner && entry.type === "custom_message" && entry.customType === ORDINARY_WORK_CONTINUATION_TYPE) {
			const details = ordinaryWorkContinuationRef(entry.details);
			if (
				!details ||
				details.sessionId !== session.getSessionId?.() ||
				details.openingEntryId !== opening.id ||
				details.generation <= generation ||
				details.revision <= revision
			)
				return finish("mixed");
			generation = details.generation;
			revision = details.revision;
			awaitingReservation = false;
			failedEntryId = undefined;
			retryRequestId = undefined;
			continue;
		}
		const origin = entryTurnOrigin(entry);
		if (
			((candidate || generation > 0) && (origin || (entry.type === "message" && entry.message.role === "user"))) ||
			(origin &&
				(isDecisiveOrigin(origin) ||
					((batch.owner || sawCommentary) && (isOutsideInputKind(origin.k) || origin.k === "extension-message"))))
		)
			return finish(
				origin?.k === "owner-typed"
					? "owner_steered"
					: batch.owner === true && origin?.k === "owner-channel" && origin.channel === name
						? "owner_channel_joined"
						: "mixed",
			);
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (awaitingReservation || failedEntryId) return finish("no_answer");
		retryRequestId = undefined;
		const message = entry.message;
		usd += meteredUsd(message.usage?.cost?.total ?? 0, message.provider, message.model, billing);
		if (message.stopReason === "aborted") return finish("aborted");
		if (generation > 0 && message.stopReason === "error") {
			if (!entry.id) return finish("no_answer");
			failedEntryId = entry.id;
			continue;
		}
		if (message.stopReason !== "stop" && message.stopReason !== "length") continue;
		const text = assistantAnswerTextParts(message).filter(Boolean).join("\n").trim();
		if (text) {
			candidate = message.stopReason === "length" ? { text, truncated: true } : { text };
			if (!batch.owner) return finish("no_answer");
			awaitingReservation = true;
			continue;
		}
		if (
			Array.isArray(message.content) &&
			message.content.some((part) => part.type === "text" && isAssistantCommentary(part))
		) {
			sawCommentary = true;
			continue;
		}
		return finish("empty_answer");
	}
	if (candidate) {
		if (!expired && source.ownerDelivery?.isAnsweringBatch?.(name, batch.id)) return { kind: "waiting", usd };
		return finish("no_answer");
	}
	if (sawCommentary) {
		const held = batch.owner ? source.ownerDelivery?.holdsForeground(batch.id) : source.isForegroundBusy?.();
		if (!held || expired) return finish("empty_answer");
	}
	return expired ? { kind: "unanswered", reason: "no_answer", usd } : { kind: "waiting", usd };
}
