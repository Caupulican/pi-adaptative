/** Operator view of the daemon that can take a saved routine, and the conditions it would wait for. */
import type { PersistentBotRecord } from "../delegation/persistent-bot-team-store.ts";
import type { RoutineAwayAutostart } from "../settings/settings-schema.ts";
import { type AwayModelSource, awaySavedRoutineRefusal } from "./away-routine-admission.ts";
import { type RoutineDefinitionView, routineEnded } from "./routine-contract.ts";

export interface RoutineAwayHostFacts {
	readonly daemon: "running" | "starting" | "stopped" | "unknown";
	readonly autostart: RoutineAwayAutostart;
	readonly enabled: boolean;
	readonly ciEvents: boolean;
	readonly models?: AwayModelSource;
	readonly now: number;
	/** The bot whose own session evaluates this watch, or the bot directly targeted by a schedule. */
	readonly bot?: PersistentBotRecord;
}

export interface RoutineAwayReadiness {
	readonly state: "eligible" | "waiting" | "inactive";
	readonly reason?: string;
	readonly daemon: RoutineAwayHostFacts["daemon"];
	readonly autostart: RoutineAwayAutostart;
	readonly lastRefusal?: RoutineDefinitionView["awayRefusal"];
}

export function routineAwayReadiness(routine: RoutineDefinitionView, host: RoutineAwayHostFacts): RoutineAwayReadiness {
	const facts = {
		daemon: host.daemon,
		autostart: host.autostart,
		...(routine.awayRefusal ? { lastRefusal: routine.awayRefusal } : {}),
	};
	if (!routine.enabled || routineEnded(routine, host.now) !== undefined)
		return {
			...facts,
			state: "inactive",
			reason: routine.enabled ? "The schedule has ended." : "The schedule is paused.",
		};
	const reason = blockedAway(routine, host);
	if (reason) return { ...facts, state: "waiting", reason };
	return {
		...facts,
		state: "eligible",
		...(routine.target.kind === "bot"
			? {
					reason:
						"Ready for inbox delivery. The bot checks model access and its spend allowance before starting the turn.",
				}
			: {}),
	};
}

function blockedAway(routine: RoutineDefinitionView, host: RoutineAwayHostFacts): string | undefined {
	if (!host.enabled) return "Unattended execution is off in the owner's settings.";
	if (routine.target.kind === "team") return "A root session dispatches group schedules.";
	if (routine.target.kind !== "bot" && host.bot?.profileId)
		return `A root session must open the bot's profile ${host.bot.profileId}.`;
	if (routine.schedule.kind === "event" && routine.schedule.source === "watch") {
		if (!host.bot) return "The session that armed this watch must be open to evaluate it.";
	} else {
		const reason = awaySavedRoutineRefusal(routine, host.models, host.bot);
		if (reason) return reason;
		if (routine.schedule.kind === "event" && !host.ciEvents) return "The event feed is disabled.";
	}
	if (host.daemon !== "running") return `The background daemon is ${host.daemon}.`;
	return undefined;
}

export function describeRoutineAway(readiness: RoutineAwayReadiness): string {
	const reason = readiness.reason ? ` ${readiness.reason}` : "";
	const last = readiness.lastRefusal ? ` Last refusal: ${readiness.lastRefusal.reason}` : "";
	return `Unattended: ${readiness.state}. Daemon: ${readiness.daemon}. Login setting: ${readiness.autostart}.${reason}${last}`;
}
