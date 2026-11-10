/**
 * The `/bot daemon status` report, as the lines the chat draws: the lease and its routine counts, what the last daemon
 * said when it ended, the refused routines, the recent reports, and the away service with the channels it serves. The
 * command keeps the dispatch and the wording of a refused start or stop; this module only builds the status text.
 */

import type { AwayChannelStatus } from "../../core/channels/away-channels.ts";
import { describeDaemonBuild, OWN_DAEMON_BUILD } from "../../core/delegation/bot-team-routine-helpers.ts";
import type { PersistentBotDaemonStatus } from "../../core/delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import { type AwayService, describeAwayServiceInspection } from "../../core/routines/away-service.ts";

/** The session state a daemon status report shows: the away service and the channels it serves while no session is open. */
export interface BotDaemonStatusPort {
	readonly backgroundLanes?: {
		getAwayService(): AwayService;
		readAwayChannelStatus(): readonly AwayChannelStatus[];
	};
}

/** One line per fact the status holds, newest reports last. */
export function describeBotDaemonStatusLines(status: PersistentBotDaemonStatus, port: BotDaemonStatusPort): string[] {
	const words = interfaceText().botTeam;
	const counts = words.daemonCounts(status.activeRoutines, status.dueRoutines);
	const legacyNote = status.legacy ? words.daemonLegacy(status.legacy.pid) : "";
	const endNote =
		!status.running && status.lastEnd ? words.daemonEnd(status.lastEnd.reason, status.lastEnd.detail) : "";
	const lines = [
		status.running
			? `${words.daemonRunning(status.pid, describeDaemonBuild(status.build, OWN_DAEMON_BUILD, interfaceText().chat), counts)}${legacyNote}`
			: `${words.daemonStopped(counts)}${endNote}${legacyNote}`,
		...status.awayRefusals.map((refusal) => words.daemonRefused(refusal.routineId, refusal.reason)),
		...status.reports.slice(-5).map((report) => `${new Date(report.at).toISOString()} ${report.message}`),
	];
	const awayService = port.backgroundLanes?.getAwayService();
	if (awayService) lines.push(describeAwayServiceInspection(awayService.inspect()));
	for (const channel of port.backgroundLanes?.readAwayChannelStatus() ?? [])
		lines.push(words.channelServed(channel.name, channel.cwd, channel.servedBy, channel.awayDrafts));
	return lines;
}
