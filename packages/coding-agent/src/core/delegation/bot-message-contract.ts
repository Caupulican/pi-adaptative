import type { BotMailSent } from "../bots/bot-mail.ts";
import type { LeadRequest, LeadResult } from "./leader-delegation.ts";
import type { WorkerAgentControlPort, WorkerAgentReplyResult } from "./worker-agent-control.ts";

export const BOT_MESSAGE_TOOL_NAME = "bot_message";

/** A question a leader put to the orchestrator in the middle of its goal: the id it was filed under. */
export interface BotAskRootResult {
	readonly askId: string;
}

/**
 * What a leader's send to one of its own bots did, when that bot had no live runtime and was started as the leader's
 * child: `handled: false` leaves the send to the ordinary mailbox path (a live bot, or a bot the leader did not make).
 */
export type BotOwnedStartOutcome =
	| { readonly handled: false }
	| { readonly handled: true; readonly accepted: boolean; readonly detail: string };

export interface BotMessagePeer {
	agentId: string;
	displayName: string;
	state: string;
	available: boolean;
	/** Set on a bot the owner made a leader: the one to ask for a new bot. */
	leader?: true;
}

/** Where a send to a bot goes: its live worker runtime, or the session of a bot that answers in one of its own. */
export type BotMessageTarget =
	| { readonly kind: "worker"; readonly runtime: string }
	| { readonly kind: "session"; readonly agentId: string };

/** A send mailed to a bot's own session (`messageId`: the mail's id); the bot's answer comes back to the sender on its own. */
export interface BotSessionMailSent extends BotMailSent {
	readonly messageId: string;
	readonly detail: string;
}

/** Parent-owned alias resolution, fenced to the sender's exact execution and branch. */
export interface BotMessageDirectory {
	/** Set where the sender reaches no bot or group and only replies to its own session root. */
	readonly sessionRootOnly?: true;
	assertCurrent(): void;
	list(teamId?: string): {
		groups: { teamId: string; name: string }[];
		totalGroups: number;
		peers: BotMessagePeer[];
		total: number;
	};
	resolve(agentId: string, teamId?: string): BotMessageTarget;
	/**
	 * Mails the words to a bot that answers in a session of its own, as the sender's (`workerMail`): a third party's when
	 * `thirdParty`, under the mail id its replay key derives.
	 */
	mailSession(
		agentId: string,
		message: string,
		replayKey: string,
		thirdParty: boolean,
		teamId?: string,
	): Promise<BotSessionMailSent>;
	threadId(teamId?: string): string | undefined;
	authorizeReply(threadId: string | undefined, sender: string | undefined, teamId?: string): void;
	recordSent(messageId: string, target: string, message: string): void;
	/** Present only for a leader: asks the orchestrator a question in the middle of its goal; the goal stays open. */
	askRoot?(question: string): Promise<BotAskRootResult>;
	/** Present only for a leader: starts one of its own bots with no live runtime as the leader's child. */
	startOwnedBot?(agentId: string, message: string, invocationId: string): Promise<BotOwnedStartOutcome>;
	/** Present only for a leader whose goal may hand a part on: the leader handed a nested goal to a leader of its own. */
	lead?(request: LeadRequest): LeadResult;
	/** Present only for a leader: sends to a leader it handed a goal to, as an update to that goal. False when that leader is not one of its goals. */
	sendToSubLeader?(agentId: string, message: string): Promise<boolean>;
	/** The live leader that created the sender, when one did: the one it asks first. */
	ownLeader(): string | undefined;
}

/** No lifecycle controls or caller-selected sender identities cross this port. */
export interface BotMessageBroker {
	/** Set where the sender only replies to its own session root: the tool offers `reply` alone. */
	readonly sessionRootOnly?: true;
	list(teamId?: string): ReturnType<BotMessageDirectory["list"]>;
	send(
		agentId: string,
		message: string,
		expectReply: boolean,
		invocationId: string,
		teamId?: string,
	): Promise<ReturnType<WorkerAgentControlPort["followUpWorkerAgent"]> | BotSessionMailSent>;
	reply(messageId: string, message: string, teamId?: string): WorkerAgentReplyResult;
	/** Present only for a leader: the orchestrator is asked now; its answer arrives as the leader's next turn. */
	askRoot?(question: string): Promise<BotAskRootResult>;
	/** Present only for a leader: starts one of its own bots with no live runtime as the leader's child. */
	startOwnedBot?(agentId: string, message: string, invocationId: string): Promise<BotOwnedStartOutcome>;
	/** Present only for a leader whose goal may hand a part on: the leader handed a nested goal to a leader of its own. */
	lead?(request: LeadRequest): LeadResult;
	/** Present only for a leader: sends to a leader it handed a goal to, as an update to that goal. False when that leader is not one of its goals. */
	sendToSubLeader?(agentId: string, message: string): Promise<boolean>;
	ownLeader(): string | undefined;
}
