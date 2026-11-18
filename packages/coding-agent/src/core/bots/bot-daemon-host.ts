/**
 * The bots the detached daemon hosts while no root session takes them: a bot session host with no root
 * (`rootlessBotSessionHost`), on the process's sources (`bot-process-sources.ts`), that opens every bot owed work
 * (waiting messages, watches, its workers, a turn a usage limit stopped) as a root's host does, under the same
 * `host.lock`, so one process hosts a bot at a time. A root session that hosts bots (`bot-root-hosts.ts`) takes over the
 * bots working in its directory: the daemon opens none there, and closes one it hosts once nothing holds it (no turn,
 * input or worker, nothing waiting in its inbox), which the root then opens for what it is still owed; until then the
 * root's messages reach it through its inbox. When a root leaves, the bots it left are asked again. With
 * `routines.away.enabled` off nothing is hosted away: every bot is left to a root.
 *
 * The bots charge the away spend bound beside the daemon's routines and channels (`awayCharges`): their recorded
 * metered spend (each share by its own model, so a subscription bot's metered workers count), and each metered run
 * working now (a metered bot's turns, any bot's metered workers) at the bound of one run until its spend is recorded.
 */

import type { AuthStorage } from "../auth-storage.ts";
import { realPathIdentity } from "../autonomy/path-scope.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { readAwayCharges } from "../routines/away-spend-charges.ts";
import {
	awaySpendMicros,
	type RoutineAwayCharge,
	type RoutineAwayChargesRead,
} from "../routines/routine-away-spend.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { TimerSource } from "../util/timer-port.ts";
import { type BotAwayRunAside, botProcessSources } from "./bot-process-sources.ts";
import { rootlessBotSessionHost } from "./bot-session-registry.ts";

export interface BotDaemonHostInput {
	readonly agentDir: string;
	readonly store: PersistentBotTeamStore;
	/** Root host snapshot shared with the remote listener on this renewal. */
	rootPlaces(): ReadonlySet<string> | undefined;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly timers: TimerSource;
	/** The daemon's global-only settings, reloaded by its tick. */
	readonly settings: SettingsManager;
	report(message: string): void;
}

export interface BotDaemonHost {
	/**
	 * What is charged to the away spend bound now besides the routines' runs: channels, bots' charges and turns working; or
	 * why they do not read (`readAwayCharges`).
	 */
	awayCharges(nowMs: number): RoutineAwayChargesRead;
	/**
	 * After the daemon's settings reload: the bots' settings and System One read again (the account listing too when
	 * `credentials` changed), the roots read again, the idle bots a root takes closed, and every bot asked again when a
	 * root left or away work was turned back on.
	 */
	refresh(credentials: boolean): Promise<void>;
	/** Closes every bot session and gives its lock back. */
	stop(): Promise<void>;
}

/** Starts hosting the bots owed work (see the module comment). */
export async function startBotDaemonHost(input: BotDaemonHostInput): Promise<BotDaemonHost> {
	const { agentDir, settings } = input;
	let places: ReadonlySet<string> = new Set();
	let awayOn = settings.getRoutineAwaySettings().enabled;
	/**
	 * The metered runs of the bots working now (their metered turns and metered workers, a turn and a worker serving one
	 * window as one run), each at the bound of one run, but the run `aside` names (`BotAwayRunAside`).
	 */
	const working = (aside: BotAwayRunAside | undefined): RoutineAwayCharge[] => {
		const perRun = awaySpendMicros(settings.getRoutineAwaySettings().maxUsdPerRun);
		return host.working().flatMap(({ agentId, runs }) => {
			const held = new Set(runs.workers);
			if (runs.turns !== undefined) held.add(runs.turns);
			if (agentId === aside?.agentId) {
				if (aside.runId !== undefined) held.delete(aside.runId);
				else if (runs.turns !== undefined && !runs.workers.has(runs.turns)) held.delete(runs.turns);
			}
			return [...held].map(() => ({ micros: perRun }));
		});
	};
	// What does not read is passed on as it is (no room until it reads); a reset's whole day allowance stays beside the rest.
	const charges = (nowMs: number, aside: BotAwayRunAside | undefined): RoutineAwayChargesRead => {
		const read = readAwayCharges(agentDir, settings.getRoutineAwaySettings(), nowMs, input.report, {
			setsAside: true,
		});
		return "unread" in read ? read : { ...read, charges: [...read.charges, ...working(aside)] };
	};
	const sources = botProcessSources({
		...input,
		otherAwayCharges: (nowMs, aside) => charges(nowMs, aside),
		leavesTo: (cwd) => !awayOn || places.has(realPathIdentity(cwd)),
	});
	await sources.refresh(true);
	places = input.rootPlaces() ?? places;
	const { host, stop } = rootlessBotSessionHost(sources.ports);
	try {
		host.openOwed();
	} catch (error) {
		// A start that did not finish hosts nothing: what it began is closed before the failure is reported.
		await stop();
		throw error;
	}
	return {
		awayCharges: (nowMs) => charges(nowMs, undefined),
		refresh: async (credentials) => {
			await sources.refresh(credentials);
			const before = places;
			const wasOn = awayOn;
			places = input.rootPlaces() ?? places;
			awayOn = settings.getRoutineAwaySettings().enabled;
			host.leaveIdleToRoots();
			if ((awayOn && !wasOn) || [...before].some((place) => !places.has(place))) host.askOwed();
		},
		stop,
	};
}
