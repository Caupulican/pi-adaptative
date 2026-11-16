/**
 * The answers a bot's turn gives the mail it took (`bot-mail.ts`), sent back where each mail came from once the turn
 * ends: the last words the session said after a bot's mail, before the next outside input, are mailed back to that bot
 * as a reply one hop further on, its words after a group's message go to the group's log (as a member's answer to the
 * group, for that incarnation of it), and its words after the orchestrator's ask or a worker's mail are written as a reply
 * for the session that sent it (`root-bot-replies.ts`), which hears too of a turn that ended without any and hands a
 * worker's reply to that worker. A reply is not answered; a reply to a bot goes no further than `MAX_BOT_MAIL_HOPS`, and
 * one to the orchestrator's ask or a worker's mail always goes, its sender waiting for it (a worker's next mail carries
 * the hop on, `WorkerMailLedger.hopAfter`). A mail its host did not take is refused through the same routes, a bot's mail by a reply
 * mailed back to it (`refuseUntakenMail`), and the orchestrator's ask or a worker's mail whose turn ended where no
 * answer was sent is answered all the same (`settleReturnedMail`), so no sender waits forever.
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
import { agentMailTurnOrigin, entryTurnOrigin, isOutsideInputKind, turnOriginOf } from "../turn-origin.ts";
import { errorText } from "./bot-error-text.ts";
import {
	BOT_MAIL_REF_PREFIX,
	type BotMailAddress,
	botMailAddressText,
	botMailChain,
	botMailPrompt,
	botMailRefusedText,
	MAX_BOT_MAIL_HOPS,
	parseBotMailAddress,
} from "./bot-mail.ts";
import type { BotSender } from "./bot-session-host-ports.ts";
import type { BotSessionEntry } from "./bot-session-load.ts";
import { type RootBotReply, sendRootBotReply } from "./root-bot-replies.ts";

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
		// A group's log records a turn that failed without words as well (`groupSummary`).
		if (
			open &&
			(last.length > 0 || failure !== undefined || open.from.kind === "root" || open.from.kind === "worker")
		)
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

/** The sender a mail's answer is written back for (the orchestrator's ask, a worker's mail), when it is such a mail. */
export function returnedMailSender(
	origin: TurnOriginRecord | undefined,
): Extract<BotMailAddress, { kind: "root" | "worker" }> | undefined {
	const from = origin?.from === undefined ? undefined : parseBotMailAddress(origin.from);
	return from?.kind === "root" || from?.kind === "worker" ? from : undefined;
}

/** What a group's log records of a member's answer: its words, else why its turn ended without any. */
function groupSummary(answer: string, failure: string | undefined): string {
	return answer.length > 0 || failure === undefined ? answer : `The turn ended without an answer: ${failure}`;
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
		/** The host's own sender when absent: a refusal no loaded session sends. */
		sender?: BotSender,
	): Promise<BotOperatorMessageDispatchResult>;
	/** The metered spend of the window the transcript entry `entryId` opened (`BotSpendWindows.meteredSpendOfEntry`). */
	meteredSpendOf(entryId: string): number;
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
					summary: groupSummary(answer, failure),
				});
			} catch (error) {
				host.warn(words.botTurnOutcomeNotRecorded(agentId, errorText(error)));
			}
			continue;
		}
		const thirdParty = origin.thirdParty === true || runThirdParty;
		if (from.kind === "root" || from.kind === "worker") {
			// Its sender waits for it, whatever the hop: a reply is not answered, and the sender's next mail is bounded.
			try {
				replyToSender(host, turn, origin, from, {
					answer,
					...(failure !== undefined ? { failure } : {}),
					thirdParty,
				});
			} catch (error) {
				host.warn(words.botAskReplyNotSent(agentId, errorText(error)));
			}
			continue;
		}
		replyToBot(host, agentId, from.agentId, origin, answer, thirdParty, turn.sender);
	}
}

/**
 * Mails `text` to the bot `to` as the reply to its mail `origin`, one hop further on: nothing for words that are no
 * mail's (a reply is not answered) or past `MAX_BOT_MAIL_HOPS`. The owner is told when it cannot be delivered.
 */
