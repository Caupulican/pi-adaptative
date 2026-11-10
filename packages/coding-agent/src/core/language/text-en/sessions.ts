/**
 * The English words of the session flow and of the session input and output commands: the model, thinking and tree
 * selectors, the session picker, the goal and task commands, the session info block, and `/export`, `/import`, `/share`,
 * `/copy` and `/name`. Leaves that carry a value, a count or a plural are functions, so each language places the value and
 * agrees with it in its own way. A prompt whose answer the code compares keeps the answer as an identifier and supplies
 * its label from here.
 */

export const SESSIONS = {
	model: {
		chosen: (modelId: string) => `Model: ${modelId}`,
		defaultChosen: (modelId: string) => `Default model: ${modelId}`,
		noneAvailable: "No models available",
		selectionSaved: "Model selection saved to settings",
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
