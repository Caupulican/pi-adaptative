/** The daemon and global settings observed for one operator request. Reading several routines shares one lease probe. */
import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import { routineDaemonState } from "../delegation/bot-team-routine-helpers.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import type { RoutineAwayHostFacts } from "./routine-away-readiness.ts";

export function readRoutineAwayHost(
	deps: Pick<BackgroundLaneControllerDeps, "getSettingsManager" | "getTimers" | "getModelRegistry">,
	store: PersistentBotTeamStore,
	botId?: string,
): RoutineAwayHostFacts {
	const now = deps.getTimers().port("routines").now();
	const settings = deps.getSettingsManager();
	let daemon: RoutineAwayHostFacts["daemon"];
	try {
		daemon = routineDaemonState(store.getStoreFilePath(), now);
	} catch {
		// Status may be requested after a save already committed. A failed lease read cannot undo a save.
		daemon = "unknown";
	}
	return {
		now,
		daemon,
		enabled: settings.getRoutineAwaySettings("global").enabled,
		ciEvents: settings.getProactivitySettings("global").ciEvents,
		autostart: settings.getRoutineAwayAutostart(),
		models: deps.getModelRegistry(),
		...(botId ? { bot: store.getBot(botId) } : {}),
	};
}
