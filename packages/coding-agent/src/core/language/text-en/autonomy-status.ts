/**
 * The English words of the session autonomy report that `/status` draws: the title of each block, one line per fact,
 * the words a routine's state, a routine's last run, a channel, a source, an episode, an authority and a machine's state
 * read as, the cause that leaves a section with nothing to report, and the sentence that says why a goal's automatic
 * continuation is stopped. Nothing here is read by a model. A value the report draws is an identifier the domain
 * declares or free text someone else wrote: an identifier keeps its own English form here, so no sentence is written
 * twice, and the other language words it. Leaves that carry a value, a count or an inflection are functions, so each
 * language places the value and agrees with it in its own way.
 */

import type { RoutineStatusItem, StatusUnavailableCause } from "../../autonomy-status/autonomy-status.ts";
import type { ChannelServedBy } from "../../channels/away-channels.ts";
import type { ChannelRuntimeState } from "../../channels/session-channels.ts";
import type { BotDaemonEnd } from "../../delegation/bot-team-routine-helpers.ts";
import type { HostEventConnectionView } from "../../events/host-event-contract.ts";
import type { KnowledgeCollectionInactiveReason, KnowledgeCollectionStatus } from "../../memory/knowledge-collector.ts";
import type { ActAheadPhase } from "../../proactivity/act-ahead-record.ts";
import type { RoutineDefinitionView } from "../../routines/routine-contract.ts";
import type { RoutineIntakeInactiveReason, RoutineIntakeStatus } from "../../routines/routine-intake.ts";
import type { SYSTEM_ONE_NO_ENGINE_CAUSE } from "../../system-one/semantic-plane-health.ts";
import type { TurnAuthority, TurnOriginKind } from "../../turn-origin.ts";

/** The facts a routine's line in the report carries; already-formatted fragments arrive as strings. */
export interface AutonomyRoutineLine {
	readonly routineId: string;
	readonly state: string;
	readonly ended?: string;
	readonly schedule: string;
	readonly next: string;
	readonly startsFrom?: string;
	readonly lastStatus: string;
	readonly awayRefusal?: string;
	/** The pause clause a failed run left behind, when the host paused the routine; it starts with its own separator. */
	readonly pause?: string;
	/**
	 * The clause of the latest run settled because its origin is lost (its result undelivered, or the run unstarted), when the
	 * journal holds one; it starts with its own separator.
	 */
	readonly originLoss?: string;
	readonly progress?: string;
}

/** The away daemon's own line: whether it runs, which build it runs and what it counts. */
export interface AutonomyAwayState {
	readonly running: boolean;
	readonly pid?: number;
	readonly build?: string;
	readonly heartbeat: string;
	readonly activeRoutines: number;
	readonly dueRoutines: number;
}

/** The away settings the report states, with the two amounts already written the language's way. */
export interface AutonomyAwaySettings {
	readonly enabled: boolean;
	readonly spent: string;
	readonly maxPerDay: string;
	readonly maxPerRun: string;
	readonly maxParentHosts: number;
}

/** One channel the away daemon serves. */
export interface AutonomyAwayChannel {
	readonly name: string;
	readonly cwd: string;
	readonly servedBy: ChannelServedBy;
	readonly awayDrafts: number;
}

/** A channel's journal entry: what it served, what it spent and what waits in it. */
export interface AutonomyChannelJournal {
	readonly name: string;
	readonly servedBy: ChannelServedBy;
	readonly wakes: string;
	readonly spend: string;
	readonly ownerSpend?: string;
	readonly ownerFullAuthority?: boolean;
	readonly ownerQuotaUsedPercent?: number;
	readonly pendingMessages: number;
	readonly pendingDrafts: number;
	readonly awayDrafts: number;
	readonly heldTotal: number;
	readonly gaps: number;
}

/** What the acting-ahead block holds for one episode. */
export interface AutonomyRunLine {
	readonly runId: string;
	readonly authority: string;
	readonly authorityChanged?: boolean;
	readonly running: boolean;
	readonly offered: number;
	readonly omitted: number;
	readonly refused: number;
}

/** The proactive review's state and what it spent. */
export interface AutonomyProactiveLine {
	readonly enabled: boolean;
	readonly delivery: string;
	readonly turnWakes: string;
	readonly reviewSpend: string;
	readonly lastSkip?: string;
}

