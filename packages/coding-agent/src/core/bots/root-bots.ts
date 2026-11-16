/**
 * The orchestrator's side of the bots: its `bot` tool (create, list, ask, retire, lead) and the replies the bots give its
 * asks. An ask to a leader running a goal is that goal's input (`delegationObjectiveId`); an ask to a bot that answers in
 * a session of its own is mail to that session (`rootAskMail`), whose answer comes back as a reply this session reads
 * (`RootBotReplies`); any other bot takes it as a worker, whose result reaches the session as a worker's does. A refusal
 * of the ask reaches the orchestrator's model in English (`botFailureForModel`).
 */

import type { BotToolPort } from "../delegation/bot-creation.ts";
import type { BotOperatorMessageOptions } from "../delegation/bot-operator-message-options.ts";
import type { DelegationRecord } from "../delegation/leader-delegation-ledger.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { createBotToolDefinition } from "../tools/bot.ts";
import { botFailureForModel } from "./bot-owner-error.ts";
import { RootBotReplies, type RootBotReplyPorts } from "./root-bot-replies.ts";

/** What the orchestrator's session lends its side of the bots. */
export interface RootBotsPorts extends RootBotReplyPorts {
	/** Sends the orchestrator's words to a bot (`BotOperatorDispatch.sendOperatorMessageToBot`). */
	send(agentId: string, message: string, options: BotOperatorMessageOptions): Promise<unknown>;
	/** The latest goal handed to a leader, whose input an ask to it is while it runs. */
	currentDelegation(alias: string): Pick<DelegationRecord, "state" | "objectiveId"> | undefined;
	/** The bot tool's actions other than the ask. */
	tool(): Omit<BotToolPort, "ask">;
}

export class RootBots {
	private readonly ports: RootBotsPorts;
	/** The bots' replies to this session's asks, read while the session takes its inputs. */
	readonly replies: RootBotReplies;

	constructor(ports: RootBotsPorts) {
		this.ports = ports;
		this.replies = new RootBotReplies(ports);
	}

	/** The orchestrator's `bot` tool. */
	toolDefinition(): ToolDefinition {
		return createBotToolDefinition({ ...this.ports.tool(), ask: (agentId, message) => this.ask(agentId, message) });
	}

	private async ask(agentId: string, message: string): Promise<void> {
		const current = this.ports.currentDelegation(agentId);
		try {
			await this.ports.send(agentId, message, {
				fromRoot: true,
				delegationObjectiveId: current?.state === "running" ? current.objectiveId : undefined,
			});
		} catch (error) {
			throw botFailureForModel(error);
		}
	}
}
