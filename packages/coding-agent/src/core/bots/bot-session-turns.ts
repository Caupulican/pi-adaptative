/**
 * The per-turn owners of a loaded bot session, wired on the one turn boundary they all read (`observeSessionTurns`): its
 * spend and outcome (`BotTurnAccounting`), its dollar bound (`boundSessionTurnSpend`), its time bound
 * (`boundSessionTurnTime`), and the supervision of its tool loop (`BotTurnSupervision`). The session's own warnings reach
 * the owner in the bot's chat, and every event that can change what the session is doing is handed to the host
 * (`settle`). The host composes them once per loaded session and ends them all with the returned unsubscribe.
 */

import type { AgentSession } from "../agent-session.ts";
import { boundSessionTurnSpend } from "../cost/session-turn-spend-bound.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { WorkerRole } from "../orchestration/contracts.ts";
import { observeSessionTurns } from "../session-turn-boundary.ts";
import { boundSessionTurnTime } from "../session-turn-time-bound.ts";
import type { TimerPort } from "../util/timer-port.ts";
import type { BotTurnAccounting } from "./bot-turn-report.ts";
import { BotTurnSupervision } from "./bot-turn-supervision.ts";

/** One turn's dollar bound, with the bound that sets it: the owner's worker bound, the main session's, or the bot's profile's. */
export interface BotTurnSpendBound {
	readonly usd: number;
	readonly bound: "worker" | "session" | "profile";
}

/** What the per-turn owners read from, and tell, the bot's host. */
export interface BotSessionTurnPorts {
	readonly agentId: string;
	/** What the bot's turns are for, as a worker's role says it: its tool loop is supervised for that role. */
	readonly role: WorkerRole;
	readonly cwd: string;
	/** The host's timers: the time bound arms its alarm on them. */
	readonly timers: TimerPort;
	/** The dollars one turn may spend now, with the bound that sets it; undefined when nothing bounds it. */
	spendBound(): BotTurnSpendBound | undefined;
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
	const unsubscribeSpend = boundSessionTurnSpend(session, {
		limit: () => ports.spendBound(),
		onExceeded: (spentUsd, limit) => {
			const reason = words().botTurnOverBudget(agentId, spentUsd.toFixed(2), limit.usd.toFixed(2), limit.bound);
			ports.notify(reason);
			return reason;
		},
	});
	// A turn is bounded in time as a worker's run is, by the owner's workerDelegation.maxWallClockMs as it is now.
	const unsubscribeTime = boundSessionTurnTime(session, ports.timers, {
		limitMs: () => ports.maxWallClockMs(),
		onExceeded: (limitMs) => {
			const reason = words().botTurnOverTime(agentId, String(Math.ceil(limitMs / 1000)));
			ports.notify(reason);
			return reason;
		},
	});
	// Its tool loop is supervised as a worker's is: churn and System One's progress judgment, over its own turn.
	const supervision = new BotTurnSupervision(session, {
		agentId,
		role: ports.role,
		cwd: ports.cwd,
		warn: (message) => ports.notify(words().botWarning(agentId, message)),
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
			(event.type === "message_end" && event.message.role === "assistant")
		)
			ports.settle();
	});
	// Its spend and outcome are counted per turn on the boundary its time bound reads.
	const unsubscribeTurns = observeSessionTurns(session, turns);
	const unsubscribeSupervisedTurns = observeSessionTurns(session, supervision);
	return () => {
		unsubscribeTurns();
		unsubscribeSupervisedTurns();
		unsubscribeSpend();
		unsubscribeTime();
		unsubscribeEvents();
		supervision.stop();
	};
}
