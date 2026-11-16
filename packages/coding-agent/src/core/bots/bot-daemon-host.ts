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
 * The bots' turns charge the away spend bound beside the daemon's routines and channels (`awayCharges`): their recorded
 * metered spend, and each metered turn working now at the bound of one run until its spend is recorded.
 */

import type { AuthStorage } from "../auth-storage.ts";
import { realPathIdentity } from "../autonomy/path-scope.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { isMeteredSpend } from "../orchestration/risk-budget.ts";
import { readAwayCharges } from "../routines/away-spend-charges.ts";
import { awaySpendMicros, type RoutineAwayCharge } from "../routines/routine-contract.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { TimerSource } from "../util/timer-port.ts";
import { errorText } from "./bot-error-text.ts";
import { botProcessSources } from "./bot-process-sources.ts";
import { readBotRootHostPlaces } from "./bot-root-hosts.ts";
import { rootlessBotSessionHost } from "./bot-session-registry.ts";

export interface BotDaemonHostInput {
	readonly agentDir: string;
	readonly store: PersistentBotTeamStore;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly timers: TimerSource;
	/** The daemon's global-only settings, reloaded by its tick. */
	readonly settings: SettingsManager;
	report(message: string): void;
}

export interface BotDaemonHost {
	/** What is charged to the away spend bound now besides the routines' runs: channels, bots' charges and turns working. */
	awayCharges(nowMs: number): RoutineAwayCharge[];
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
	const { agentDir, settings, modelRegistry } = input;
	let places = new Set<string>();
	let placesTold: string | undefined;
	let awayOn = settings.getRoutineAwaySettings().enabled;
	const readPlaces = (): Set<string> => {
		try {
			const read = readBotRootHostPlaces(agentDir);
			placesTold = undefined;
			return read;
		} catch (error) {
			// The bots stay where they are until the records read again; said once per cause.
			const told = `Bot hosting: the records of the sessions hosting bots did not read (${errorText(error)}); the bots stay where they are.`;
			if (placesTold !== told) input.report(told);
			placesTold = told;
			return places;
		}
	};
	/** The bots working now other than `except` on a metered model, each at the bound of one run. */
	const working = (except: string | undefined): RoutineAwayCharge[] => {
		const perRun = awaySpendMicros(settings.getRoutineAwaySettings().maxUsdPerRun);
		return host
			.working()
			.filter(({ agentId, model }) => agentId !== except && isMeteredSpend(model, modelRegistry))
			.map(() => ({ micros: perRun }));
	};
	const charges = (nowMs: number, except: string | undefined): RoutineAwayCharge[] => [
		...readAwayCharges(agentDir, settings.getRoutineAwaySettings(), nowMs, input.report),
		...working(except),
	];
	const sources = botProcessSources({
		...input,
		otherAwayCharges: (nowMs, agentId) => charges(nowMs, agentId),
		leavesTo: (cwd) => !awayOn || places.has(realPathIdentity(cwd)),
	});
	await sources.refresh(true);
	places = readPlaces();
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
			places = readPlaces();
			awayOn = settings.getRoutineAwaySettings().enabled;
			host.leaveIdleToRoots();
			if ((awayOn && !wasOn) || [...before].some((place) => !places.has(place))) host.askOwed();
		},
		stop,
	};
}