function replyToBot(
	host: Pick<BotMailReplyHost, "deliver" | "warn">,
	agentId: string,
	to: string,
	origin: TurnOriginRecord,
	text: string,
	thirdParty: boolean,
	sender?: BotSender,
): void {
	const ref = botMailReplyRef(origin.ref);
	const hop = (origin.hop ?? 1) + 1;
	if (ref === undefined || hop > MAX_BOT_MAIL_HOPS) return;
	const address: BotMailAddress = { kind: "bot", agentId };
	const reply = agentMailTurnOrigin({ from: botMailAddressText(address), hop, ref, shown: text, thirdParty });
	void host
		.deliver(to, botMailPrompt(address, hop, text, true), { mode: "queue" }, reply, sender)
		.catch((error: unknown) => host.warn(interfaceText().botTeam.botMailReplyNotSent(agentId, to, errorText(error))));
}

/** Writes the reply to the orchestrator's ask or a worker's mail `origin`, with the metered spend of the turn that took it. */
function replyToSender(
	host: Pick<BotMailReplyHost, "replyToRoot" | "meteredSpendOf">,
	turn: Pick<BotMailTurn, "agentId" | "branch">,
	origin: TurnOriginRecord,
	from: Extract<BotMailAddress, { kind: "root" | "worker" }>,
	reply: { readonly answer: string; readonly failure?: string; readonly thirdParty: boolean },
): void {
	const replyId = botMailReplyRef(origin.ref);
	if (replyId === undefined) return;
	const entryId = turn.branch.find((entry) => entryTurnOrigin(entry)?.ref === origin.ref)?.id;
	host.replyToRoot({
		replyId,
		agentId: turn.agentId,
		rootSessionId: from.sessionId,
		...(from.kind === "worker" ? { worker: from.runtime } : {}),
		hop: (origin.hop ?? 1) + 1,
		thirdParty: reply.thirdParty,
		answer: reply.answer,
		...(reply.answer.length === 0 && reply.failure !== undefined ? { failure: reply.failure } : {}),
		meteredUsd: entryId === undefined ? 0 : host.meteredSpendOf(entryId),
	});
}

/**
 * Writes the reply to the returned mail `origin` (the orchestrator's ask, a worker's mail) that the bot's session took,
 * read from its transcript: the turn that took it ended where no answer was sent (its host stopped first, or the reply
 * could not be written then). A reply written before stays as it was. Nothing for other words; throws when it cannot
 * write the reply.
 */
export function settleReturnedMail(
	host: Pick<BotMailReplyHost, "replyToRoot" | "meteredSpendOf">,
	turn: Pick<BotMailTurn, "agentId" | "branch" | "messages">,
	origin: TurnOriginRecord,
): void {
	const from = returnedMailSender(origin);
	if (!from) return;
	const found = botMailAnswers(turn.messages, Number.NEGATIVE_INFINITY).find(
		(answer) => answer.origin.ref === origin.ref,
	);
	replyToSender(host, turn, origin, from, {
		answer: found?.answer ?? "",
		...(found?.failure !== undefined ? { failure: found.failure } : {}),
		thirdParty: origin.thirdParty === true || botMailChain(turn.branch).thirdParty,
	});
}

/**
 * Answers the sender of a mail `origin` a bot's host did not take (refused, set aside, or covered by the owner's stop)
 * that no answer comes and why (`reason`), in English for its model: a refusal reply written for the orchestrator's ask
 * or a worker's mail, and one mailed back to a bot that mailed, as its answer would be (`replyToBot`). Nothing for other
 * words; throws when it cannot write the reply.
 */
