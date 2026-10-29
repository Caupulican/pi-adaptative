import type { WorkerAgentControlPort, WorkerAgentReplyResult } from "./worker-agent-control.ts";

export const BOT_MESSAGE_TOOL_NAME = "bot_message";

export interface BotMessagePeer {
	agentId: string;
	displayName: string;
	state: string;
	available: boolean;
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
}
