/**
 * Live supervision of a bot's own session, as a worker's attempt is supervised: one observation per tool call a turn
 * executes (`ProgressObservationWindow`), judged by the same coordinator and supervisor (`createSupervision`), with the
 * session's own turn as the levers. A steer reaches the running turn at its next model step ("queue"), or interrupts it
 * and opens the next turn on the directive ("now"); a stop ends the turn. A verdict that settles after its turn ended is
 * stale and applies nothing. The host feeds the session's events in (`observe`) and stops it when the session closes.
 */
import * as path from "node:path";
import type { AgentMessage } from "../../kernel/index.ts";
import type { AgentSession } from "../agent-session.ts";
import { createSupervision } from "../agent-session-composition.ts";
import type { AgentSessionEvent } from "../agent-session-contracts.ts";
import type { WorkerRole } from "../orchestration/contracts.ts";
import { assistantOutputTail, ProgressObservationWindow } from "../supervision/progress-observation-window.ts";
import type { WorkerSupervisionCoordinator } from "../supervision/worker-supervision-coordinator.ts";

/** A supervision directive delivered into a bot session's turn: System One's words, never the owner's. */
export const BOT_SUPERVISION_STEER_CUSTOM_TYPE = "pi_bot_supervision_steer";

const NO_ISSUES: ReadonlySet<string> = new Set();

type SupervisedSession = Pick<
	AgentSession,
	| "sessionId"
	| "messages"
	| "isStreaming"
	| "steeringPlane"
	| "operatorProjection"
	| "getDecisionLedger"
	| "sendCustomMessage"
	| "abort"
>;

export interface BotTurnSupervisionOptions {
	readonly agentId: string;
	/** What the bot's turns are for, as a worker's role says it: a bot that writes builds, one that reads explores. */
	readonly role: WorkerRole;
	readonly cwd: string;
	warn(message: string): void;
}

interface SupervisedTurn {
	readonly attemptId: string;
	readonly startedAt: number;
	/** Where the turn's own messages begin: its output is judged, never an earlier turn's. */
	readonly transcriptStart: number;
	/** The words that opened the turn (the owner's message, a wake), set by its first input. */
	mission: string;
	readonly window: ProgressObservationWindow;
	readonly changedFiles: Set<string>;
	readonly argsByCall: Map<string, unknown>;
	readonly ended: AbortController;
}

/** The words of an input message, whichever shape its content has. */
function inputText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "custom") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

export class BotTurnSupervision {
	private readonly session: SupervisedSession;
	private readonly options: BotTurnSupervisionOptions;
	private readonly coordinator: WorkerSupervisionCoordinator;
	private turn: SupervisedTurn | undefined;
	private turns = 0;

	constructor(session: SupervisedSession, options: BotTurnSupervisionOptions) {
		this.session = session;
		this.options = options;
		this.coordinator = createSupervision({
			sessionManager: { getSessionId: () => session.sessionId },
			cwd: options.cwd,
			getSteeringPlane: () => session.steeringPlane,
			control: {
				steerWorker: (_agentId, directive, delivery) => this.steer(directive, delivery ?? "queue"),
				cancelWorker: (_agentId) => session.abort("system one stopped the turn"),
			},
			emit: (event) => {
				if (event.type === "warning") options.warn(event.message);
			},
			getOperatorProjection: () => session.operatorProjection,
			getDecisionLedger: () => session.getDecisionLedger(),
			isAttemptLive: (attemptId) => this.turn?.attemptId === attemptId,
		});
	}

	/** One event of the bot's session: a turn opens and ends, and each tool call it executes is observed. */
	observe(event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.turn = {
				attemptId: `bot-turn:${this.session.sessionId}:${++this.turns}`,
				startedAt: Date.now(),
				transcriptStart: this.session.messages.length,
				mission: "",
				window: new ProgressObservationWindow(0),
				changedFiles: new Set(),
				argsByCall: new Map(),
				ended: new AbortController(),
			};
			return;
		}
		const turn = this.turn;
		if (!turn) return;
		if (event.type === "message_start" && turn.mission.length === 0) turn.mission = inputText(event.message).trim();
		else if (event.type === "tool_execution_start") turn.argsByCall.set(event.toolCallId, event.args);
		else if (event.type === "tool_execution_end")
			this.observeCall(turn, event.toolCallId, event.toolName, event.isError);
		else if (event.type === "agent_end" && !event.willRetry) this.endTurn();
	}

	/** The session closes: the turn in flight ends and no verdict on it applies. */
	stop(): void {
		this.endTurn();
	}

	private endTurn(): void {
		this.turn?.ended.abort();
		this.turn = undefined;
	}

	private observeCall(turn: SupervisedTurn, toolCallId: string, toolName: string, isError: boolean): void {
		const args = turn.argsByCall.get(toolCallId);
		turn.argsByCall.delete(toolCallId);
		const target =
			!isError && (toolName === "write" || toolName === "edit") && args && typeof args === "object"
				? (args as Record<string, unknown>).path
				: undefined;
		if (typeof target === "string" && target.length > 0)
			turn.changedFiles.add(path.relative(this.options.cwd, path.resolve(this.options.cwd, target)));
		const facts = turn.window.record({ name: toolName, args, isError }, turn.changedFiles, NO_ISSUES);
		const observation = {
			agentId: this.options.agentId,
			objectiveId: `bot:${this.options.agentId}`,
			taskId: `bot-session:${this.session.sessionId}`,
			attemptId: turn.attemptId,
			role: this.options.role,
			mission: turn.mission,
			elapsedMs: Date.now() - turn.startedAt,
			outputTail: assistantOutputTail(this.session.messages.slice(turn.transcriptStart)),
			...facts,
		};
		// Supervision runs beside the turn, never in front of it, and never fails it.
		void this.coordinator.observe(observation, turn.ended.signal).catch(() => undefined);
	}

	private async steer(directive: string, delivery: "queue" | "now"): Promise<void> {
		const message = { customType: BOT_SUPERVISION_STEER_CUSTOM_TYPE, content: directive, display: true };
		if (delivery === "now" && this.session.isStreaming) {
			// Interrupt, then open the next turn on the directive, as a worker is interrupted and resumed on it.
			await this.session.abort("system one redirected the turn");
			await this.session.sendCustomMessage(message, { triggerTurn: true });
			return;
		}
		await this.session.sendCustomMessage(message, { deliverAs: "steer" });
	}
}
