/**
 * The words of `/bot` and `/team`: the usage lines, what each command did, the soul editor, the rosters, the inbox
 * views and acknowledgements, the scheduled routines, and `/bot daemon` with its always-on service. A command and its
 * arguments never change; the prose around them does. The facts a command reads back from core are arguments here, so
 * each language places them itself.
 */

import type { ChannelServedBy } from "../../channels/away-channels.ts";

export const BOT_TEAM = {
	remoteUnavailable: "Remote machines are not available in this session.",
	/** One usage line: the command and its arguments come from the caller, the word before them from here. */
	usage: (line: string) => `Usage: ${line}`,
	/** A rename whose name was too long or too short. */
	usageLength: (line: string) => `Usage: ${line} (a name of 1 to 60 characters).`,
	botUsage:
		"Usage: /bot [list] | /bot new <id> [--write] [model] [soul...] | /bot soul <id> | /bot rename <id> <name...> | /bot lead|unlead <id> (a standing leader; its goals are /lead) | /bot spawner | /bot open <id> | /bot msg|send|steer|queue <id> <text...> | /bot inbox [id] | /bot ack [id|all] | /bot schedule [list|add|rm|run] ... | /bot daemon [status|start|stop|tick|service] | /bot stop <id> | /bot retire <id>",
	teamUsage:
		"Usage: /team [list] | /team create <teamId> <bot1,bot2,...> [description...] | /team members <teamId> <bot1,bot2,...> | /team open <teamId> | /team msg <teamId> <text...> | /team inbox [teamId] | /team ack [teamId|all] | /team schedule [list|add|rm] ... | /team delete <teamId>",
	botMessageUsage: "Usage: /bot msg|send|steer|queue <id> <text...>",
	teamMessageUsage: "Usage: /team msg <teamId> <text...>",
	renameUsage: "/bot rename <id> <name...>",
	scheduleUsage: (kind: "bot" | "team", idKind: "bot" | "team") =>
		`Usage: /${kind} schedule add <routineId> <${idKind}Id> <interval> <prompt...>`,
	daemonUsage: "Usage: /bot daemon [status | start | stop | tick | service [status | install | uninstall]]",
	daemonServiceUsage: "Usage: /bot daemon service [status | install | uninstall]",

	/** A bot or a team an acknowledgement named and the store does not hold. */
	notFound: (kind: "bot" | "team", id: string) => `${kind === "bot" ? "Bot" : "Team"} not found: ${id}.`,

	botCreated: (agentId: string, provider: string, modelId: string) =>
		`Created bot ${agentId} on ${provider}/${modelId} and switched to its live chat.`,
	botNotFound: (agentId: string) => `No bot named ${agentId}. Create it with /bot new ${agentId} <model>.`,
	botNotFoundSoul: (agentId: string) =>
		`No bot named ${agentId}. Create it with /bot new ${agentId} <model> [soul...].`,
	botExists: (agentId: string) => `${agentId} already exists.`,
	spawnerReady: (agentId: string) =>
		`${agentId} is ready. The orchestrator can hand it the making of many bots at once; it creates them and briefs each.`,
	leaderOn: (agentId: string) =>
		`${agentId} is now a standing leader: it can create bots, and other bots ask it or the orchestrator for one. It takes effect from the bot's next worker start. Its goals, handed to it by the orchestrator, are shown and overridden with /lead, not here.`,
	leaderOff: (agentId: string) =>
		`${agentId} is no longer a standing leader. It takes effect from the bot's next worker start. A goal it already leads keeps running: /lead shows it, and /lead cancel ${agentId} stops it.`,
	botRenamed: (agentId: string, name: string) =>
		`${agentId} is now shown as ${name}. Address it as @${agentId} as before.`,
	botRetired: (agentId: string) => `Bot ${agentId} retired.`,
	botMissing: (agentId: string) => `Bot ${agentId} does not exist.`,
	/** A retire that named a delegate worker's id: a worker is not a bot, and `delegate` is what stops it. */
	notABotWorker: (agentId: string) =>
		`${agentId} is a delegate worker, not a bot, so it cannot be retired here; cancel it with the delegate tool (cancel ${agentId}).`,
	botLeadsOpenGoal: (agentId: string) =>
		`Bot ${agentId} leads an open goal; cancel it first (/lead cancel ${agentId}).`,
	botHasActiveWork: (agentId: string) =>
		`Bot ${agentId} still has active team or direct work; run /bot stop ${agentId} first.`,
	/** `bots`: the ids of the bots it owns that were stopped with it. */
	botStopped: (agentId: string, bots: readonly string[], mode: string) =>
		`Stopped ${agentId}${bots.length === 0 ? "" : ` and its ${bots.length === 1 ? "bot" : "bots"} ${bots.join(", ")}`} (${mode}).`,
	botStoppedOwn: (agentId: string, bots: readonly string[]) =>
		`Stopped ${agentId}'s ${bots.length === 1 ? "bot" : "bots"} ${bots.join(", ")}; ${agentId} itself was not running.`,
	botIdle: (agentId: string) => `${agentId} is not running.`,
	/** How an interrupt stopped a bot: the code keeps its identity, the owner reads the word. */
	stopMode: (mode: "halt" | "suspend"): string => (mode === "halt" ? "halt" : "suspend"),

	soulEditorTitle: (agentId: string) => `Edit soul of bot ${agentId}`,
	soulCancelled: "Soul edit cancelled.",
	soulUnchanged: (agentId: string) => `Soul of ${agentId} unchanged.`,
	soulSaved: (agentId: string, characters: number) =>
		`Soul of ${agentId} saved (${characters} characters). It opens the bot's system prompt from its next worker start.`,
	soulCleared: (agentId: string) => `Soul of ${agentId} cleared.`,

	teamCreated: (teamId: string, members: string) =>
		`Created team ${teamId} [${members}] and switched to its live chat.`,
	teamDeleted: (teamId: string) => `Deleted team ${teamId}.`,
	teamNotFound: (teamId: string) => `Team not found: ${teamId}.`,
	teamNotFoundCreate: (teamId: string) =>
		`No team named ${teamId}. Create it with /team create ${teamId} <bot1,bot2>.`,
	teamNotFoundSchedule: (teamId: string) => `Team not found: ${teamId}. Create it first with /team create.`,
	/** `members` is the list of ids, or absent for a team left with none. */
	teamMembers: (teamId: string, members: string | undefined) => `Team ${teamId} members: ${members ?? "none"}.`,
	noTeams: "No teams. Create one with /team create <teamId> <bot1,bot2,...>.",

	noBots: "No bots. Create one with /bot new <id> [--write] [model] [soul...].",
	botStoreUnavailable: "Bot store is unavailable in this session.",
	teamStoreUnavailable: "Team store is unavailable in this session.",
	storeUnavailable: "Store is unavailable in this session.",
	/** After a bot row: the count of messages it has not read, and the roles it holds. */
	unread: (count: number) => ` · ${count} unread`,
	leaderMark: " · leader",
	remoteMark: (mark: string) => ` · ${mark} remote`,

	inboxEmptyBot: (agentId: string) => `Inbox for bot ${agentId} is empty.`,
	inboxEmptyTeam: (teamId: string) => `Inbox for team ${teamId} is empty.`,
	inboxBot: (agentId: string, lines: string) => `Inbox for bot ${agentId}:\n${lines}`,
	inboxTeam: (teamId: string, lines: string) => `Inbox for team ${teamId}:\n${lines}`,
	inboxOverview: (rows: string) => `Bot & Team Inboxes:\n${rows}`,
	inboxesCaughtUp: "All bot and team inboxes are caught up.",
	inboxBotRow: (agentId: string, unread: number, summary: string) => `bot:${agentId} (${unread} unread): ${summary}`,
	inboxTeamRow: (teamId: string, unread: number) => `team:${teamId} (${unread} unread)`,
	noSummary: "no summary",
	inboxAcknowledged: (kind: "bot" | "team", id: string) => `Acknowledged inbox for ${kind} ${id}.`,
	inboxAcknowledgedAll: (count: number) => `Acknowledged ${count} inbox(es).`,

	routinesEmpty: "No scheduled routines. Add one with /bot schedule add <routineId> <botId> <interval> <prompt...>.",
	targetBot: (agentId: string) => `bot:${agentId}`,
	targetTeam: (teamId: string) => `team:${teamId}`,
	mainSession: "main session",
	nextOnEvent: "on event",
	nextComplete: "complete",
	nextRun: (when: string) => `next=${when}`,
	lastRun: (status: string) => ` · last=${status}`,
	stood: (progress: string) => ` · where it stood: ${progress}`,
	routineDeleted: (routineId: string) => `Deleted scheduled routine ${routineId}.`,
	routineNotFound: (routineId: string) => `Routine not found: ${routineId}.`,
	routinesDispatched: (dispatched: string, failures: string) => `Routines dispatched: ${dispatched}${failures}.`,
	routinesDispatchedFailures: (failed: string) => ` · failed: ${failed}`,
	none: "none",
	routineTickUnavailable: "Routine scheduler tick unavailable.",
	routineScheduledBot: (routineId: string, agentId: string, schedule: string) =>
		`Scheduled routine ${routineId} for bot ${agentId} ${schedule}.`,
	routineScheduledTeam: (routineId: string, teamId: string, schedule: string) =>
		`Scheduled routine ${routineId} for team ${teamId} ${schedule}.`,

	daemonStatusUnavailable: "Daemon status unavailable.",
	/** The two counts the daemon's status line carries, and the notes that follow it. */
	daemonCounts: (active: number, due: number) => `${active} active routines, ${due} due`,
	daemonRunning: (pid: number | undefined, build: string, counts: string) =>
		`Detached bot daemon running (${pid === undefined ? "" : `pid ${pid}, `}${build}, ${counts}).`,
	daemonStopped: (counts: string) => `Detached bot daemon stopped (${counts}).`,
	daemonLegacy: (pid: number | undefined) =>
		` An older build's daemon${pid === undefined ? "" : ` (pid ${pid})`} is still running; it can no longer write the store.`,
	daemonEnd: (reason: "released" | "signal" | "failed", detail: string | undefined) =>
		` It last ended ${
			reason === "released"
				? "when a session stopped it"
				: reason === "signal"
					? "when its process was stopped"
					: `on an error${detail ? `: ${detail}` : ""}`
		}.`,
	daemonRefused: (routineId: string, reason: string) => `Routine ${routineId} was not run away: ${reason}`,
	channelServed: (name: string, cwd: string, servedBy: ChannelServedBy, drafts: number) =>
		`Channel ${name} is served by the daemon in ${cwd} while no session is open (now: ${servedBy}); ${drafts} reply draft(s) it wrote wait for the next session (channel_reply).`,
	awayServiceUnavailable: "The always-on service is unavailable in this session.",
	daemonStartUnavailable: "Detached bot daemon start unavailable.",
	daemonStopUnavailable: "Detached bot daemon stop unavailable.",
	/** What a launch of the detached daemon did: a report, a diagnostic and the screen all word these facts. */
	daemonLaunchUnavailable: "Detached bot daemon unavailable: this host has no stable pi launch target.",
	daemonLaunchStarting: (pid: number | undefined, build: string) =>
		`Detached bot daemon is already starting (${pid === undefined ? "" : `launched as pid ${pid}, `}${build}).`,
	daemonLaunchRunning: (pid: number | undefined, build: string, activeRoutines: number) =>
		`Detached bot daemon is already running (pid ${pid ?? "unknown"}, ${build}, ${activeRoutines} active routines).`,
	daemonLaunchSpawnFailed: "Failed to spawn detached bot daemon process.",
	daemonLaunchStarted: (pid: number, storeFilePath: string) =>
		`Started detached bot daemon (pid ${pid}) watching ${storeFilePath} across TUI restarts.`,
	/** The daemon a newer build's claim took the lease from. */
	daemonReplacement: (build: string | undefined, pid: number | undefined, own: string | undefined) =>
		`Replaced the daemon of ${build === undefined ? "an earlier build" : `build ${build}`}${pid === undefined ? "" : ` (pid ${pid})`} with build ${own ?? "unknown"}; it exits on observing the new lease.`,
	/** What a stop of the detached daemon did. */
	daemonStopReleased: (pid: number | undefined) =>
		`Released the detached bot daemon's lease${pid === undefined ? "" : ` (pid ${pid})`}; it exits as soon as it observes the release.`,
	daemonStopNotRunning: (staleReleased: boolean) =>
		`Detached bot daemon is not running${staleReleased ? "; its stale lease was released" : ""}.`,
	/** An earlier build's daemon: what this launch retired, or could not retire. */
	daemonLegacyLeaseReleased: (pid: number | undefined) =>
		`Released an earlier build's daemon lease${pid === undefined ? "" : ` (pid ${pid})`}; it exits on observing the release.`,
	daemonLegacyDaemonStopped: (pids: string) => `Stopped an earlier build's inline-script daemon (pid ${pids}).`,
	daemonLegacyDaemonUnsignalled: (pids: string) =>
		`An earlier build's inline-script daemon (pid ${pids}) could not be signalled; it is sealed out of the store.`,
	daemonLegacyDaemonSealedOut: (pid: number, provable: boolean) =>
		`An earlier build's inline-script daemon (pid ${pid}) is still running; its identity was not proven${provable ? "" : " (no identity probe on this host)"}, so it was not signalled. It is sealed out of the store and idles until it is killed, the user logs out or the host restarts.`,
	tickDispatched: (dispatched: string) => `Daemon/routine tick dispatched: ${dispatched}.`,
	tickUnavailable: "Routine tick unavailable.",
	/** What a launch did, worded for the owner: the launch reports the facts, never the sentence. */
	serviceLeaseHeld: (pid: number | undefined, renewed: string | undefined) =>
		`Routine lease: held${pid === undefined ? "" : ` by pid ${pid}`}${renewed === undefined ? ", starting" : `, renewed ${renewed} ago`}.`,
	serviceLeaseFree: "Routine lease: no daemon holds it.",
	serviceSystemd: (unitFileState: string, activeState: string, subState: string) =>
		`systemd: ${unitFileState}, ${activeState} (${subState}).`,
	serviceSystemdFailed: (result: string, exitStatus: string, unit: string) =>
		`the service failed (${result}, exit status ${exitStatus}); \`journalctl --user -u ${unit}\` shows its output.`,
	serviceSystemdInactive:
		"the service's daemon exited normally: another daemon held the lease, a session of a newer build replaced it, or `/bot daemon stop` released it. It starts again at the next login or service start.",
	serviceSystemdSilent: (answer: string) => `systemd did not answer: ${answer}.`,
	serviceLaunchd: (state: string, lastExit: string | undefined) =>
		`launchd: loaded, ${state}${lastExit === undefined ? "" : `, last exit ${lastExit}`}.`,
	serviceLaunchdUnloaded: "launchd: the agent is not loaded; it loads at the next login.",
	serviceLaunchdIdle:
		"the agent's daemon is not running: another daemon held the lease, a session of a newer build replaced it, `/bot daemon stop` released it, or it failed (its last exit says which).",
	serviceTaskRegistered: "Task Scheduler: the task is registered; it launches the daemon at logon and exits.",
	serviceTaskMissing: (answer: string) => `Task Scheduler: the task is not registered (${answer}).`,
	serviceTaskIdle:
		"the task launches the daemon only at logon; a session start or `/bot daemon start` launches it now.",
	serviceWhyNoDaemon: (why: string) => `Why no daemon runs: ${why}`,
	serviceShellCredentials: (names: string) =>
		`A daemon the service starts does not get these variables from this shell: ${names}. Keep those credentials in auth.json for routines away after a reboot.`,
	serviceGhSignIn:
		"gh: a daemon the service starts uses gh's own stored sign-in; without one, event routines that need GitHub wait for their session.",
	serviceRestartFailed: (reason: string) => `The always-on service was not restarted: ${reason}`,
	serviceRestartNoLease: (build: string | undefined, seconds: number) =>
		`The always-on service restarted, but no daemon of build ${build ?? "unknown"} or newer held the routine lease within ${seconds} s.`,
	serviceRestarted: (build: string | undefined) =>
		`The always-on service restarted; its daemon holds the routine lease (build ${build ?? "unstamped"}).`,
	serviceNoLease: (path: string, seconds: number) =>
		`Routines away cannot start at login: the service is installed at ${path}, but no daemon held the routine lease within ${seconds} s; \`/bot daemon service status\` shows why.`,
	serviceInstalled: (path: string, pid: number | undefined) =>
		`Always-on routines installed at ${path}; the daemon holds the routine lease${pid === undefined ? "" : ` (pid ${pid})`}.`,
	serviceRemoveFailed: (reason: string) => `The always-on service was not removed: ${reason}`,
	serviceRemoved: (path: string, running: string, problems: string) =>
		`Always-on routines removed (${path}). ${running}${problems === "" ? "" : ` Reported: ${problems}`}`,
	serviceRemovedRunningTask: "A daemon the task launched keeps running until `/bot daemon stop`.",
	serviceRemovedRunningService:
		"A daemon the service ran stops with it; one a session started keeps running until `/bot daemon stop`.",
	serviceRefused: (reason: string) => `Routines away cannot start at login: ${reason}`,
	serviceClosing: "Routines away cannot start at login: this session is closing.",
	serviceNoServiceHere: (reason: string) => `No always-on service applies here: ${reason}`,
};
