import type { BotCreationRequest, CreatedBotView } from "./bot-creation.ts";
import type { WorkerAgentControlPort, WorkerAgentReplyResult } from "./worker-agent-control.ts";

export const BOT_MESSAGE_TOOL_NAME = "bot_message";

export interface BotMessagePeer {
	agentId: string;
	displayName: string;
	state: string;
	available: boolean;
	/** Set on a bot the owner made a leader: the one to ask for a new bot. */
	leader?: true;
}

/** Parent-owned alias resolution, fenced to the sender's exact execution and branch. */
export interface BotMessageDirectory {
	assertCurrent(): void;
	list(teamId?: string): {
		groups: { teamId: string; name: string }[];
		totalGroups: number;
		peers: BotMessagePeer[];
		total: number;
	};
	resolve(agentId: string, teamId?: string): string;
	threadId(teamId?: string): string | undefined;
	authorizeReply(threadId: string | undefined, sender: string | undefined, teamId?: string): void;
	recordSent(messageId: string, target: string, message: string): void;
	/** Present only for a leader: creates a bot on the leader's authority. */
	createBot?(request: BotCreationRequest): CreatedBotView;
	/** Ids of the leaders, for the answer a bot gets when it may not create one. */
	leaderIds(): readonly string[];
	/** The live leader that created the sender, when one did: the one it asks first. */
	ownLeader(): string | undefined;
}

/** No lifecycle controls or caller-selected sender identities cross this port. */
export interface BotMessageBroker {
	list(teamId?: string): ReturnType<BotMessageDirectory["list"]>;
	send(
		agentId: string,
		message: string,
		expectReply: boolean,
		invocationId: string,
		teamId?: string,
	): ReturnType<WorkerAgentControlPort["followUpWorkerAgent"]>;
	reply(messageId: string, message: string, teamId?: string): WorkerAgentReplyResult;
	/** Present only for a leader. */
	create?(request: BotCreationRequest): CreatedBotView;
	leaderIds(): readonly string[];
	ownLeader(): string | undefined;
}
