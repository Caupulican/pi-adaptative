/**
 * The answers a bot's turn gives the mail it took (`bot-mail.ts`), sent back where each mail came from once the turn
 * ends: the last words the session said after a bot's mail, before the next outside input, are mailed back to that bot
 * as a reply one hop further on, its words after a group's message go to the group's log (as a member's answer to the
 * group, for that incarnation of it), and its words after the orchestrator's ask or a worker's mail are written as a reply
 * for the session that sent it (`root-bot-replies.ts`), which hears too of a turn that ended without any and hands a
 * worker's reply to that worker. A reply is not answered, and none
 * goes past `MAX_BOT_MAIL_HOPS`.
 *
 * A reply's reference derives from the mail's alone (`reply:<mail id>`), so a reply sent again (the turn ran again after
 * its session reopened) is the same reply, which the asker's session does not take twice (`branchHoldsTurnRef`).
 */

import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import type {
	BotDeliveryOptions,
	BotDeliveryOrigin,
	BotOperatorMessageDispatchResult,
} from "../delegation/bot-operator-message-options.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../language/interface-text.ts";
import { agentMailTurnOrigin, isOutsideInputKind, turnOriginOf } from "../turn-origin.ts";
import { errorText } from "./bot-error-text.ts";
import {
	BOT_MAIL_REF_PREFIX,
	type BotMailAddress,
	botMailAddressText,
	botMailChain,
	botMailPrompt,
	MAX_BOT_MAIL_HOPS,
	parseBotMailAddress,
} from "./bot-mail.ts";
import type { BotSender } from "./bot-session-host.ts";
import type { RootBotReply } from "./root-bot-replies.ts";

/** The reference of the reply to the mail `ref` names; undefined when `ref` is no mail's (a reply is not answered). */
export function botMailReplyRef(ref: string | undefined): string | undefined {
	return ref?.startsWith(BOT_MAIL_REF_PREFIX) ? `reply:${ref.slice(BOT_MAIL_REF_PREFIX.length)}` : undefined;
}

/** A mail a turn took and the last words the session said after it (empty for none). */
interface BotMailAnswer {
	readonly origin: TurnOriginRecord & { readonly hop: number };
	readonly from: BotMailAddress;
	readonly answer: string;
	/** The error the last request after the mail ended on. */
	readonly failure?: string;
}

function assistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
}

/**
 * The mail of the turn that began at `since` and what the session answered each: the turn's messages are those after the
 * last answer written before it began; a mail's answer is the last words said after it, before the next outside input.
 * A mail answered with no words has none, but the orchestrator's ask and a worker's mail, whose sender waits for the
 * answer, still have one.
 */
function botMailAnswers(messages: readonly AgentMessage[], since: number): BotMailAnswer[] {
	let start = messages.length;
	while (start > 0) {
		const message = messages[start - 1];
		if (message?.role === "assistant" && message.timestamp < since) break;
		start--;
	}
	const answers: BotMailAnswer[] = [];
	let open: Omit<BotMailAnswer, "answer" | "failure"> | undefined;
	let last = "";
	let failure: string | undefined;
	const close = () => {
		if (open && (last.length > 0 || open.from.kind === "root" || open.from.kind === "worker"))
			answers.push({ ...open, answer: last, ...(failure !== undefined ? { failure } : {}) });
		open = undefined;
		last = "";
		failure = undefined;
	};
	for (const message of messages.slice(start)) {
		const text = assistantText(message);
		if (text.length > 0) last = text;
		if (message.role === "assistant" && message.stopReason === "error") failure = message.errorMessage;
		const origin = message.role === "assistant" ? undefined : turnOriginOf(message);
		if (!origin || !isOutsideInputKind(origin.k)) continue;
		close();
		const from = origin.from === undefined ? undefined : parseBotMailAddress(origin.from);
		if (from && origin.hop !== undefined) open = { origin: { ...origin, hop: origin.hop }, from };
	}
	close();
	return answers;
}

/** What sending a turn's answers reaches of the host. */
export interface BotMailReplyHost {
	store(): Pick<PersistentBotTeamStore, "recordBotTurnOutcome">;
	/** Writes a reply for the session that asked or whose worker mailed (`sendRootBotReply`); throws when it cannot. */
	replyToRoot(reply: RootBotReply): void;
	deliver(
		agentId: string,
		message: string,
		options: BotDeliveryOptions,
		origin: BotDeliveryOrigin,
		sender: BotSender,
	): Promise<BotOperatorMessageDispatchResult>;
	/** An owner-facing warning: an answer did not reach where its mail came from. */
	warn(message: string): void;
}

/** One ended turn of a bot's session, as its answers read it. */
export interface BotMailTurn {
	readonly agentId: string;
	readonly messages: readonly AgentMessage[];
	readonly since: number;
	readonly branch: readonly SessionEntry[];
	readonly sender: BotSender;
}

/** Sends the answers of the bot's ended turn to the mail it took, each once, where its mail came from. */
export function sendBotMailAnswers(host: BotMailReplyHost, turn: BotMailTurn): void {
	const { agentId } = turn;
	const words = interfaceText().botTeam;
	const runThirdParty = botMailChain(turn.branch).thirdParty;
	for (const { origin, from, answer, failure } of botMailAnswers(turn.messages, turn.since)) {
		if (from.kind === "group") {
			try {
				host.store().recordBotTurnOutcome({
					agentId,
					teamId: from.teamId,
					teamIncarnationId: from.incarnation,
					summary: answer,
				});
			} catch (error) {
				host.warn(words.botTurnOutcomeNotRecorded(agentId, errorText(error)));
			}
			continue;
		}
		const ref = botMailReplyRef(origin.ref);
		const hop = origin.hop + 1;
		if (ref === undefined || hop > MAX_BOT_MAIL_HOPS) continue;
		const thirdParty = origin.thirdParty === true || runThirdParty;
		if (from.kind === "root" || from.kind === "worker") {
			try {
				host.replyToRoot({
					replyId: ref,
					agentId,
					rootSessionId: from.sessionId,
					...(from.kind === "worker" ? { worker: from.runtime } : {}),
					hop,
					thirdParty,
					answer,
					...(answer.length === 0 && failure !== undefined ? { failure } : {}),
				});
			} catch (error) {
				host.warn(words.botAskReplyNotSent(agentId, errorText(error)));
			}
			continue;
		}
		const address: BotMailAddress = { kind: "bot", agentId };
		const reply = agentMailTurnOrigin({
			from: botMailAddressText(address),
			hop,
			ref,
			shown: answer,
			thirdParty,
		});
		void host
			.deliver(from.agentId, botMailPrompt(address, hop, answer, true), { mode: "queue" }, reply, turn.sender)
			.catch((error: unknown) => host.warn(words.botMailReplyNotSent(agentId, from.agentId, errorText(error))));
	}
}