/** The knowledge collection's state and what it spent, the amounts already written the language's way. */
export interface AutonomyCollectionLine {
	readonly state: KnowledgeCollectionStatus["state"];
	readonly reason?: KnowledgeCollectionInactiveReason;
	readonly spent?: string;
	readonly max?: string;
}

/** The authority a run holds and what may reach a third party. */
export interface AutonomyAuthorityLine {
	readonly run: string;
	readonly edgeMode: string;
	readonly thirdParty: string;
}

/** The title of every block the report can hold, keyed by the block: the empty word is chosen by the same key. */
const BLOCKS = {
	goal: "Goal",
	plans: "Plans",
	ownerDecisions: "Owner decisions",
	review: "Review",
	sessionFile: "Session file",
	routines: "Routines",
	awayDaemon: "Away daemon",
	hostEvents: "Host events",
	actingAhead: "Acting ahead",
	proactiveReview: "Proactive review",
	channels: "Channels",
	outwardDrafts: "Outward drafts",
	harnessNotices: "Harness notices",
	knowledgeCollection: "Knowledge collection",
	authority: "Authority",
	systemOne: "System One",
	machines: "Machines",
	recentRuns: "Recent runs",
};

/** A block the report draws; its key chooses the block's title and the word it prints when it has nothing to report. */
export type AutonomyStatusBlockKey = keyof typeof BLOCKS;

