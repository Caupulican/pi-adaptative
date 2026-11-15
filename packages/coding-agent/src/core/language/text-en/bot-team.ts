/**
 * The words of `/bot` and `/team`: the usage lines, what each command did, the soul editor, the rosters, the inbox
 * views and acknowledgements, the scheduled routines, and `/bot daemon` with its always-on service. A command and its
 * arguments never change; the prose around them does. The facts a command reads back from core are arguments here, so
 * each language places them itself.
 */

import type { BotPointerSetAsideReason } from "../../bots/bot-session-pointer.ts";
import type { ChannelServedBy } from "../../channels/away-channels.ts";

/** Why a bot's session pointer did not count, as the sentence that tells it was set aside says it. */
const POINTER_SET_ASIDE: {
	readonly [K in BotPointerSetAsideReason["kind"]]: (reason: Extract<BotPointerSetAsideReason, { kind: K }>) => string;
} = {
	"not-a-pointer": () => "is not a session record",
	"not-a-session": (reason) => `names ${reason.file}, which does not hold a session`,
	"other-session": (reason) => `names ${reason.file}, which holds session ${reason.holds}, not ${reason.sessionId}`,
	deleted: (reason) => `names session ${reason.sessionId}, which was deleted`,
};

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
	/** A bot's own session cannot start: its model is gone or has no credentials. */
	botModelUnavailable: (agentId: string, modelRef: string) =>
		`Bot ${agentId} runs on ${modelRef}, which is not available or has no credentials. Sign in to that provider or change the bot's model, then message it again.`,
	/** A bot made from a profile cannot run as the worker admission compiles that profile now. */
	botProfileRefused: (agentId: string, profileId: string, reason: string) =>
		`Bot ${agentId} was not started: its profile ${profileId} does not admit it now (${reason}). Fix the profile or the worker policy, then message it again.`,
	botModelMoved: (agentId: string, running: string, defined: string) =>
		`Bot ${agentId}: its session is on ${running}, not on ${defined}, the model the bot is defined on, so this run was not started.`,
	/** The bot's own model cannot run now (`cause`: out of quota, refused or unlisted for the account). */
	botModelUnusable: (modelRef: string, cause: string) =>
		`${modelRef} cannot run now (${cause}); the bot runs only on its own model, so message it again when that model is usable or change the bot's model`,
	/** A run of a bot's session built before its record or profile changed what defines it. */
	botSessionOutdated: (agentId: string) =>
		`Bot ${agentId}: what defines its session changed since it was built (its record, its profile, a model pin or the worker policy), so this run was not started on the old one. Its session is rebuilt once it is idle; message it again.`,
	botRunsAsWorker: (agentId: string) =>
		`Bot ${agentId} runs as a worker (a leader, a bot a leader made, or a profile only a worker's run holds), not in a session of its own.`,
	botSettingsNotReread: (reason: string) =>
		`A settings change did not reach the bots' sessions (${reason}); they keep the settings they had until the next change.`,
	/** Why a bot's turn was stopped, as its aborted message keeps it in the bot's conversation. */
	botTurnAbortReasons: {
		sessionClosing: "bot session closing",
		ownerStopped: "bot stopped by the owner",
		systemOneStopped: "System One stopped the turn",
		systemOneRedirected: "System One redirected the turn",
	},
	botSoulRefused: (agentId: string, reason: string) =>
		`Bot ${agentId} was not started: ${reason}. Edit its soul with /bot soul ${agentId}.`,
	/** Another process holds the bot's session: two processes would write one conversation (a message goes to its inbox). */
	botSessionHeld: (agentId: string, pid: number, sessionId?: string) =>
		`Bot ${agentId} is open in another session (${sessionId ? `${sessionId.slice(0, 8)}, ` : ""}process ${pid}).`,
	/** A bot's session did not open: `holders` (each one of the holder words below) keep its host out. */
	botSessionOpenElsewhere: (agentId: string, holders: string) =>
		`bot ${agentId}'s conversation is open in ${holders}; its host opens it once that closes it`,
	botSessionHolderSession: (pid: number) => `a session of yours (process ${pid})`,
	botSessionHolderPhone: (pid: number) => `the phone session's daemon (process ${pid})`,
	botSessionHolderBotHost: (pid: number) => `another bot host (process ${pid})`,
	/** The bot's session pointer, or the session file it loads, is a symbolic link: the load stops until it is replaced. */
	botSessionFileLinked: (path: string) =>
		`the bot session file ${path} is a symbolic link, which bot sessions do not follow (a write would replace the link with a copy); replace the link with the file itself`,
	/** The bot's session state moved into its own home while it was opened, twice: it opens there at the next attempt. */
	botSessionHomeChanged: (agentId: string) =>
		`bot ${agentId}'s session moved into its own home while it was being opened; it opens there at its next message or change`,
	/** The bot's session lease registry (`file`) does not read as one: the session does not open until it is inspected. */
	botSessionLeasesUnreadable: (agentId: string, file: string) =>
		`bot ${agentId}'s session lease registry ${file} does not read as one and needs inspection before the session opens`,
	/** A move of the bot's session state stopped part way and could not be put back: the pieces stand in two homes. */
	botSessionStateSplit: (agentId: string, inBot: string, inOwner: string) =>
		`bot ${agentId}'s session state was moved only in part (in its home: ${inBot}; in the main session's home: ${inOwner || "nothing"}); put the pieces in one home before it opens again`,
	/** Another process kept a file of the bot locked past the wait. */
	botFilesLocked: (agentId: string) =>
		`bot ${agentId}'s files were locked by another process for longer than the wait`,
	/** A watch of the bot changed (another process wrote it) between its read and its change here. */
	botWatchChangedMeanwhile: (agentId: string) => `a watch of bot ${agentId} was changed by another process meanwhile`,
	/** A failure with no words for the owner: its own text goes to the harness log. */
	botFailureUnworded: (agentId: string) =>
		`bot ${agentId} met an unexpected failure; its details are in the harness log`,
	/** A read of the bot's session files failed for a cause that passes on its own. */
	botSessionStoreBusy: (agentId: string) =>
		`bot ${agentId}'s session files were busy or changing while they were read; its host opens it again shortly`,
	botSessionStoreFailing: (agentId: string) =>
		`bot ${agentId}'s session files failed to read (a disk error); its host tries again for a minute, then when a message or a change of the bot asks`,
	botSessionStorePermission: (agentId: string) =>
		`this process may not read bot ${agentId}'s session files (permission denied); its host tries again for a minute, then when a message or a change of the bot asks`,
	/** The bot's inbox holds as many messages as it takes: its host is not taking them. */
	botInboxFull: (agentId: string, max: number) =>
		`Bot ${agentId}: ${max} messages already wait for the session hosting it; send again once it has taken them.`,
	/** A file in the bot's inbox did not read as a message; it was set aside beside itself. */
	botInboxUnreadable: (agentId: string, file: string, reason: string) =>
		`Bot ${agentId}: an inbox message could not be read and was set aside as ${file}.unreadable (${reason}).`,
	/** The owner's stop could not be written to the bot's home: no process takes it, and it is not tried again. */
	botStopNotRecorded: (agentId: string, reason: string) =>
		`Bot ${agentId}: the owner's stop could not be recorded (${reason}); it reaches no other process and is not tried again, so send it again.`,
	/** The periodic listing of the bots failed on this one; the others were listed. */
	botSweepFailed: (agentId: string, reason: string) =>
		`Bot ${agentId}: its inbox and owed work could not be checked (${reason}); they are checked again every minute.`,
	/** The owner's stop of a closed bot left its saved session's work: its pointer or session file is a symbolic link. */
	botStopLinkedSessionLeft: (agentId: string, path: string) =>
		`Bot ${agentId}: the owner's stop was taken, but its saved session's workers, goal and usage-limit wait were left: ${path} is a symbolic link, and work is never ended through one.`,
	/** A stop or a release ended the bot's own work, and the jobs its home's sessions placed could not be ended. */
	botPlacedJobsNotEnded: (agentId: string, reason: string) =>
		`Bot ${agentId}: its own work was ended, but the jobs its home's sessions placed on other machines could not be ended (${reason}).`,
	/** A stop or a release of a bot left the jobs that its home's session files which are symbolic links placed. */
	botLinkedSessionsJobsLeft: (agentId: string, paths: readonly string[]) =>
		`Bot ${agentId}: the jobs placed on other machines by ${paths.join(", ")} were not ended: ${paths.length === 1 ? "it is a symbolic link" : "they are symbolic links"}, and work is never ended through one.`,
	/** The owner's words wait in the bot's inbox for its session, which opens later; `reason` says why, in the owner's words. */
	botWordsWaitForOpen: (agentId: string, reason: string) =>
		`Left in ${agentId}'s inbox: its session opens once it can (${reason}).`,
	/** The owner's words wait in the bot's inbox behind its stop, which could not be taken yet. */
	botWordsWaitBehindStop: (agentId: string) =>
		`Left in ${agentId}'s inbox behind its stop, which could not be applied yet: your words reach the bot once the stop is taken.`,
	/** The owner's stop of a bot hosted here could not be recorded or taken, and ending its workers directly failed too. */
	botStopWorkersNotEnded: (agentId: string, reason: string) =>
		`Bot ${agentId}: the owner's stop could not end its workers (${reason}); they keep running until a stop of it is applied.`,
	/** The owner's stop, applied here without its record, ended the bot's work but could not hold its goal or usage wait. */
	botStopGoalNotHeld: (agentId: string, reason: string) =>
		`Bot ${agentId}: the owner's stop, applied here without its record, ended its turn and workers but could not hold its goal or decline its usage-limit wait (${reason}); its goal may go on by itself until you pause it.`,
	/** The owner's stop could not be applied: it still waits and is tried again, and the work it stops stays held. */
	botStopNotApplied: (agentId: string, reason: string) =>
		`Bot ${agentId}: the owner's stop could not be applied and still waits; the work it stops is held until it is (${reason}).`,
	/** The owner's stop of a closed bot found its saved session's file holding another session, and left the file. */
	botStopSessionFileForeign: (agentId: string, file: string, sessionId: string) =>
		`Bot ${agentId}: the owner's stop ended its workers and the jobs it placed on other machines, but left its goal and its usage-limit wait as they were: ${file} does not hold its session ${sessionId}.`,
	/** What the owner's stop of a bot did not end. */
	botStopLeftLanes: (agentId: string, failed: number, managed: number) =>
		`Bot ${agentId}: the owner's stop did not end ${[
			failed > 0 ? `${failed} worker lane${failed === 1 ? "" : "s"} whose cancel failed` : "",
			managed > 0
				? `${managed} managed lane${managed === 1 ? ", which the extension running it ends" : "s, which the extension running them ends"}`
				: "",
		]
			.filter((part) => part !== "")
			.join(" and ")}.`,
	/** The bot's session refused a message another session sent; the chat shows it with the reason. */
	botInboxRefused: (agentId: string, reason: string) =>
		`Bot ${agentId}: a message sent from another session was not taken (${reason}).`,
	/** The bot's inbox could not be taken. */
	botInboxNotTaken: (agentId: string, reason: string) =>
		`Bot ${agentId}: the messages sent from other sessions could not be taken (${reason}).`,
	/** Why a waiting message was refused when the bot stopped running as a session. */
	botInboxReleased: (agentId: string) =>
		`bot ${agentId} no longer runs as a session of its own (retired, or its messages now go to a worker); send it again`,
	/** A message waiting in the bot's inbox, as the chat shows it. */
	botInboxWaitingLine: (text: string) => `Waiting for the session hosting the bot: ${text}`,
	/** A message the bot's session refused, as the chat shows it. */
	botInboxRefusedLine: (reason: string, text: string) => `Not delivered (${reason}): ${text}`,
	/** The bot works in another process: the owner's stop was written for that session to take. */
	botStopSentElsewhere: (agentId: string, pid: number, sessionId?: string) =>
		`Bot ${agentId} is working in another session (${sessionId ? `${sessionId.slice(0, 8)}, ` : ""}process ${pid}); the stop was sent there and ends its work when that session takes it.`,
	/** The watch over the bot homes failed. */
	botHomesNotWatched: (reason: string) =>
		`Bots of other sessions are no longer watched (${reason}); their changes show when this session reads them.`,
	/** Why the watch over the bot homes ended: their directory was removed. */
	botHomesRemoved: (dir: string) => `${dir} was removed`,
	botMessageRefused: (agentId: string, reason: string) => `Bot ${agentId} did not take the message: ${reason}.`,
	/** The bot's session ended the message's turn before taking it, giving no reason. */
	botMessageNotTaken: (agentId: string) => `Bot ${agentId} did not take the message.`,
	/** A warning of the bot's own session (its turn, its supervision, its close), forwarded as the bot's. */
	botWarning: (agentId: string, message: string) => `Bot ${agentId}: ${message}`,
	botHistoryRunNotRecorded: (agentId: string, reason: string) =>
		`Bot ${agentId}: its run could not be added to its history (${reason}).`,
	botStateNotPublished: (agentId: string, reason: string) =>
		`Bot ${agentId}: its state could not be published for other sessions (${reason}).`,
	botTurnSpendNotRecorded: (agentId: string, reason: string) =>
		`Bot ${agentId}: its turn's spend could not be recorded (${reason}).`,
	/**
	 * The main session's files or directories a read-back of the bot's charges could not read: `named` each with why, and
	 * `more` others.
	 */
	botChargeFilesUnread: (
		agentId: string,
		named: readonly { readonly path: string; readonly reason: string }[],
		more: number,
	) =>
		`Bot ${agentId}: ${named.map(({ path, reason }) => `${path} (${reason})`).join("; ")}${more > 0 ? ` and ${more} more` : ""} could not be read back for its spend charges, so what ${named.length + more === 1 ? "it holds" : "they hold"} may be charged to the main session again.`,
	botChargeMarkNotKept: (agentId: string, reason: string) =>
		`Bot ${agentId}: how far the main session holds its spend could not be marked in its transcript (${reason}); if its spend record is lost, that is read back from the main session's files alone.`,
	botTurnOutcomeNotRecorded: (agentId: string, reason: string) =>
		`Bot ${agentId}: its turn outcome could not be recorded (${reason}).`,
	/** What the bot's session told the owner could not be kept in its chat; the words follow. */
	botNoticeNotRecorded: (agentId: string, text: string, reason: string) =>
		`Bot ${agentId}: a notice could not be kept in its chat (${reason}): ${text}`,
	botNoticeNotMarked: (agentId: string, reason: string) =>
		`Bot ${agentId}: a notice is in its chat, but the roster could not mark it unread (${reason}).`,
	/**
	 * The bot's spend ledger (`bots/<id>/spend.json`) is left as it is and read again with its next spend: it could not be
	 * read, or it does not parse and could not be set aside (`setAsideError`).
	 */
	botSpendLedgerHeld: (agentId: string, reason: string, setAsideError: string | undefined) =>
		`Bot ${agentId}: its spend record ${setAsideError === undefined ? `could not be read (${reason})` : `does not read (${reason}) and could not be set aside (${setAsideError})`}; it is left as it is and tried again with its next spend. Until then, its requests' spend is counted from now and its spend is charged to the main session once it ${setAsideError === undefined ? "reads" : "is set aside"}.`,
	/** The ledger did not parse in full and was set aside; its charge watermark was kept (`chargesKept`) or is recovered from the main session. */
	botSpendLedgerSetAside: (agentId: string, file: string, reason: string, chargesKept: boolean) =>
		`Bot ${agentId}: its spend record did not read in full (${reason}) and was set aside as ${file}; the requests whose spend did not read count from now, and its charges to the main session continue from ${chargesKept ? "its record" : "what the main session has recorded of them"}.`,
	botSessionPointerSetAside: (agentId: string, file: string, reason: BotPointerSetAsideReason) =>
		`Bot ${agentId}: the record of which session it continues ${POINTER_SET_ASIDE[reason.kind](reason as never)} and was set aside as ${file}; it continues its newest session file, or a new session when it has none, recorded anew.`,
	botWatchesNotCounted: (agentId: string, reason: string) =>
		`Bot ${agentId}: its saved session did not read (${reason}); its watches are not counted until it reads.`,
	botSessionStateInBothHomes: (agentId: string, ownerBundle: string) =>
		`Bot ${agentId}: its session's orchestration state is in both its own home and the main session's; it uses its own, and the main session's copy stays unused at ${ownerBundle}.`,
	botSessionStateKeptForWorkers: (agentId: string) =>
		`Bot ${agentId}: its session's orchestration state stays in the main session's home, where its workers recorded their conversations; it keeps using it there.`,
	botSessionStateStillHeld: (agentId: string, pids: string) =>
		`Bot ${agentId}: its session's orchestration state stays in the main session's home, which process ${pids} still holds without keeping the bot out (an away run's host); the bot runs its session there.`,
	botSessionStateNotMoved: (agentId: string) =>
		`Bot ${agentId}: its session's orchestration state could not be moved from the main session's home into its own, which lies on another device; it keeps using it in the main session's home.`,
	botSpendLedgerNotWritten: (agentId: string, reason: string) =>
		`Bot ${agentId}: its spend record could not be written (${reason}); it is written again with its next spend, and its spend is charged once it is.`,
	botNoticeDeliveriesNotKept: (agentId: string, reason: string) =>
		`Bot ${agentId}: the record of the notices its session already told could not be read or written (${reason}); one may be told again.`,
	botNoticeUnreadable: (agentId: string, file: string, reason: string) =>
		`Bot ${agentId}: a notice in its chat could not be read and was set aside as ${file}.unreadable (${reason}).`,
	botHistoryFileUnreadable: (reason: string) => `Bot history: a session file could not be read (${reason}).`,
	botHistoryIndexUnreadable: (agentId: string) =>
		`Bot ${agentId}: its history index cannot be read, so old session bundles are not cleaned up until it is written again.`,
	botHistoryNotIndexed: (reason: string) => `Bot history could not be indexed (${reason}).`,
	/** The startup sweep cannot tell which session a bot home keeps or its live host holds: it only resumes what it already reserved there. */
	botHomeHostStateUnreadable: (botName: string) =>
		`Bot ${botName}: the state of the process hosting it cannot be read, so its old session bundles are not cleaned up until it can.`,
	/** Which session the bot keeps cannot be told: its session pointer does not read, or its newest file changed meanwhile. */
	botHomeCurrentSessionUnknown: (botName: string) =>
		`Bot ${botName}: which session it keeps cannot be told now, so its old session bundles are not cleaned up until it can.`,
	botHomeHostSessionUnnamed: (botName: string) =>
		`Bot ${botName}: the process hosting it has not yet named the session it holds, so its old session bundles are not cleaned up until it does.`,
	/** The startup sweep could not list a bot home's session files or session bundles. */
	botHomeRetentionFailed: (botName: string) =>
		`Bot ${botName}: its session files or old session bundles could not be read, so its old session bundles are not cleaned up until they can.`,
	/** Deletion records of a bot home's old session bundles that do not read; their bundles stay. */
	botDeletionRecordsUnreadable: (botName: string, count: number) =>
		count === 1
			? `Bot ${botName}: 1 deletion record of its old session bundles could not be read; its bundle stays until it can.`
			: `Bot ${botName}: ${count} deletion records of its old session bundles could not be read; their bundles stay until they can.`,
	botHistoryRunUnreadable: (reason: string) => `Bot history: an earlier conversation could not be read (${reason}).`,
	/** The owner's model policy (`isModelAllowed`) refuses the bot's model. */
	botModelNotAllowed: (modelRef: string) => `your model policy does not allow ${modelRef}`,
	/** A bot a root or a leader made runs on an API-key model the owner did not choose while subscription models are usable. */
	botModelMetered: (modelRef: string, alternatives: readonly string[], provider: string) =>
		`${modelRef} is paid by API key and you have not chosen it for workers while subscription models are usable; use a subscription model such as ${alternatives.join(", ")}, or add ${provider} to workerDelegation.routeProviders`,
	/** A message that came while this session was closing and its bots with it. */
	botSessionsClosing: (agentId: string) =>
		`Bot ${agentId} was not started: this session is closing, and its bots close with it. Message it again in the next session.`,
	/** An earlier close the bot's session waits for did not end within its bound. */
	botSessionStillClosing: (agentId: string) =>
		`Bot ${agentId} was not started: an earlier session of it, or the bot sessions of a session that closed in this process, did not finish closing. Message it again in a moment; if this repeats, restart pi.`,
	botTurnFailed: (agentId: string, reason: string) => `Bot ${agentId}: its turn failed (${reason}).`,
	/** The worker admission's rules refused the bot's model for a message. */
	botModelRefused: (agentId: string, reason: string) =>
		`Bot ${agentId} did not take the message: its model is refused (${reason}).`,
	/**
	 * A turn went past the spend bound and was stopped; `bound` names the one that applied (the lowest passed), `metered`
	 * that it holds metered spend only, which `spentUsd` then counts.
	 */
	botTurnOverBudget: (
		agentId: string,
		spentUsd: string,
		limitUsd: string,
		bound: "worker" | "session" | "profile",
		metered: boolean,
	) =>
		`Bot ${agentId}: its turn was stopped at the spend bound ($${spentUsd} spent${metered ? " on metered models" : ""} on this request, its workers included; ${bound === "worker" ? "workerDelegation.maxUsd" : bound === "profile" ? "its profile's cost budget" : "this session's autonomy spend bound"}${metered ? " on metered spend" : ""} is $${limitUsd}).`,
	/** A turn ran past the owner's time bound on a worker's run, and was stopped. */
	botTurnOverTime: (agentId: string, limitSeconds: string) =>
		`Bot ${agentId}: its turn was stopped at the time bound (workerDelegation.maxWallClockMs is ${limitSeconds} s).`,
	/** A bot's release (it was retired or left the session path) failed; its host runs it again until it is done. */
	botReleaseOwed: (agentId: string, reason: string) =>
		`Bot ${agentId}: its session's workers, watches and waiting messages were not all ended yet (${reason}); its host tries again until they are.`,
	/** A change of the bot the host noticed itself (a refused run, an idle session) was not applied. */
	botRecordChangeNotApplied: (agentId: string, reason: string) =>
		`Bot ${agentId}: a change of its definition was not applied to its session yet (${reason}); it applies at its next change or message.`,
	/** Why a closed bot's work is not ended yet: process `pid` holds its host lock (it hosts the bot, or opens or closes it). */
	botReleaseHeldBy: (pid: number) => `process ${pid} holds its session`,
	/** A released bot's workers were not ended: a session file of its home is a symbolic link, which no end of work follows. */
	botReleaseWorkersLeft: (agentId: string, path: string) =>
		`Bot ${agentId} was released, but its saved session's workers and the jobs that session placed on other machines were left: ${path} is a symbolic link, and work is never ended through one.`,
	botSessionCloseFailed: (agentId: string, reason: string) =>
		`Bot ${agentId}: its session did not close cleanly (${reason}).`,
	botSessionNotClosed: "The bot session did not close cleanly.",
	botSessionsNotClosed: "Bot sessions did not close cleanly.",
	/** A bot's session is owed work (watches, waiting messages, its workers, a usage wait) and could not be opened (or read) to take it up. */
	botWatchesNotResumed: (agentId: string, reason: string) =>
		`Bot ${agentId}: its session is owed work (watches, waiting messages, its workers or a turn a usage limit stopped) but could not be opened, so the work waits until it is (${reason}).`,
	/** The bot's session is owed work, and no open root session works where it does. */
	botOwedWorkNoRoot: (agentId: string, directories: string) =>
		`Bot ${agentId}: its session is owed work (watches, waiting messages, its workers or a turn a usage limit stopped), but no open session works in ${directories}, where it works; the work waits until a session opens there.`,
	/** Watches an earlier conversation of the bot armed, cancelled when it continues another (a watch is checked only by its own). */
	botWatchesCancelled: (agentId: string, count: number) =>
		`Bot ${agentId}: ${count} ${count === 1 ? "watch" : "watches"} armed in an earlier conversation of its ${count === 1 ? "was" : "were"} cancelled; it continues its newest conversation, and a watch is checked only by the conversation that armed it.`,
	/** A change of what defines a running bot's session. */
	botChangeWhileRunning: (agentId: string) =>
		`Bot ${agentId} is working: its model, permissions and soul apply to its session when it starts, so stop it first (/bot stop ${agentId}).`,
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
