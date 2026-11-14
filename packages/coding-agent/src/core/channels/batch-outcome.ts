/**
 * How a delivered channel batch's turn ended, read from the session branch that ran it: answered, still waiting for its
 * turn, or unanswered and why. It owns the reading of that branch (the turn-origin stamps that name the batch and the
 * assistant answer after them) and nothing else; it writes no journal and no transcript.
 */
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { entryTurnOrigin, isDecisiveOrigin } from "../turn-origin.ts";
import { type ChannelBatchRecord, DAY_MS } from "./channel-journal.ts";

/** The branches a batch's turn can run on: this session's, and the owner's when an owner batch runs in another session. */
export interface BatchBranchSource {
	getSessionManager(): Pick<SessionManager, "getBranch">;
	getOwnerSessionManager?(): Pick<SessionManager, "getBranch">;
}

function messageText(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	const texts: string[] = [];
	for (const part of content) if (part.type === "text" && part.text.length > 0) texts.push(part.text);
	return texts.join("\n");
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
	| { readonly kind: "answered"; readonly text: string; readonly usd: number }
	| { readonly kind: "unanswered"; readonly reason: UnansweredReason; readonly usd: number };

/**
 * How a batch's turn ended, with what its assistant messages cost so far. Its user entry is the one whose origin
 * record names this channel and the batch's id (`ref`). The answer is the first completed assistant answer after it;
 * a decisive entry before that (the owner's words, or another third party's, a host event someone else wrote
 * included) means this batch got none.
 */
export function readBatchOutcome(
	source: BatchBranchSource,
	name: string,
	batch: ChannelBatchRecord,
	now: number,
): BatchOutcome {
	const owner = batch.owner === true ? source.getOwnerSessionManager?.() : undefined;
	const branch = (owner ?? source.getSessionManager()).getBranch();
	let index = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		const origin = entry === undefined ? undefined : entryTurnOrigin(entry);
		// An owner batch's turn is stamped `owner-channel`, a third party's `inbound-channel`; both carry the batch id.
		if (
			(origin?.k === "inbound-channel" || origin?.k === "owner-channel") &&
			origin.channel === name &&
			origin.ref === batch.id
		) {
			index = i;
			break;
		}
	}
	if (index < 0)
		return now - batch.acceptedAt >= DAY_MS
			? { kind: "unanswered", reason: "not_delivered", usd: 0 }
			: { kind: "waiting", usd: 0 };
	let usd = 0;
	for (let i = index + 1; i < branch.length; i++) {
		const entry = branch[i];
		if (entry === undefined) continue;
		const origin = entryTurnOrigin(entry);
		if (origin && isDecisiveOrigin(origin))
			return {
				kind: "unanswered",
				reason:
					origin.k === "owner-typed"
						? "owner_steered"
						: batch.owner === true && origin.k === "owner-channel" && origin.channel === name
							? "owner_channel_joined"
							: "mixed",
				usd,
			};
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		usd += message.usage?.cost?.total ?? 0;
		// An aborted turn answers nothing; left waiting it would hold the channel's next turn for a day.
		if (message.stopReason === "aborted") return { kind: "unanswered", reason: "aborted", usd };
		if (message.stopReason === "stop" || message.stopReason === "length") {
			const text = messageText(message)?.trim() ?? "";
			return text ? { kind: "answered", text, usd } : { kind: "unanswered", reason: "empty_answer", usd };
		}
	}
	return now - batch.acceptedAt >= DAY_MS
		? { kind: "unanswered", reason: "no_answer", usd }
		: { kind: "waiting", usd };
}