export function refuseUntakenMail(
	host: Pick<BotMailReplyHost, "replyToRoot" | "deliver" | "warn">,
	agentId: string,
	origin: TurnOriginRecord | undefined,
	reason: string,
): void {
	const from = origin?.from === undefined ? undefined : parseBotMailAddress(origin.from);
	if (!origin || !from) return;
	if (from.kind === "bot") {
		replyToBot(
			host,
			agentId,
			from.agentId,
			origin,
			botMailRefusedText(agentId, "mail", reason),
			origin.thirdParty === true,
		);
		return;
	}
	const replyId = botMailReplyRef(origin.ref);
	if ((from.kind !== "root" && from.kind !== "worker") || replyId === undefined) return;
	host.replyToRoot({
		replyId,
		agentId,
		rootSessionId: from.sessionId,
		...(from.kind === "worker" ? { worker: from.runtime } : {}),
		hop: (origin.hop ?? 1) + 1,
		thirdParty: origin.thirdParty === true,
		answer: "",
		failure: reason,
		refused: true,
	});
}

/** What answering a host's mail needs of it beyond each loaded session. */
export interface BotMailAnsweringPorts {
	agentDir(): string;
	/** The clock the replies are stamped on. */
	now(): number;
	store(): Pick<PersistentBotTeamStore, "recordBotTurnOutcome">;
	deliver: BotMailReplyHost["deliver"];
	/** An owner-facing warning of the host's own session. */
	warn(message: string): void;
}

/** A loaded bot session, as answering its mail reads it. */
export type BotMailSession = Pick<
	BotSessionEntry,
	"agentId" | "session" | "sessionManager" | "sender" | "meteredSpendOf"
>;

/**
 * How one host answers the mail its bots' sessions take: each ended turn's answers (`turnEnded`), a returned mail a
 * turn took and left unanswered (`settle`), and one the host did not take (`refuse`).
 */
export class BotMailAnswering {
	private readonly ports: BotMailAnsweringPorts;

	constructor(ports: BotMailAnsweringPorts) {
		this.ports = ports;
	}

	/** Writes a bot's reply for the session that asked or whose worker mailed (`sendRootBotReply`). */
	private replyToRoot(reply: RootBotReply): void {
		sendRootBotReply(
			this.ports.agentDir(),
			() => this.ports.now(),
			reply,
			(message) => this.ports.warn(message),
		);
	}

	/** What the answers of the loaded session's turns are sent through. */
	private host(entry: BotMailSession): BotMailReplyHost {
		return {
			store: () => this.ports.store(),
			replyToRoot: (reply) => this.replyToRoot(reply),
			deliver: (agentId, message, options, origin, sender) =>
				this.ports.deliver(agentId, message, options, origin, sender),
			meteredSpendOf: (entryId) => entry.meteredSpendOf(entryId),
			warn: (message) => entry.sender.warn(message),
		};
	}

	/** Sends the answers of the session's turn that began at `since` and ended (`sendBotMailAnswers`). */
	turnEnded(entry: BotMailSession, since: number): void {
		const { agentId, session, sessionManager, sender } = entry;
		const branch = sessionManager.getBranch();
		sendBotMailAnswers(this.host(entry), { agentId, messages: session.messages, since, branch, sender });
	}

	/**
	 * Writes the reply the returned mail `origin` the session took is owed, read from its transcript (`settleReturnedMail`):
	 * false, the owner told, when it cannot be written yet, so its record stays and is settled again. True for other words.
	 */
	settle(entry: BotMailSession, origin: TurnOriginRecord | undefined): boolean {
		if (origin === undefined || returnedMailSender(origin) === undefined) return true;
		try {
			const { agentId, session, sessionManager } = entry;
			const turn = { agentId, messages: session.messages, branch: sessionManager.getBranch() };
			settleReturnedMail(this.host(entry), turn, origin);
			return true;
		} catch (error) {
			entry.sender.warn(interfaceText().botTeam.botAskReplyNotSent(entry.agentId, errorText(error)));
			return false;
		}
	}

	/** Answers the sender of a mail the host did not take that no answer comes (`refuseUntakenMail`). */
	refuse(agentId: string, origin: TurnOriginRecord | undefined, reason: string): void {
		try {
			const host = {
				replyToRoot: (reply: RootBotReply) => this.replyToRoot(reply),
				deliver: this.ports.deliver,
				warn: (message: string) => this.ports.warn(message),
			};
			refuseUntakenMail(host, agentId, origin, reason);
		} catch (error) {
			this.ports.warn(interfaceText().botTeam.botAskReplyNotSent(agentId, errorText(error)));
		}
	}
}
