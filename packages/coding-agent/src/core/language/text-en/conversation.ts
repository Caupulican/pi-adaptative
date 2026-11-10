/**
 * The English chrome around the conversation: who signs a message, the line a tool call draws and its hints, the words
 * that cut an output short and reopen it, the summaries a compaction, a branch and a skill leave behind, the one-line
 * activity a background agent or a routine adds to the history, and the transcript pager's header and footer. Leaves
 * that carry a count or a name are functions, so each language decides where the value sits and how it agrees.
 */

export const CONVERSATION = {
	/** Who signs a message: the owner, the root chat, or every member of a team. */
	you: "You",
	brain: "Brain",
	everyone: "everyone",
	/** A message that arrived from another machine, and one that came on a named channel. */
	fromAnotherMachine: (mark: string) => `${mark} Message from another machine`,
	onChannel: (channel: string) => `${channel} message`,
	/** The byline of a reply that a router sent to another model, and the route value beside it. */
	routed: "routed",
	noModelName: "none",
	tierRouted: "routed",
	routeDirect: "direct",
	routeChosenByYou: (model: string) => `chosen by you: ${model}`,
	routeEscalated: (model: string) => `escalated→${model} via model-router`,
	routeHmoe: (tier: string) => `${tier} via model-router/H-MoE`,
	routeSystemOne: (tier: string) => `${tier} via model-router/System One`,
	routeReadOnly: (tier: string) => `${tier}/read-only via model-router`,
	routeRouted: (tier: string) => `${tier} via model-router`,

	/** The root chat's line above a delegation: the action it runs and the target it names. */
	delegateFailed: (action: string) => `Brain · delegate ${action} failed`,
	delegating: (action: string) => `→ delegating (${action}) to`,
	delegated: (action: string) => `→ delegated (${action}) to`,
	/** What the delegation's target is called, by the action that started it. */
	delegatedTarget: (action: string): string =>
		action === "slices" ? "parallel slices" : action === "race" ? "race workers" : "subagent",
	awaitingHandoff: "→ waiting for subagent handoff…",
	goalStarted: "→ goal started:",
	goalCompleted: "→ goal completed",
	requirementSatisfied: (requirement: string) => `→ requirement satisfied${requirement}`,

	/** How long a tool call took. */
	elapsed: "Elapsed",
	took: "Took",
	/** The mark on a call whose arguments the protocol repaired. */
	repairedArguments: "[repaired arguments]",
	/** The note under an output the interface cut for the screen; the whole result stays in the conversation. */
	outputTruncatedForDisplay: (lines: number) =>
		`[output truncated for display: showing ${lines} lines; the full result is retained in the conversation]`,
	toExpand: "to expand",
	toCollapse: "to collapse",
	/** What stands in for an image the inline transcript cannot draw. */
	imagePlaceholder: "[Image — open transcript to view]",

	/** The bash tool's own line: what it runs, how it ended, and where the whole output went. */
	bashRunning: (keys: string) => `Running... (${keys} to cancel)`,
	bashCancelled: "(cancelled)",
	bashExit: (code: number) => `(exit ${code})`,
	bashOutputTruncated: (path: string) => `Output truncated. Full output: ${path}`,
	bashRunningState: "Running",
	bashCancelledState: "Cancelled",
	bashExitState: (code: number | undefined) => (code === undefined ? "exit unknown" : `exit ${code}`),

	/** The line that counts the actions a tool performed, and what failed among them. */
	actionStatus: (pending: number, total: number) =>
		`${pending > 0 ? "Performing" : "Performed"} ${total} ${total === 1 ? "action" : "actions"}`,
	actionFailure: (failed: number) => ` · ${failed} failed`,
	viewTranscript: "to view transcript",

	/** The preview of a call's output: how many lines it has, and the row that opens the rest. */
	lineCount: (lines: number) => `${lines} ${lines === 1 ? "line" : "lines"}`,
	errorCount: (lines: number) => `error · ${lines} ${lines === 1 ? "line" : "lines"}`,
	outputLabel: (lines: number) => `output · ${lines} ${lines === 1 ? "line" : "lines"}`,
	errorLabel: "error",
	diffLabel: (added: number, removed: number) => `diff${added || removed ? `  +${added} −${removed}` : ""}`,
	diffSummary: (added: number, removed: number) => `+${added} −${removed}`,
	moreLines: (hidden: number) => `${hidden} more ${hidden === 1 ? "line" : "lines"} · click to show all`,
	fullResultInTranscript: "… full result in transcript",
	/** What System One concluded, as the preview names it. Its own name stays as it is in every language. */
	systemOne: "System One",
	reasons: "reasons",
	reasonCount: (count: number) => `${count} ${count === 1 ? "reason" : "reasons"}`,

	/** The badge and the hint of a compaction summary, a branch summary and a skill invocation. */
	compactionLabel: "compaction",
	compactedFrom: (tokens: string) => `Compacted from ${tokens} tokens`,
	compactedFromOpen: (tokens: string) => `Compacted from ${tokens} tokens (`,
	branchLabel: "branch",
	branchSummaryTitle: "Branch Summary",
	branchSummaryOpen: "Branch summary (",
	skillLabel: "Skill",
	toExpandParen: " to expand)",

	/** What a background agent or a background task did, counted, with the ids that did it. */
	backgroundActivityUnavailable: (kind: string) =>
		`Background ${kind === "agent" ? "agent" : "task"} activity unavailable`,
	agentNoun: (count: number): string => (count === 1 ? "agent" : "agents"),
	taskNoun: (count: number): string => (count === 1 ? "background task" : "background tasks"),
	activitySucceeded: (count: number, noun: string) => `${count} ${noun} succeeded`,
	activityNeedsVerification: (count: number, noun: string) =>
		`${count} ${noun} ${count === 1 ? "needs verification" : "need verification"}`,
	activityFailed: (count: number, noun: string) => `${count} ${noun} failed`,
	activityCanceled: (count: number, noun: string) => `${count} ${noun} canceled`,

	/** A routine's intake, its end and its result, as the history reads them. */
	scheduledRoutine: (routineId: string) => `Scheduled routine ${routineId}`,
	scheduleOutcome: (refused: boolean, reason: string | undefined) =>
		`${refused ? "Not scheduled" : "Could not schedule"}${reason ? `: ${reason}` : ""}`,
	routineExpired: (routineId: string) => `Routine ${routineId} reached its end time and was removed`,
	routineEnded: (routineId: string) => `Routine ${routineId} met its end and was removed`,
	routineOutcome: (routineId: string, outcome: string) => `Routine ${routineId} ${outcome}`,
	routineOutcomeWithCause: (cause: string, outcome: string) => `${cause} · ${outcome}`,
	routineNothingForYou: "nothing for you",
	/** The outcome word when the record carries none. */
	routineEndedOutcome: "ended",
	routineWaitsForMessage: "waits for your next message",
	routineEarlierSlots: (count: number) => `covers ${count} earlier ${count === 1 ? "slot" : "slots"}`,

	/** A team message cut short; the rest waits in its author's own chat. */
	teamMessageTruncated: (characters: number, speaker: string) =>
		`_+${characters} more characters; open ${speaker}'s own chat for the rest._`,
	/** What a supervision notice becomes in the history. */
	worktreeSyncActivity: "Worktree sync activity",
	processSupervisionActivity: "Process supervision activity",

	/** A model turn that failed, and the one whose promise the harness could not see settled. */
	modelInternalError: "The model turn failed with an internal error. Details are in the log.",
	verificationUnresolved:
		"Verification remains unresolved: this run's own check is still failing. Rerun it, or /verify to see and dismiss it.",
	abortedAfterRetries: (attempts: number) => `Aborted after ${attempts} retry attempt${attempts > 1 ? "s" : ""}`,
	operationAborted: "Operation aborted",
	noResponseReceived: "(No response received from model)",

	/**
	 * The frame around a tool failure's own fields: the code it carries and the sentence the model also reads follow it
	 * untouched, so only this frame is a word the owner reads.
	 */
	notRun: (code: string, diagnostic: string | undefined, next: string | undefined) =>
		`Not run: ${code}${diagnostic ? ` (${diagnostic})` : ""}.${next ? ` ${next}` : ""}`,

	/** The transcript overlay's header and footer. */
	transcriptTitle: "Transcript",
	liveTail: "live tail",
	pagerFooter: (scroll: string, page: string, jump: string, close: string) =>
		` ${scroll} scroll  ·  ${page} page  ·  ${jump} jump  ·  ${close} close`,

	/** The context gauge's word for the phase it is in; a phase with no word shows the bar alone. */
	/** How many times the context has been compacted in this session. */
	cycle: (count: number) => `cycle ${count}`,
	phaseTag: (phase: string) =>
		(
			({
				notice: "NOTICE",
				warning: "WARNING",
				forced: "FORCED",
				compacting: "COMPACTING",
				compacted: "COMPACTED",
				resuming: "RESUMING",
			}) as Readonly<Record<string, string>>
		)[phase] ?? null,
};
