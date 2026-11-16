/**
 * The orchestrator's side of the bots: its `bot` tool (create, list, ask, retire, lead) and the replies bots give its asks
 * and its workers' mail. An ask to a leader running a goal is that goal's input (`delegationObjectiveId`); an ask to a bot
 * that answers in a session of its own is mail to that session (`rootAskMail`), whose answer comes back as a reply this
 * session reads (`RootBotReplies`); any other bot takes it as a worker, whose result reaches the session as a worker's
 * does. A worker's mail to such a bot (`workerMail`) is answered the same way, and the reply is handed to that worker's
 * mailbox (`toWorker`), or to this session when the worker has ended. A refusal of the ask reaches the orchestrator's
 * model in English (`botFailureForModel`).
 */

import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import type { BotToolPort } from "../delegation/bot-creation.ts";
import type { BotOperatorMessageOptions } from "../delegation/bot-operator-message-options.ts";
import type { DelegationRecord } from "../delegation/leader-delegation-ledger.ts";
import type {
	SessionRootWorkerAgentMessageOptions,
	WorkerAgentControlPort,
	WorkerAgentView,
} from "../delegation/worker-agent-control.ts";
import { captureWorkerReceiptOrigin } from "../delegation/worker-receipt-origin.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { createBotToolDefinition } from "../tools/bot.ts";
import { AGENT_MAIL_CHANNEL } from "../turn-origin.ts";
import { botFailureForModel } from "./bot-owner-error.ts";
import { RootBotReplies, type WorkerBotReply } from "./root-bot-replies.ts";

/** What the orchestrator's session lends its side of the bots, beyond its controller's dependencies. */
export interface RootBotsPorts {
	/** Sends the orchestrator's words to a bot (`BotOperatorDispatch.sendOperatorMessageToBot`). */
	send(agentId: string, message: string, options: BotOperatorMessageOptions): Promise<unknown>;
	/** The latest goal handed to a leader, whose input an ask to it is while it runs. */
	currentDelegation(alias: string): Pick<DelegationRecord, "state" | "objectiveId"> | undefined;
	/** The bot tool's actions other than the ask. */
	tool(): Omit<BotToolPort, "ask">;
	/** The session's workers, and the bot a worker's runtime is (in any generation), when it is one. */
	workers(): readonly WorkerAgentView[];
	botOf(runtime: string): string | undefined;
	/** Writes into a worker's mailbox as the session (`followUpSessionRootWorkerAgent`). */
	followUp(
		runtime: string,
		message: string,
		options: SessionRootWorkerAgentMessageOptions,
	): ReturnType<WorkerAgentControlPort["followUpSessionRootWorkerAgent"]>;
}

/** The origin a third party's reply carries into the worker's mailbox, which keeps only a third party's. */
function thirdPartyReplyOrigin(reply: WorkerBotReply): TurnOriginRecord {
	return { v: 1, k: "inbound-channel", channel: AGENT_MAIL_CHANNEL, thirdParty: true, ref: reply.replyId };
}

export class RootBots {
	private readonly ports: RootBotsPorts;
	/** The bots' replies to this session's asks and its workers' mail, read while the session takes its inputs. */
	readonly replies: RootBotReplies;

	constructor(deps: BackgroundLaneControllerDeps, ports: RootBotsPorts) {
		this.ports = ports;
		this.replies = new RootBotReplies({
			agentDir: () => deps.getAgentDir(),
			sessionId: () => deps.getSessionManager().getSessionId(),
			timers: deps.getTimers().port("bot-replies"),
			deliver: (input) => deps.deliverParentInput(input),
			hasDelivered: (id) => deps.getSessionManager().getParentInput(id) !== undefined,
			origin: () => captureWorkerReceiptOrigin(deps.getSessionManager()),
			toWorker: (runtime, reply) => this.toWorker(runtime, reply),
		});
	}

	/** The orchestrator's `bot` tool. */
	toolDefinition(): ToolDefinition {
		return createBotToolDefinition({ ...this.ports.tool(), ask: (agentId, message) => this.ask(agentId, message) });
	}

	private async ask(agentId: string, message: string): Promise<void> {
		try {
			await this.ports.send(agentId, message, {
				fromRoot: true,
				delegationObjectiveId: this.runningGoalOf(agentId),
			});
		} catch (error) {
			throw botFailureForModel(error);
		}
	}

	/** The goal a leader runs now, whose input words to it are. */
	private runningGoalOf(alias: string): string | undefined {
		const current = this.ports.currentDelegation(alias);
		return current?.state === "running" ? current.objectiveId : undefined;
	}

	/**
	 * Hands a bot's reply to the worker that mailed it, once (keyed by the reply), as the bot's words, not the session's: a
	 * leader's under the goal it runs. "ended" when that worker takes no message any more.
	 */
	private toWorker(runtime: string, reply: WorkerBotReply): "taken" | "ended" {
		const worker = this.ports.workers().find((agent) => agent.agentId === runtime);
		if (!worker || worker.status === "retired") return "ended";
		const alias = this.ports.botOf(runtime);
		const goal = alias === undefined ? undefined : this.runningGoalOf(alias);
		const result = this.ports.followUp(runtime, reply.text, {
			idempotencyKey: `bot-reply:${reply.replyId}`,
			agentWords: reply.thirdParty ? { turnOrigin: thirdPartyReplyOrigin(reply) } : {},
			...(goal !== undefined ? { delegationObjectiveId: goal } : {}),
		});
		if (result.messageId) return "taken";
		if (result.skipReason?.startsWith("agent_")) return "ended";
		throw new Error(`worker ${runtime} did not take it: ${result.skipReason ?? "no reason given"}`);
	}
}
