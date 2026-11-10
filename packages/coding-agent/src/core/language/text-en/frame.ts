/**
 * The English words of the always-visible frame: the footer's stats and badges, the working and waiting words, the
 * activity lane's labels, the operator bar's labels and fallback values, and the input's placeholder hints. Leaves that
 * carry a value or an inflection are functions, so each language decides where the value sits and how it agrees.
 */

export const FRAME = {
	footer: {
		/** Shown in place of the model name when no model is selected. */
		noModel: "no model",
		thinkingOff: "thinking off",
		/** The model name and what it is thinking at, on the footer's right edge. */
		withThinking: (model: string, thinking: string) => `${model} • ${thinking}`,
		/** Badge on the model name while the fast tier is on. */
		fastBadge: "[fast]",
		cacheHitRate: (percent: number) => `cache ${percent}%`,
		overLimit: (estimate: string) => `over limit $${estimate}/turn`,
		/** Marks the context window as compacted automatically once it fills. */
		autoCompaction: "(auto)",
		/** The chip that folds the learning systems into one word. */
		learning: "learn",
	},
	working: {
		/** The turn indicator while the harness is working and says nothing more precise. */
		workingMessage: "Working...",
		/** The turn indicator while the model thinks with its thinking block hidden. */
		thinkingMessage: "Thinking...",
		toInterrupt: (keys: string) => `${keys} to interrupt`,
	},
	activity: {
		/** Plan step states, as the lane names them. */
		blocked: "Blocked",
		next: "Next",
		step: "Step",
		completed: (content: string) => `Completed · ${content}`,
		cancelled: (content: string) => `Cancelled · ${content}`,
		needsYou: "Needs you",
		plan: "Plan",
		/** The goal is unfinished and running. */
		goalActive: "active",
		goalAchieved: "Goal achieved",
		goalClosed: "Goal closed",
		/** What a worker row counts as until it produces work of its own. */
		managedAgentQueued: "managed agent queued",
		managedAgentRunning: "managed agent running",
		agentQueued: "agent queued",
		agentRunning: "agent running",
		/** Clock qualifiers inside the timing parenthesis. */
		observed: "observed ",
		oldest: "oldest ",
		waiting: "Waiting",
		working: "Working",
		/** The pulse row's label per state. */
		thinking: "Thinking",
		subagentsWorking: "Subagents working",
		awaitingSubagents: "Awaiting subagents",
		agentsQueued: "Agents queued",
		backgroundWork: "Background work",
		paused: "Paused",
		parent: "Parent ",
		/** The turn row that holds a submission before its first update. */
		preparing: "Preparing",
		stopped: "Stopped",
		awaitingYou: "Awaiting you",
	},
	operator: {
		/** Phase labels; the row draws them in capitals and lowercases them where the value speaks for itself. */
		working: "WORKING",
		livenessFault: "LIVENESS FAULT",
		needsInput: "NEEDS INPUT",
		blocked: "BLOCKED",
		done: "DONE",
		ready: "READY",
		systemOneEvaluating: "S1 EVAL",
		continuing: "CONTINUING",
		retrying: "RETRYING",
		background: "BACKGROUND",
		next: "NEXT",
		route: "ROUTE",
		peer: "PEER",
		systemOne: "S1",
		ci: "CI",
		tokensPerSecond: "TPS",
		task: "TASK",
		cost: "COST",
		block: "BLOCK",
		proof: "PROOF",
		cache: "CACHE",
		context: "CTX",
		/** What a phase says when no live action describes it. */
		livenessValue: "active objective without execution path",
		needsInputValue: "waiting for your input",
		blockedValue: "execution blocked",
		doneValue: "objective completed",
		readyValue: "Ready",
		systemOneEvaluatingValue: "System One evaluating",
		continuingValue: "Continuation armed",
		retryingValue: "Retrying transient failure",
		/** System One, only when it is judging, degraded or holding doubts. Its name stays as it is in every language. */
		systemOneName: "System One",
		systemOneJudging: "judging",
		systemOneUncertain: (count: number) => `${count} uncertain`,
		ciFailed: "CI failed",
		ciRunning: "CI running",
		peerFindings: (count: number) => `${count} peer ${count === 1 ? "finding" : "findings"}`,
		rounds: (count: number) => `${count} ${count === 1 ? "round" : "rounds"}`,
		costRoot: (amount: string) => `root ${amount}`,
		costSub: (amount: string) => `sub ${amount}`,
		costIcm: (amount: string) => `ICM ${amount}`,
		/** The prompt cache has run out. */
		cacheCold: "cold",
	},
	placeholder: {
		/** The first hint; the row cuts from its tail, so the hints that matter most come first. */
		askAnything: "Ask anything",
		shortcuts: (keys: string) => `${keys} shortcuts`,
		commands: "/ commands",
		files: "@ files",
		bash: "! bash",
		interrupt: (keys: string) => `${keys} interrupt`,
		followUp: (keys: string) => `${keys} follow-up`,
		/** Windows Terminal swallows alt+enter, so the follow-up gesture there is typed. */
		followUpWindows: ">> follow-up",
		workArea: (keys: string) => `${keys} work area`,
		botTeam: (badge: string) => `Message ${badge} directly · @bot · /chat root or Alt+A to switch`,
	},
};
