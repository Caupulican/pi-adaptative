/**
 * The orchestrator's side of the bots: its `bot` tool (create, list, ask, retire, lead) and the replies bots give its asks
 * and its workers' mail. An ask to a leader running a goal is that goal's input (`delegationObjectiveId`); an ask to a bot
 * that answers in a session of its own is mail to that session (`rootAskMail`), whose answer comes back as a reply this
 * session reads (`RootBotReplies`); any other bot takes it as a worker, whose result reaches the session as a worker's
 * does. A worker's mail to such a bot (`workerMail`) is answered the same way, and the reply is handed to that worker's
 * mailbox (`toWorker`), or to this session when the worker has ended. The session keeps its workers' mail
 * (`WorkerMailLedger`): each goal's mail, which holds the goal open until its reply is handed on, and the hop of each
 * reply handed to a worker, which the mail of the worker turn it starts or joins continues. A refusal of the ask reaches
 * the orchestrator's model in English (`botFailureForModel`).
 */

import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import type { BotToolPort } from "../delegation/bot-creation.ts";
import type { BotOperatorMessageOptions } from "../delegation/bot-operator-message-options.ts";
import { botReplyMessageKey, mailIdOfReply, replyTurnOver } from "../delegation/goal-mail.ts";
import type { LeaderController } from "../delegation/leader-controller.ts";
import {
	type SessionRootWorkerAgentMessageOptions,
	type WorkerAgentControlPort,
	type WorkerAgentView,
	workerAgentMessageId,
} from "../delegation/worker-agent-control.ts";
import { WorkerMailLedger } from "../delegation/worker-mail-ledger.ts";
import { captureWorkerReceiptOrigin } from "../delegation/worker-receipt-origin.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { createBotToolDefinition } from "../tools/bot.ts";
import { AGENT_MAIL_CHANNEL } from "../turn-origin.ts";
import { botFailureForModel } from "./bot-owner-error.ts";
import { RootBotReplies, type WorkerBotReply } from "./root-bot-replies.ts";

/** What the orchestrator's session lends its side of the bots, beyond its controller's dependencies. */
export interface RootBotsPorts {
	/** Sends the orchestrator's words to a bot (`BotOperatorDispatch.sendOperatorMessageToBot`). */
	send(agentId: string, message: string, options: BotOperatorMessageOptions): Promise<unknown>;
	/**
	 * The leader goals: the latest one handed to a leader, whose input an ask to it is while it runs, and the goal a
	 * worker's mail is held open by until its reply is handed on.
	 */
	leaders(): Pick<LeaderController, "currentFor" | "goalOfMail" | "mailEnded" | "recheckMail">;
	/** The session's orchestration projection: whether the worker turn a reply started or joined is over. */
	snapshot(): TaskRuntimeProjection;
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
	private readonly sessionId: () => string;
	/** The bots' replies to this session's asks and its workers' mail, read while the session takes its inputs. */
	readonly replies: RootBotReplies;
	/** The session's record of its workers' mail to bots that answer in sessions of their own. */
	readonly workerMail: WorkerMailLedger;

	constructor(deps: BackgroundLaneControllerDeps, ports: RootBotsPorts) {
		this.ports = ports;
		this.sessionId = () => deps.getSessionManager().getSessionId();
		const warn = (message: string) => deps.emit({ type: "warning", message });
		this.workerMail = new WorkerMailLedger({
			sessionId: this.sessionId,
			sessionFile: () => deps.getSessionManager().getSessionFile(),
			now: () => deps.getTimers().port("orchestration").now(),
			warn,
			replyTurnOver: (turn) => replyTurnOver(ports.snapshot(), turn),
		});
		this.replies = new RootBotReplies({
			agentDir: () => deps.getAgentDir(),
			sessionId: () => deps.getSessionManager().getSessionId(),
			timers: deps.getTimers().port("bot-replies"),
			deliver: (input) => deps.deliverParentInput(input),
			hasDelivered: (id) => deps.getSessionManager().getParentInput(id) !== undefined,
			origin: () => captureWorkerReceiptOrigin(deps.getSessionManager()),
			toWorker: (runtime, reply) => this.toWorker(runtime, reply),
			mailEnded: (replyId, end) => ports.leaders().mailEnded(mailIdOfReply(replyId), end),
			warn,
			setAside: () => ports.leaders().recheckMail(),
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
		const current = this.ports.leaders().currentFor(alias);
		return current?.state === "running" ? current.objectiveId : undefined;
	}

	/**
	 * Hands a bot's reply to the worker that mailed it, once (keyed by the reply), as the bot's words, not the session's:
	 * under the goal the mail was sent in while that goal is open (its turn is the goal's), else a leader's under the goal
	 * it runs. The reply's hop is recorded first, under the mailbox message the worker's turn starts from, and on the
	 * running turn when the reply joins it instead, so a mail of that turn continues the chain. "ended" when that worker
	 * takes no message any more.
	 */
	private toWorker(runtime: string, reply: WorkerBotReply): "taken" | "ended" {
		const worker = this.ports.workers().find((agent) => agent.agentId === runtime);
		if (!worker || worker.status === "retired") return "ended";
		const alias = this.ports.botOf(runtime);
		const goal =
			this.ports.leaders().goalOfMail(mailIdOfReply(reply.replyId)) ??
			(alias === undefined ? undefined : this.runningGoalOf(alias));
		const idempotencyKey = botReplyMessageKey(reply.replyId);
		const messageId = workerAgentMessageId(this.sessionId(), idempotencyKey);
		this.workerMail.replyHanded({ messageId, worker: runtime, hop: reply.hop });
		const result = this.ports.followUp(runtime, reply.text, {
			idempotencyKey,
			agentWords: reply.thirdParty ? { turnOrigin: thirdPartyReplyOrigin(reply) } : {},
			...(goal !== undefined ? { delegationObjectiveId: goal } : {}),
		});
		if (result.messageId) {
			const running = result.steering ? this.ports.snapshot().agents[runtime]?.activeAttemptId : undefined;
			if (running !== undefined) this.workerMail.replyJoined(messageId, running);
			return "taken";
		}
		if (result.skipReason?.startsWith("agent_")) {
			this.workerMail.replyDropped(messageId);
			return "ended";
		}
		throw new Error(`worker ${runtime} did not take it: ${result.skipReason ?? "no reason given"}`);
	}
}
