/**
 * The English words of the session flow and of the session input and output commands: the model, thinking and tree
 * selectors, the session picker, the goal and task commands, the session info block, and `/export`, `/import`, `/share`,
 * `/copy` and `/name`. Leaves that carry a value, a count or a plural are functions, so each language places the value and
 * agrees with it in its own way. A prompt whose answer the code compares keeps the answer as an identifier and supplies
 * its label from here.
 */

/** Where a session's holder runs when it is not on this system: the phrase that places it, and the one that refers back. */
export interface HolderPlace {
	readonly at: string;
	readonly there: string;
}

export const SESSIONS = {
	/** A session another process hosts is refused here: by the daemon as the phone session, or by its bot's host. */
	hosted: {
		phone: (pid: number) =>
			`This is the phone session; the background daemon (pid ${pid}) is hosting it. Stop the daemon to open it here (\`/bot daemon stop\`).`,
		bot: (pid: number) =>
			`This session is a bot's own conversation; its host (pid ${pid}) runs it. Talk to the bot in its chat (\`/bot open <id>\`), or stop that process to open the session here.`,
		/** The host runs elsewhere (`place`: `onMachine` or `otherSystem`): this system cannot see it end. */
		phoneElsewhere: (pid: number, place: HolderPlace) =>
			`This is the phone session; the background daemon ${place.at} (pid ${pid}) is hosting it. Stop it ${place.there} to open the session here; a daemon that ended there without letting go is released when pi ${place.there} opens the session.`,
		botElsewhere: (pid: number, place: HolderPlace) =>
			`This session is a bot's own conversation; its host ${place.at} (pid ${pid}) runs it. Talk to the bot in its chat (\`/bot open <id>\`), or stop that process ${place.there} to open the session here; a host that ended there without letting go is released when pi ${place.there} opens the session.`,
		/** A holder on another machine, named by its hostname or by `otherMachine`. */
		onMachine: (machine: string): HolderPlace => ({ at: `on ${machine}`, there: "on that machine" }),
		/** A holder's machine whose record names no hostname (only a machine id). */
		otherMachine: "another machine",
		/** A holder whose record names this computer's hostname under another machine id (Windows and WSL on one PC). */
		otherSystem: { at: "in another system on this computer", there: "in that system" } satisfies HolderPlace,
	},
	/** A fleet queue file under the name an earlier build gave a session's away runs' was not theirs to adopt. */
	awayFleetQueueSetAside: (path: string) =>
		`A queue file left by an earlier session was set aside, not adopted: ${path}.`,
	/** The record of runs and channel turns away reserved on the away spend bound after their admission (`away-metered-runs.ts`). */
	awayMeteredRuns: {
		/** It did not read (`cause`: an error code, or `invalid`): every run and subscription turn away is charged as reserved until it reads. */
		unreadable: (path: string, cause: string) =>
			`The record of runs and channel turns away reserved on the away spend bound could not be read (${cause}): ${path}. Every run away and every channel turn away on a subscription is charged its full routines.away.maxUsdPerRun until it reads again; it is read again on the next pass.`,
		/** A run away that moved to a metered model could not be reserved, so its metered requests are refused. */
		notWritten: (path: string, cause: string) =>
			`A run away that moved to a metered model could not be reserved on the away spend bound (${cause}): ${path}. Its metered requests are refused.`,
		/** A channel turn away on a subscription could not be reserved before moving to a metered model, so it does not move. */
		turnNotWritten: (channel: string, path: string, cause: string) =>
			`Channel ${channel} away: a turn could not be reserved on the away spend bound to move to a metered model (${cause}): ${path}. It does not move to that model.`,
		/** The channel turns' charges on the away bound did not read (`cause`: an error code or error name): the bound has no room until they read. */
		chargesUnread: (path: string, cause: string) =>
			`The channel turns charged on the away spend bound could not be read (${cause}): ${path}. Until they read, routines.away.maxUsdPerDay has no room: no metered run or channel turn away starts. They are read again at each pass.`,
		/** A channel journal that did not parse was set aside (its reset): its unknown turns charge the whole day bound until `until`, a day after it. */
		journalReset: (path: string, until: string) =>
			`The channel journal ${path} did not parse, so it was set aside (kept beside it for inspection) and a fresh one started. Which turns away it held is unknown, so they are charged as the whole routines.away.maxUsdPerDay until ${until}: no metered run or channel turn away starts before then.`,
		/** The turns a move to a metered model reserves, or the away bound's room, did not read: the session does not move. */
		turnsUnread: (channel: string, cause: string) =>
			`Channel ${channel} away: the turns a move to a metered model reserves on the away spend bound could not be read (${cause}). Its session does not move to a metered model until they read.`,
	},
	/** The startup sweep of old session bundles (`session-bundle-retention.ts`), for the owner's home and the run. */
	retention: {
		/** The owner's session files did not list: which session a bundle belongs to is unknown. */
		ownerFilesUnlisted:
			"Your session files could not be listed, so your old session bundles are not cleaned up until they can (a removal already begun still finishes), and the routine work of deleted sessions is not settled.",
		/** The owner's home's bundles or deletion records did not list. */
		ownerStateUnreadable:
			"The old session bundles of your sessions or their deletion records could not be read, so they are not cleaned up until they can.",
		ownerDeletionRecordsUnreadable: (count: number) =>
			count === 1
				? "1 deletion record of your old session bundles could not be read; its bundle stays until it can."
				: `${count} deletion records of your old session bundles could not be read; their bundles stay until they can.`,
		/**
		 * An unfinished cleanup of the session's stored state was cancelled over what is left of it, `by` its open
		 * (`releasedByOpen`), by work written to it once the cleanup had removed all of it (`releasedByWrite`) or by the
		 * startup cleanup (`releasedByStartup`).
		 */
		interruptedRetentionReleased: (session: string, by: string) =>
			`Session ${session}: ${by} cancelled an unfinished cleanup of its stored state, which may already have removed some or all of its worker and plan state.`,
		releasedByOpen: "opening it",
		releasedByWrite: "work written to it",
		releasedByStartup: "the startup cleanup",
		/**
		 * A process on another machine (or in another system on this computer, `place`) still holds a session whose old
		 * state the cleanup would remove: only pi there can prove it gone.
		 */
		keptElsewhere: (session: string, place: HolderPlace) =>
			`Session ${session}: its old stored state stays while a process ${place.at} holds the session; that hold ends once pi ${place.there} opens the session.`,
		/** A cleanup of one of the owner's sessions cannot finish while a bot's history does not read. */
		removalAwaitsBotHistory: (session: string) =>
			`Session ${session}: its unfinished cleanup waits until every bot's history can be read; opening the session cancels it.`,
		/** Warnings about single homes past the ones shown; each is in the harness log. */
		homeWarningsOmitted: (count: number) =>
			count === 1
				? "1 more warning about cleaning up old session bundles is in the harness log."
				: `${count} more warnings about cleaning up old session bundles are in the harness log.`,
	},
	model: {
		chosen: (modelId: string) => `Model: ${modelId}`,
		defaultChosen: (modelId: string) => `Default model: ${modelId}`,
		noneAvailable: "No models available",
		selectionSaved: "Model selection saved to settings",
		pinned: (current: string, requested: string) =>
			`This session runs only on ${current}; it does not move to ${requested}.`,
	},
	thinking: {
		unsupported: "Current model does not support thinking",
		levelSet: (level: string) => `Thinking level set to ${level}`,
		defaultLevelSet: (level: string) => `Default thinking level set to ${level}`,
		invalid: (value: string, levels: string) => `Invalid thinking level "${value}". Valid levels: ${levels}`,
	},
	tree: {
		noEntries: "No entries in session",
		alreadyHere: "Already at this point",
		/** The prompt that asks whether the branch above the chosen point is summarized. The answers are identifiers. */
		summarizeTitle: "Summarize branch?",
		noSummary: "No summary",
		summarize: "Summarize",
		summarizeCustom: "Summarize with custom prompt",
		customInstructionsTitle: "Custom summarization instructions",
		loader: (interruptKey: string) => `Summarizing branch... (${interruptKey} to cancel)`,
		summarizationCancelled: "Branch summarization cancelled",
		navigationCancelled: "Navigation cancelled",
		navigated: "Navigated to selected point",
	},
	trust: {
		applied: (trusted: boolean) => `Project ${trusted ? "trusted" : "untrusted"}; applied.`,
		saved: (trusted: boolean) =>
			`Saved trust decision: ${trusted ? "trusted" : "untrusted"}. It applies after /reload.`,
	},
	resume: {
		forkNoMessages: "No messages to fork from",
		forked: (name: string) => `Forked to new session: ${name}`,
		forkedUnnamed: "Forked to new session",
		/** The prompt that offers to resume a goal the session was stopped in the middle of. The answers are identifiers. */
		resumeGoalTitle: "Resume stopped goal?",
		resumeGoal: "Resume goal",
		leaveStopped: "Leave stopped",
		goalResumeFailed: (error: string) => `Goal resume failed: ${error}`,
		resumedWithGoal: "Resumed session and goal",
		resumedGoalPreserved: "Resumed session; goal state preserved",
		cancelled: "Resume cancelled",
		resumedWithGoalHere: "Resumed session and goal in current cwd",
		resumedGoalPreservedHere: "Resumed session in current cwd; goal state preserved",
		failed: "Failed to resume session",
	},
	clone: {
		nothing: "Nothing to clone yet",
		cloned: (name: string) => `Cloned to new session: ${name}`,
		clonedUnnamed: "Cloned to new session",
	},
	goal: {
		/** The status block `/goal` prints. The goal's own words and a requirement's own words are never translated. */
		none: "Goal: none",
		/** The past participle that opens a line about a goal the owner just started or replaced. */
		verbStarted: "started",
		verbOverridden: "overridden",
		head: (userGoal: string) => `Goal: ${userGoal}`,
		status: (word: string) => `Status: ${word}`,
		/** The warnings about a goal the owner's message asked for without a goal phrase; `cause` is the reason as reported. */
		intentOutage: (cause: string) =>
			`System One could not judge whether your message sets a goal (${cause}); no goal was started.`,
		intentNotStarted: (cause: string) => `A goal your message asked for was not started: ${cause}`,
		intentNoteFailed: (cause: string) =>
			`A goal was started from your message, but the note telling the agent about it was not delivered: ${cause}`,
		/** The owner's word for a goal status, keyed by the identifier the goal record holds. */
		statusWords: {
			active: "active",
			paused: "paused",
			blocked: "blocked",
			usage_limited: "usage-limited",
			budget_limited: "budget-limited",
			completed: "completed",
			cancelled: "cancelled",
		},
		/**
		 * One sentence per refused goal action. A refused action reports the fact (`goal-refusal.ts`) and takes its words
		 * from here, so the owner's command and the English wording of the same refusal never spell the sentence twice.
		 */
		refusal: {
			noGoal: (action: string) => `No goal exists to ${action}.`,
			pauseNotActive: (status: string) => `The goal is ${status}; only active goals can be paused.`,
			resumeNotResumable: (status: string) =>
				`The goal is ${status}; only paused, blocked, or usage-limited goals can be resumed.`,
			editGoalCancelled: "The goal is cancelled; start a new goal instead.",
			editObjectiveEmpty: "Goal objective must not be empty.",
			editObjectiveTooLong: (limit: number) => `Goal objective must be at most ${limit} characters.`,
			editTokenBudgetInvalid: "Goal token budget must be a positive integer when provided.",
			goalAlreadyEnded: (status: string) => `The goal is already ${status}.`,
			systemStopUnneeded: (status: string) => `The goal is ${status}; no system stop is needed.`,
			systemStopReasonEmpty: "System goal stop requires a reason.",
			clearUnsupported: "This session does not support clearing goals.",
			startGoalIdEmpty: "start requires a non-empty goalId.",
			startObjectiveEmpty: "start requires a non-empty userGoal.",
			startGoalIdTooLong: (limit: number) => `start goalId must be at most ${limit} characters.`,
			startObjectiveTooLong: (limit: number) => `start userGoal must be at most ${limit} characters.`,
			startTokenBudgetInvalid: "start tokenBudget must be a positive integer when provided.",
			/** The status arrives as the identifier the goal record holds, which is how this sentence has always read it. */
			unfinishedGoal: (goalId: string, status: string, newGoalId: string) =>
				`An unfinished goal '${goalId}' already exists (${status}). Complete, clear, or explicitly replace it before starting '${newGoalId}'.`,
			reopenRequirementIdEmpty: "reopen_requirement requires a non-empty requirementId.",
			goalAlreadyCompleted: (goalId: string) => `Goal '${goalId}' is already completed.`,
			goalAlreadyCancelled: (goalId: string) => `Goal '${goalId}' is cancelled; start or override with a new goal.`,
		},
		blockedReason: (reason: string) => `Blocked reason: ${reason}`,
		tokens: (used: number, budget?: number) =>
			budget === undefined ? `Tokens: ${used}` : `Tokens: ${used}/${budget}`,
		requirement: (args: { id: string; status: string; blockedReason?: string }) =>
			`- ${args.id}: ${args.status}${args.blockedReason ? ` — ${args.blockedReason}` : ""}`,
		counts: (args: { open: number; blocked: number; satisfied: number }) =>
			`Requirements: open ${args.open}, blocked ${args.blocked}, satisfied ${args.satisfied}`,
		controls:
			"Controls: /goal edit | /goal pause | /goal resume | /goal reopen <requirement-id> | /goal complete | /goal clear | /goal override <text>",
		failed: (error: string) => `Goal command failed: ${error}`,
		resumed: "Goal resumed.",
		paused: "Goal paused.",
		updated: "Goal updated.",
		completed: "Goal completed manually.",
		cleared: "Goal cleared.",
		nothingToClear: "No goal exists to clear.",
		closed: "Goal closed.",
		editUsage: "Usage: /goal edit <objective>",
		nothingToEdit: "No goal exists to edit.",
		reopenUsage: "Usage: /goal reopen <requirement-id>",
		nothingToUpdate: "No goal exists to update.",
		requirementNotBlocked: (id: string, status: string) =>
			`Requirement '${id}' is ${status}; only blocked requirements can be reopened.`,
		requirementUnknown: (id: string) => `Unknown requirement '${id}'.`,
		requirementReopened: (id: string, resumed: boolean) =>
			`Requirement '${id}' reopened${resumed ? " and goal resumed" : ""}.`,
		overrideUsage: "Usage: /goal override <text>",
		overrideHint: " Use /goal override <text> to replace it explicitly.",
		alreadyContinuing: (verb: string) => `Goal ${verb}: the autonomy loop is already continuing this goal.`,
		disposedBeforeContinuation: (verb: string) =>
			`Goal ${verb}, but the session was disposed before continuation could run.`,
		started: (args: { verb: string; action: string; reason: string }) =>
			`Goal ${args.verb}: ${args.action}, ${args.reason}.`,
		continuationFailed: (error: string) => `Goal continuation failed: ${error}`,
		/** `/goal-continue`. */
		continueStarted: (args: { turns: string; stallTurns: number; wallClock: string }) =>
			`Goal continuation started: ${args.turns}, recovery threshold ${args.stallTurns}, wall-clock limit ${args.wallClock} minute(s).`,
		unboundedTurns: "unbounded turns",
		upToTurns: (turns: number) => `up to ${turns} turn(s)`,
		disabled: "disabled",
		continueStopped: (args: { stopReason: string; turns: number; action: string; reason: string }) =>
			`Goal continuation stopped: ${args.stopReason}; submitted ${args.turns} turn(s); latest decision: ${args.action}, ${args.reason}.`,
	},
	task: {
		retired: (operation: string) =>
			`/task ${operation} is no longer available. Ask Pi to delegate the work instead; workers report back when they finish.`,
	},
	/** A quitting session's work that did not settle within its bounded wait; `seconds` is the bound. */
	closing: {
		runUnsettled: (seconds: number) =>
			`A run did not settle within ${seconds}s of quit; its final message may not have been persisted.`,
		reflectionUnsettled: (seconds: number) =>
			`A reflection turn did not settle within ${seconds}s of quit; its work may not have been persisted.`,
		compactionUnsettled: (seconds: number) =>
			`A compaction did not settle within ${seconds}s of quit; its result is discarded.`,
		ownerGoalJudgmentUnsettled: (seconds: number) =>
			`An owner goal judgment did not settle within ${seconds}s of quit; its usage may be recorded late.`,
		routineIntakeUnsettled: (seconds: number) =>
			`A routine intake pass did not settle within ${seconds}s of quit; its usage may be recorded late.`,
	},
	/** `/session`: the block that opens with the session's own stats. */
	info: {
		title: "Session Info",
		name: "Name:",
		file: "File:",
		inMemory: "In-memory",
		id: "ID:",
		messages: "Messages",
		user: "User:",
		assistant: "Assistant:",
		toolCalls: "Tool Calls:",
		toolResults: "Tool Results:",
		total: "Total:",
		tokens: "Tokens",
		input: "Input:",
		output: "Output:",
		cacheRead: "Cache Read:",
		cacheWrite: "Cache Write:",
		cost: "Cost",
		modelRouter: "Model Router",
	},
	/** `/export`, `/import`, `/share`, `/copy` and `/name`. */
	io: {
		exported: (path: string) => `Session exported to: ${path}`,
		exportFailed: (error: string) => `Failed to export session: ${error}`,
		importUsage: "Usage: /import <path.jsonl>",
		importTitle: "Import session",
		importQuestion: (path: string) => `Replace current session with ${path}?`,
		importCancelled: "Import cancelled",
		imported: (path: string) => `Session imported from: ${path}`,
		importFailed: "Failed to import session",
		ghMissing: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
		ghAuthCheckFailed: (error: string) => `Failed to check GitHub CLI authentication: ${error}`,
		ghNotLoggedIn: "GitHub CLI is not logged in. Run 'gh auth login' first.",
		creatingGist: "Creating gist...",
		shareCancelled: "Share cancelled",
		gistTimedOut: "Timed out while creating gist",
		gistFailed: (stderr: string) => `Failed to create gist${stderr ? `: ${stderr}` : ""}`,
		gistIdUnparsed: "Failed to parse gist ID from gh output",
		shareUrls: (args: { url: string; gistUrl: string }) => `Share URL: ${args.url}\nGist: ${args.gistUrl}`,
		gistCreateFailed: (error: string) => `Failed to create gist: ${error}`,
		nothingToCopy: "No agent messages to copy yet.",
		unknownError: "Unknown error",
		copiedSelection: "Copied selection to clipboard",
		copiedLast: "Copied last agent message to clipboard",
		sessionName: (name: string) => `Session name: ${name}`,
		nameUsage: "Usage: /name <name>",
		sessionNameSet: (name: string) => `Session name set: ${name}`,
	},
};
