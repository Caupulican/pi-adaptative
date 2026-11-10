/**
 * The English words of the session autonomy report that `/status` draws: the title of each block, one line per fact,
 * the words a routine's state and a machine's transitions read as, and the sentence that says why a goal's automatic
 * continuation is stopped. Nothing here is read by a model. Leaves that carry a value, a count or an inflection are
 * functions, so each language places the value and agrees with it in its own way.
 */

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
	readonly servedBy: string;
	readonly awayDrafts: number;
}

/** A channel's journal entry: what it served, what it spent and what waits in it. */
export interface AutonomyChannelJournal {
	readonly name: string;
	readonly servedBy: string;
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
	readonly state: string;
	readonly reason?: string;
	readonly spent?: string;
	readonly max?: string;
}

/** The authority a run holds and what may reach a third party. */
export interface AutonomyAuthorityLine {
	readonly run: string;
	readonly edgeMode: string;
	readonly thirdParty: string;
}

export const AUTONOMY_STATUS = {
	/** The report's first line, with the moment the status was taken. */
	head: (at: string) => `Autonomy status at ${at}`,
	/** The title of every block the report can hold. */
	blocks: {
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
	},
	/** What a block whose source could not be read says, and one that has nothing to report. */
	unavailable: (reason: string) => `unavailable: ${reason}`,
	none: "none",
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
		intake: (state: string, reason: string | undefined) =>
			`intake: ${state}${reason === undefined ? "" : ` (${reason})`}`,
		/** A routine's state, keyed by the identifier the record holds. */
		state: {
			enabled: "enabled",
			paused: "paused",
			"paused-after-failures": "paused after repeated failures",
			ended: "ended",
		},
		line: (line: AutonomyRoutineLine) =>
			`${line.routineId}: ${line.state}${line.ended === undefined ? "" : ` (${line.ended})`}, ${line.schedule}, next ${line.next}${line.startsFrom === undefined ? "" : ` (starts from ${line.startsFrom})`}, last ${line.lastStatus}${line.awayRefusal === undefined ? "" : `, away refused: ${line.awayRefusal}`}${line.pause ?? ""}${line.progress === undefined ? "" : `; where it stood: ${line.progress}`}`,
		pausedAfterFailures: (after: number, reason: string | undefined) =>
			`; paused after ${after} failed runs${reason === undefined ? "" : `: ${reason}`}`,
	},

	awayDaemon: {
		state: (state: AutonomyAwayState) =>
			`${state.running ? "running" : "not running"}${state.pid === undefined ? "" : ` (pid ${state.pid})`}${state.running ? `, ${state.build}` : ""}, heartbeat ${state.heartbeat}, ${state.activeRoutines} active, ${state.dueRoutines} due`,
		settings: (settings: AutonomyAwaySettings) =>
			`away ${settings.enabled ? "on" : "off"}: spent $${settings.spent} of $${settings.maxPerDay} (24 h), $${settings.maxPerRun} per run, ${settings.maxParentHosts} parent hosts (this session's settings; the daemon reads global settings)`,
		parentsHosted: (hosted: string) => `parents hosted: ${hosted}`,
		service: (inspection: string | undefined, reason: string | undefined) =>
			inspection ?? `always-on service: unavailable: ${reason}`,
		lastEnd: (reason: string, detail: string | undefined) =>
			`last end: ${reason}${detail === undefined ? "" : `: ${detail}`}`,
		refusedAway: (routineId: string, reason: string) => `${routineId} refused away: ${reason}`,
		channel: (channel: AutonomyAwayChannel) =>
			`channel ${channel.name} away in ${channel.cwd}: served by ${channel.servedBy}, ${channel.awayDrafts} draft(s) written while no session was open wait for the next session (channel_reply)`,
	},

	hostEvents: {
		source: (source: string, state: string, reason: string | undefined) =>
			`source ${source}: ${state}${reason === undefined ? "" : ` (${reason})`}`,
		ledger: (sources: number, subscriptions: number, pending: number, reserved: number) =>
			`ledger: ${sources} sources, ${subscriptions} subscriptions, ${pending} pending and ${reserved} reserved deliveries`,
		ledgerUnavailable: (reason: string) => `ledger: unavailable: ${reason}`,
		githubInterests: (value: string) => `GitHub interests: ${value}`,
	},

	actingAhead: {
		state: (enabled: boolean, attempts: string, spend: string) =>
			`${enabled ? "on" : "off"}: attempts ${attempts}, spend ${spend} (24 h)`,
		episode: (episode: string, phase: string) => `${episode}: ${phase}`,
		patch: (episode: string, present: boolean, ageMinutes: number) =>
			`patch ${episode}: ${present ? "saved" : "gone"}, ${ageMinutes} min old`,
	},

	proactiveReview: {
		state: (line: AutonomyProactiveLine) =>
			`${line.enabled ? "on" : "off"} (${line.delivery}): turn wakes ${line.turnWakes}, review spend ${line.reviewSpend} (24 h)${line.lastSkip === undefined ? "" : `, last skip: ${line.lastSkip}`}`,
		setAside: (until: string, label: string) => `set aside until ${until}: ${label}`,
	},

	channels: {
		channel: (name: string, state: string, detail: string | undefined) =>
			`${name}: ${state}${detail === undefined ? "" : ` (${detail})`}`,
		journalUnavailable: (reason: string) => `wakes, spend, drafts: unavailable: ${reason}`,
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
		grant: (grantClass: string, source: string) => `standing grant ${grantClass} (${source})`,
	},

	systemOne: {
		noEngine: (cause: string) => `no engine: ${cause}`,
	},

	machines: {
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
