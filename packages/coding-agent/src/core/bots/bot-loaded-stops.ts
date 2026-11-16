/**
 * The owner's stops of the bots a host has loaded (`bot-session-host.ts`): the stops waiting for a loaded session taken
 * (`stopLoadedBot`), a take that failed told once per cause and taken again after a backoff until it is, the turn a stop
 * covers ended, and what applying a stop reads (`BotStopPorts`).
 */

import { interfaceText } from "../language/interface-text.ts";
import type { TimerPort, TimerSource } from "../util/timer-port.ts";
import { errorText } from "./bot-error-text.ts";
import { botFailureCause, botFailureText } from "./bot-failure-words.ts";
import type { LinkedSessionNotices } from "./bot-link-notices.ts";
import { BotOpenRetries } from "./bot-open-retry.ts";
import type { BotSessionEntry } from "./bot-session-load.ts";
import { type BotStopPorts, type BotWatchStore, type OwnerStop, STOP_TAKE, stopLoadedBot } from "./bot-stop.ts";

/** What the stops of a host's loaded bots read from the host. */
export interface BotLoadedStopsPorts {
	agentDir(): string;
	timers(): TimerSource;
	/** The clock a failed take is tried again on (the host's idle timers). */
	retryTimers(): TimerPort;
	stopped(): boolean;
	/** Takes the bot's inbox again, whose drain takes its stops first. */
	retry(agentId: string): void;
	warn(message: string): void;
	watches(): BotWatchStore;
	readonly links: LinkedSessionNotices;
	readonly refuseMail: BotStopPorts["refuseMail"];
	/** Whether the loaded session works on a turn or input. */
	busy(entry: BotSessionEntry): boolean;
}

export class BotLoadedStops {
	private readonly ports: BotLoadedStopsPorts;
	/** Bots whose loaded session failed to take the owner's stop: taken again after a backoff until it is. */
	private readonly retries: BotOpenRetries;
	/** The cause last told of a bot's stop that its loaded session could not take (`botFailureCause`): told once per cause. */
	private readonly told = new Map<string, string>();

	constructor(ports: BotLoadedStopsPorts) {
		this.ports = ports;
		this.retries = new BotOpenRetries({
			timers: () => ports.retryTimers(),
			stopped: () => ports.stopped(),
			retry: (agentId) => ports.retry(agentId),
		});
	}

	/**
	 * Takes the owner's stops waiting for the bot whose session `entry` holds (`stopLoadedBot`), with what the stop ended;
	 * a take that failed is told to the owner and tried again later.
	 */
	take(agentId: string, entry: BotSessionEntry): ReturnType<typeof stopLoadedBot> {
		const taken = stopLoadedBot(
			this.ports.agentDir(),
			agentId,
			entry,
			(stop) => this.endTurn(entry, stop),
			this.stopPorts(),
		);
		if (taken.failure === undefined) {
			this.retries.forget(agentId);
			this.told.delete(agentId);
			return taken;
		}
		const cause = botFailureCause(STOP_TAKE, agentId, taken.failure.cause);
		if (this.told.get(agentId) !== cause)
			this.ports.warn(
				interfaceText().botTeam.botStopNotApplied(agentId, botFailureText(agentId, taken.failure.cause)),
			);
		this.told.set(agentId, cause);
		this.retries.arm(agentId, false);
		return taken;
	}

	/**
	 * Aborts the turn the bot's session works on, for the owner's stop `stop`: one recorded late (`scoped`) only when the
	 * turn began by the time it was made (`turnSince`, the wall clock its `at` is on). The words given next wait for its end.
	 */
	endTurn(entry: BotSessionEntry, stop: OwnerStop): void {
		if (!this.ports.busy(entry)) return;
		if (stop.scope.kind === "scoped" && (entry.turnSince === undefined || entry.turnSince > stop.at)) return;
		entry.turnEnding = entry.session
			.abort(interfaceText().botTeam.botTurnAbortReasons.ownerStopped)
			.catch((error: unknown) =>
				this.ports.warn(interfaceText().botTeam.botTurnFailed(entry.agentId, errorText(error))),
			);
	}

	/**
	 * What applying a stop reads: the owner's warnings, the provider admission clock a usage wait is dated on, and what the
	 * owner was told of the work a stop left behind a symbolic link.
	 */
	stopPorts(): BotStopPorts {
		return {
			warn: (message) => this.ports.warn(message),
			now: () => this.ports.timers().port("provider-admission").now(),
			routineClock: this.ports.timers().port("routines"),
			links: this.ports.links,
			watches: () => this.ports.watches(),
			refuseMail: (agentId, origin, reason) => this.ports.refuseMail(agentId, origin, reason),
		};
	}

	/** The host stopped: no failed take is tried again. */
	stop(): void {
		this.retries.stop();
	}
}