export const AUTONOMY_STATUS = {
	/** The report's first line, with the moment the status was taken. */
	head: (at: string) => `Autonomy status at ${at}`,
	/** The title of every block the report can hold. */
	blocks: BLOCKS,
	/** What a block whose source could not be read says: the cause is worded there, and a read that threw gives only its reason. */
	unavailable: (_cause: StatusUnavailableCause | undefined, reason: string) => `unavailable: ${reason}`,
	/** The word a block with nothing to report prints; its key lets that word agree with the block's title. */
	none: (_block: AutonomyStatusBlockKey) => "none",
	/** A count of two numbers, plain and as the two amounts of money it spent. */
	count: {
		plain: (used: string, max: string) => `${used} of ${max}`,
		money: (used: string, max: string) => `$${used} of $${max}`,
	},
	/** A run that holds no authority at all. */
	idle: "idle",
	more: (count: number) => `(${count} more)`,

	goal: {
		line: (text: string, met: number, total: number, status: string) =>
			`Goal "${text}": ${met} of ${total} requirements met, ${status}.`,
		/** The goal's own status identifier, spelled out. */
		status: (status: string) => status.replace(/_/g, " "),
	},
	/** Why a goal's automatic continuation is running, waiting or stopped. */
	autoContinue: {
		no_goal: "There is no goal, so nothing continues on its own.",
		finished: "The goal is finished, so nothing continues on its own.",
		owner_paused: "Automatic continuation is stopped because the goal is paused. Use /goal resume to continue.",
		budget_limit: "Automatic continuation is stopped because the goal used its whole budget.",
		usage_limit: "Automatic continuation is stopped because the model provider's usage limit was reached.",
		owner_answer_needed: "Automatic continuation is stopped: the goal is blocked and needs your decision or answer.",
		waiting_for_worker: "Automatic continuation is waiting for a helper agent to finish.",
		waiting_for_background_task: "Automatic continuation is waiting for a background task to finish.",
		off: "Automatic continuation is turned off, so the goal advances only when you send a message.",
		tools_unavailable: "Automatic continuation cannot run because the goal tools are not available in this session.",
		interrupted:
			"Automatic continuation stopped because you interrupted it. It starts again after your next message.",
		running: "Automatic continuation is working on the goal now.",
		waiting_for_turn: "Automatic continuation is waiting for the current turn to finish.",
		scheduled: "Automatic continuation starts shortly.",
		retrying: "Automatic continuation hit an error and will try again shortly.",
		not_scheduled: "Automatic continuation is not scheduled right now. It starts again after your next message.",
	},

	ownerDecisions: {
		waiting: (count: number) => `${count} waiting on you`,
		item: (what: string, since: string | undefined) => (since === undefined ? what : `${what}, since ${since}`),
	},

	review: {
		waitingOne: "1 finished result arrived since your last message and is waiting for your review.",
		waitingMany: (count: number) =>
			`${count} finished results arrived since your last message and are waiting for your review.`,
		none: "No finished result is waiting for your review.",
		noticeOn: (at: number) => `One notice at ${at} waiting; nothing is ever held.`,
		noticeOff: "The waiting-results notice is off; nothing is ever held.",
	},

	sessionFile: {
		saving: "Saving normally.",
	},

	routines: {
		wakes: (count: string) => `result wakes (24 h): ${count}`,
		intake: (state: RoutineIntakeStatus["state"], reason: RoutineIntakeInactiveReason | undefined) =>
			`intake: ${state}${reason === undefined ? "" : ` (${reason})`}`,
		/** A routine's state, keyed by the identifier the record holds. */
		state: {
			enabled: "enabled",
			paused: "paused",
			"paused-after-failures": "paused after repeated failures",
			ended: "ended",
		},
		/** Why a routine ended, keyed by the identifier the report holds. */
		ended: (reason: NonNullable<RoutineStatusItem["ended"]>): string => reason,
		/** The kind of a routine's schedule, keyed by the identifier the definition holds. */
		schedule: (kind: RoutineStatusItem["schedule"]): string => kind,
		/** The status of a routine's last run, keyed by the identifier the record holds. */
		lastStatus: (status: NonNullable<RoutineDefinitionView["lastStatus"]>): string => status,
		line: (line: AutonomyRoutineLine) =>
			`${line.routineId}: ${line.state}${line.ended === undefined ? "" : ` (${line.ended})`}, ${line.schedule}, next ${line.next}${line.startsFrom === undefined ? "" : ` (starts from ${line.startsFrom})`}, last ${line.lastStatus}${line.awayRefusal === undefined ? "" : `, away refused: ${line.awayRefusal}`}${line.pause ?? ""}${line.originLoss ?? ""}${line.progress === undefined ? "" : `; where it stood: ${line.progress}`}`,
		pausedAfterFailures: (after: number, reason: string | undefined) =>
			`; paused after ${after} failed runs${reason === undefined ? "" : `: ${reason}`}`,
		/**
		 * The latest run settled because its origin is lost: its result not delivered, or the run cancelled before it started;
		 * when, and why (`notices.routineOriginLoss`).
		 */
		originLoss: (run: "undelivered" | "unstarted", at: string, why: string): string =>
			run === "undelivered"
				? `; a result could not be delivered (${at}): ${why}`
				: `; a run was cancelled before it started (${at}): ${why}`,
	},

	awayDaemon: {
		state: (state: AutonomyAwayState) =>
			`${state.running ? "running" : "not running"}${state.pid === undefined ? "" : ` (pid ${state.pid})`}${state.running ? `, ${state.build}` : ""}, heartbeat ${state.heartbeat}, ${state.activeRoutines} active, ${state.dueRoutines} due`,
		settings: (settings: AutonomyAwaySettings) =>
			`away ${settings.enabled ? "on" : "off"}: spent $${settings.spent} of $${settings.maxPerDay} (24 h), $${settings.maxPerRun} per run, ${settings.maxParentHosts} parent hosts (this session's settings; the daemon reads global settings)`,
		parentsHosted: (hosted: string) => `parents hosted: ${hosted}`,
		service: (inspection: string | undefined, unavailable: string) =>
			inspection ?? `always-on service: ${unavailable}`,
		lastEnd: (reason: BotDaemonEnd["reason"], detail: string | undefined) =>
			`last end: ${reason}${detail === undefined ? "" : `: ${detail}`}`,
		refusedAway: (routineId: string, reason: string) => `${routineId} refused away: ${reason}`,
		channel: (channel: AutonomyAwayChannel) =>
			`channel ${channel.name} away in ${channel.cwd}: served by ${channel.servedBy}, ${channel.awayDrafts} draft(s) written while no session was open wait for the next session (channel_reply)`,
	},

	hostEvents: {
		source: (source: string, state: HostEventConnectionView["state"], reason: string | undefined) =>
			`source ${source}: ${state}${reason === undefined ? "" : ` (${reason})`}`,
		ledger: (sources: number, subscriptions: number, pending: number, reserved: number) =>
			`ledger: ${sources} sources, ${subscriptions} subscriptions, ${pending} pending and ${reserved} reserved deliveries`,
		ledgerUnavailable: (unavailable: string) => `ledger: ${unavailable}`,
		githubInterests: (value: string) => `GitHub interests: ${value}`,
	},

	actingAhead: {
		state: (enabled: boolean, attempts: string, spend: string) =>
			`${enabled ? "on" : "off"}: attempts ${attempts}, spend ${spend} (24 h)`,
		episode: (episode: string, phase: ActAheadPhase) => `${episode}: ${phase}`,
		patch: (episode: string, present: boolean, ageMinutes: number) =>
			`patch ${episode}: ${present ? "saved" : "gone"}, ${ageMinutes} min old`,
	},

	proactiveReview: {
		state: (line: AutonomyProactiveLine) =>
			`${line.enabled ? "on" : "off"} (${line.delivery}): turn wakes ${line.turnWakes}, review spend ${line.reviewSpend} (24 h)${line.lastSkip === undefined ? "" : `, last skip: ${line.lastSkip}`}`,
		setAside: (until: string, label: string) => `set aside until ${until}: ${label}`,
	},

	channels: {
		channel: (name: string, state: ChannelRuntimeState, detail: string | undefined) =>
			`${name}: ${state}${detail === undefined ? "" : ` (${detail})`}`,
		journalUnavailable: (unavailable: string) => `wakes, spend, drafts: ${unavailable}`,
		journal: (line: AutonomyChannelJournal) =>
			`${line.name}: served by ${line.servedBy}, wakes ${line.wakes}, spend ${line.spend} (24 h), ${line.ownerSpend === undefined ? "" : `owner spend ${line.ownerSpend} (24 h), `}${line.ownerFullAuthority ? "full owner authority, " : ""}${line.ownerQuotaUsedPercent === undefined ? "" : `subscription at ${Math.round(line.ownerQuotaUsedPercent)}% (dollar bounds lifted), `}${line.pendingMessages} waiting, ${line.pendingDrafts} draft(s) (${line.awayDrafts} written while no session was open), ${line.heldTotal} held, ${line.gaps} gap(s)`,
	},

	outwardDrafts: {
		counts: (pending: number, approved: number, released: number, dismissed: number) =>
			`${pending} pending, ${approved > 0 ? `${approved} approved, ` : ""}${released} released, ${dismissed} dismissed`,
		draft: (toolName: string, classes: string, origin: string, preparedAt: string) =>
			`${toolName} (${classes}) from ${origin}, prepared ${preparedAt}`,
	},

	harnessNotices: {
		counts: (waiting: number, unsaved: number) => `${waiting} wait for the next owner turn, ${unsaved} unsaved`,
		notice: (kind: string, reason: string) => `${kind}: ${reason}`,
	},

	knowledgeCollection: {
		line: (line: AutonomyCollectionLine) =>
			`${line.state}${line.reason === undefined ? "" : ` (${line.reason})`}${line.spent === undefined ? "" : `, spent $${line.spent}${line.max === undefined ? "" : ` of $${line.max}`}`}`,
	},

	authority: {
		line: (line: AutonomyAuthorityLine) =>
			`run: ${line.run}, edge ${line.edgeMode}, third-party classes: ${line.thirdParty === "" ? "none" : line.thirdParty}`,
		/** The authority a run holds, keyed by the identifier the run records. */
		held: (authority: TurnAuthority): string => authority,
		/** Where the run's words came from, keyed by the identifier the turn records. */
		origin: (origin: TurnOriginKind): string => origin,
		grant: (grantClass: string, source: string) => `standing grant ${grantClass} (${source})`,
	},

	systemOne: {
		/** Whether System One can judge here, keyed by the identifier the snapshot holds. */
		state: (state: "on" | "off"): string => state,
		/** The one cause a session without an engine has; its English sentence is the domain's own. */
		noEngine: (cause: typeof SYSTEM_ONE_NO_ENGINE_CAUSE) => `no engine: ${cause}`,
	},

	machines: {
		/** The description a machine's own `describe` map gives its state, worded by the machine's name and state. */
		plain: (_name: string, _state: string, description: string) => description,
		line: (name: string, state: string, illegal: number, last: string | undefined) =>
			`${name}: ${state}, ${illegal} undeclared transition(s)${last ?? ""}`,
		noTransition: "no transition recorded yet",
		lastRecorded: (state: string) => `last recorded ${state}`,
		last: (from: string, to: string, reason: string) => `, last ${from}->${to} ${reason}`,
	},

	recentRuns: {
		line: (line: AutonomyRunLine) =>
			`${line.runId} ${line.authority}${line.authorityChanged ? " (changed)" : ""}${line.running ? " running" : ""}: ${line.offered} tools offered, ${line.omitted} omitted, ${line.refused} refused`,
		leftOut: (decision: string) => `  left out ${decision}`,
		refused: (decision: string) => `  refused ${decision}`,
	},
};
