/**
 * The per-turn owners of a loaded bot session, wired on the one turn boundary they all read (`observeSessionTurns`): its
 * outcome and its spend's charges (`BotTurnAccounting`, which also charges whenever the session records spawned usage and
 * resumes from its watermark when wired), its dollar bound (`boundSessionTurnSpend`, held by the spend of the request
 * the turn serves, its workers' included: `BotSpendWindows`), its time bound
 * (`boundSessionTurnTime`), and the supervision of its tool loop (`BotTurnSupervision`). The session's own warnings reach
 * the owner in the bot's chat, and every event that can change what the session is doing is handed to the host
 * (`settle`). The host composes them once per loaded session and ends them all with the returned unsubscribe.
 */

import { type AgentMessage, safeErrorMessage } from "../../kernel/types.ts";
import type { AgentSession } from "../agent-session.ts";
import { boundSessionTurnSpend, type SpendExcess } from "../cost/session-turn-spend-bound.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { WorkerRole } from "../orchestration/contracts.ts";
import { observeSessionTurns } from "../session-turn-boundary.ts";
import { boundSessionTurnTime } from "../session-turn-time-bound.ts";
import type { TimerPort } from "../util/timer-port.ts";
import type { BotTurnAccounting } from "./bot-turn-report.ts";
import { BotTurnSupervision } from "./bot-turn-supervision.ts";

/**
 * One dollar ceiling over a bot's spend per request, with the setting that sets it (the owner's worker bound, the main
 * session's, or the bot's profile's): on all of it, or (`meteredOnly`) on the part of it made on metered models, which a
 * subscription's spend never reaches (its limit is its plan's usage windows). A bot's turns are held to every ceiling on
 * metered spend alone (`botSpendCeilingsOn`).
 */
export interface BotSpendCeiling {
	readonly usd: number;
	readonly bound: "worker" | "session" | "profile";
	readonly meteredOnly: boolean;
}

/** What the per-turn owners read from, and tell, the bot's host. */
export interface BotSessionTurnPorts {
	readonly agentId: string;
	/** What the bot's turns are for, as a worker's role says it: its tool loop is supervised for that role. */
	readonly role: WorkerRole;
	readonly cwd: string;
	/** The host's timers: the time bound arms its alarm on them. */
	readonly timers: TimerPort;
	/**
	 * At the start of a turn's first run: the spend of the request its opening input serves (`opening`: the messages the
	 * run opens with, which the transcript may not hold yet), with the turn's own spend so far, past one of its bounds;
	 * undefined within them all. Counts nothing.
	 */
	openingExceeded(opening: readonly AgentMessage[], turnUsd: number): SpendExcess<BotSpendCeiling> | undefined;
	/**
	 * Counts `addedUsd` the turn just spent to the request it serves; returns that request's spend (its workers' included)
	 * past one of its bounds, with that bound, or undefined within them all.
	 */
	exceeded(turnUsd: number, addedUsd: number): SpendExcess<BotSpendCeiling> | undefined;
	/** How long one turn may run now (the owner's `workerDelegation.maxWallClockMs` as it is now). */
	maxWallClockMs(): number | undefined;
	/** Tells the owner in the bot's chat; `mark` false keeps the bot read (an informational notice). */
	notify(text: string, mark?: boolean): void;
	/** An event that can change what the session is doing (a run started or ended, its queue, an answer). */
	settle(): void;
}

/** Wires the per-turn owners of a loaded bot session; returns the unsubscribe, which also ends the supervision. */
export function observeBotSessionTurns(
	session: AgentSession,
	turns: BotTurnAccounting,
	ports: BotSessionTurnPorts,
): () => void {
	const { agentId } = ports;
	const words = () => interfaceText().botTeam;
	// A stopped turn holds the goal it served (`stopSessionTurn`); a hold that does not save is told in the bot's chat.
	const holdFailed = (error: unknown) => ports.notify(words().botWarning(agentId, safeErrorMessage(error)));
	const unsubscribeSpend = boundSessionTurnSpend(session, {
		openingExceeded: (opening, turnUsd) => ports.openingExceeded(opening, turnUsd),
		exceeded: (turnUsd, addedUsd) => ports.exceeded(turnUsd, addedUsd),
		onExceeded: (spentUsd, limit) => {
			const reason = words().botTurnOverBudget(
				agentId,
				spentUsd.toFixed(2),
				limit.usd.toFixed(2),
				limit.bound,
				limit.meteredOnly,
			);
			ports.notify(reason);
			return reason;
		},
		holdFailed,
	});
	// A turn is bounded in time as a worker's run is, by the owner's workerDelegation.maxWallClockMs as it is now.
	const unsubscribeTime = boundSessionTurnTime(session, ports.timers, {
		limitMs: () => ports.maxWallClockMs(),
		onExceeded: (limitMs) => {
			const reason = words().botTurnOverTime(agentId, String(Math.ceil(limitMs / 1000)));
			ports.notify(reason);
			return reason;
		},
		holdFailed,
	});
	// Its tool loop is supervised as a worker's is: churn and System One's progress judgment, over its own turn.
	const supervision = new BotTurnSupervision(session, {
		agentId,
		role: ports.role,
		cwd: ports.cwd,
		warn: (message) => ports.notify(words().botWarning(agentId, message)),
		holdFailed,
	});
	const unsubscribeEvents = session.subscribe((event) => {
		supervision.observe(event);
		// The session's own warnings (a turn a watch started that failed, say) reach the owner in the bot's chat; an
		// informational one marks nothing unread.
		if (event.type === "warning") ports.notify(words().botWarning(agentId, event.message), event.severity !== "info");
		if (
			event.type === "agent_start" ||
			event.type === "agent_end" ||
			event.type === "queue_update" ||
			event.type === "goal_state_changed" ||
			(event.type === "message_end" && event.message.role === "assistant")
		)
			ports.settle();
	});
	// Its outcome is counted per turn on the boundary its time bound reads; its spend is charged at each turn's end and
	// whenever the session records spawned usage, from the watermark a reopen resumes.
	const unsubscribeTurns = observeSessionTurns(session, turns);
	const unsubscribeUsage = session.subscribe((event) => {
		if (event.type === "usage_updated") turns.charge();
	});
	turns.resume();
	const unsubscribeSupervisedTurns = observeSessionTurns(session, supervision);
	return () => {
		unsubscribeTurns();
		unsubscribeUsage();
		unsubscribeSupervisedTurns();
		unsubscribeSpend();
		unsubscribeTime();
		unsubscribeEvents();
		supervision.stop();
	};
}
