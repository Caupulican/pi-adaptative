/**
 * The lines the `/bot` and `/team` commands draw from a list or a result: one bot, team or scheduled routine per line
 * of `/bot list`, `/team list` and `/bot schedule list`, and what a group send reports. They are in the words of the
 * active language, and they live here rather than in the controller so a line of text can grow without the command
 * handling that surrounds it growing with it.
 */

import type { PersistentBotView, PersistentTeamRecord } from "../../core/delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import { nextRoutineAt, type RoutineDefinitionView } from "../../core/routines/routine-contract.ts";
import { describeRoutineProgress } from "../../core/routines/routine-progress.ts";
import { boundedLine } from "../../core/util/bounded-line.ts";
import { routineScheduleLabel } from "./chat-routines.ts";
import { REMOTE_MARK } from "./components/bot-state-mark.ts";

/** The bots this session knows, one line each: its id, its roles, its state, its model and what waits for it. */
export function formatBotList(bots: readonly PersistentBotView[]): string {
	const words = interfaceText().botTeam;
	if (bots.length === 0) return words.noBots;
	return bots
		.map((bot) => {
			const unread = (bot.unreadCount ?? 0) > 0 ? words.unread(bot.unreadCount ?? 0) : "";
			const scheduled = (bot.routineCount ?? 0) > 0 ? ` · ⏱${bot.routineCount}` : "";
			const role = `${bot.leader ? words.leaderMark : ""}${bot.remote ? words.remoteMark(REMOTE_MARK) : ""}`;
			return `${bot.agentId}${role} · ${interfaceText().common.botState(bot.state)} · ${bot.modelRef}${unread}${scheduled}`;
		})
		.join("\n");
}

/**
 * The line a group send reports. A delivery that failed reached nobody: it is counted apart, never as a member the
 * message was sent to.
 */
export function formatTeamSend(teamId: string, deliveries: readonly { readonly outcome: string }[]): string {
	const failed = deliveries.filter((delivery) => delivery.outcome === "failed").length;
	return interfaceText().chat.sentToTeam(teamId, deliveries.length - failed, failed);
}

/** The teams this session knows, one line each: its id, its members and what waits for it. */
export function formatTeamList(teams: readonly PersistentTeamRecord[]): string {
	const words = interfaceText().botTeam;
	if (teams.length === 0) return words.noTeams;
	return teams
		.map((team) => {
			const unread = (team.unreadCount ?? 0) > 0 ? words.unread(team.unreadCount ?? 0) : "";
			return `${team.teamId} · [${team.memberAgentIds.join(", ")}]${unread}`;
		})
		.join("\n");
}

/**
 * The scheduled routines, one line each: what it runs, where, when it runs next, how its last run ended and where it
 * stood. The progress of a run is the same text the routine tool gives the model, so it stays as that tool wrote it.
 */
export function formatRoutineList(routines: readonly RoutineDefinitionView[]): string {
	const words = interfaceText().botTeam;
	if (routines.length === 0) return words.routinesEmpty;
	return routines
		.map((routine) => {
			const target =
				routine.target.kind === "bot"
					? words.targetBot(routine.target.agentId)
					: routine.target.kind === "team"
						? words.targetTeam(routine.target.teamId)
						: words.mainSession;
			const next = nextRoutineAt(routine.schedule, routine.cursor);
			const outcome = routine.lastSummary ? `: ${routine.lastSummary.replace(/\r?\n+/g, " ").slice(0, 100)}` : "";
			const status = routine.lastStatus ? words.lastRun(`${routine.lastStatus}${outcome}`) : "";
			const progress = describeRoutineProgress(routine.progress);
			const stood = progress ? words.stood(boundedLine(progress, 160)) : "";
			const nextAt =
				next !== undefined
					? new Date(next).toISOString()
					: routine.schedule.kind === "event"
						? words.nextOnEvent
						: words.nextComplete;
			return `${routine.routineId} → ${target} · ${routineScheduleLabel(routine)} · ${words.nextRun(nextAt)}${status}${stood} · "${routine.prompt}"`;
		})
		.join("\n");
}
