/**
 * The English words the interactive mode keeps for itself: the approval choices an edge request offers, the start-up
 * hints, the status lines it writes under the input, the confirmations it asks, the commands it answers, and the rows it
 * puts in the activity lane. Choices carry their label here and their identifier in the code, so a translated label
 * never changes what the mode decides.
 */

import type { NestedCallPurpose } from "../../tools/nested-tool-call.ts";

export const INTERACTIVE = {
	/** The three answers an ungranted edge operation offers; the code compares the identifier, never the label. */
	allowOnce: "Allow once",
	allowForSession: "Allow for this session",
	deny: "Deny",
	edgeTitle: (edgeClass: string, operation: string, reason: string) => `Edge · ${edgeClass}\n${operation}\n${reason}`,
	/** A held operation as the operator reads it: a watch's check names the watch and the call that arms it first. */
	edgeOperation: ({ operation, purpose }: { operation: string; purpose?: NestedCallPurpose }) =>
		purpose
			? `The check watch "${purpose.watchId}" would run, armed by a ${purpose.parentToolName} call: ${operation}`
			: operation,

	/** The hints under the logo, the first line of help, and the model scope the start says once. */
	startup: {
		toInterrupt: "to interrupt",
		toClear: "to clear",
		toExit: "to exit",
		toExitEmpty: "to exit (empty)",
		toSuspend: "to suspend",
		toDeleteToEnd: "to delete to end",
		toCycleThinking: "to cycle thinking level",
		toCycleModels: "to cycle models",
		toSelectModel: "to select model",
		toExpandTools: "to expand tools",
		toLoadHistory: "to load session history",
		toInspectAgents: "to inspect goal, plan, and agents",
		toViewTranscript: "to view transcript",
		toExpandThinking: "to expand thinking",
		forExternalEditor: "for external editor",
		forCommands: "for commands",
		toRunBash: "to run bash",
		toRunBashNoContext: "to run bash (no context)",
		toQueueFollowUp: "to queue follow-up",
		prefixFollowUp: "prefix to queue follow-up",
		toEditQueued: "to edit all queued messages",
		toRecallQueued: "(empty editor) to recall queued messages",
		toPasteImage: "to paste image",
		toAttach: "to attach",
		/** The gesture, not a key: what the owner does with the files themselves. */
		dropFiles: "drop files",
		/** The words of the one-line hint row, once the full list is folded away. */
		compact: {
			interrupt: "interrupt",
			clearExit: "clear/exit",
			commands: "commands",
			bash: "bash",
			expandTools: "expand tools",
		},
		fullHelp: (expandToolsKeys: string, _historyKeys?: string) => `Press ${expandToolsKeys} for full startup help.`,
		onboarding: "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
		modelScope: (models: string, cycleHint: string) => `Model scope: ${models}${cycleHint}`,
		cycleHint: (keys: string) => ` (${keys} to cycle)`,
	},

	/** The lines the mode writes under the input after an action, a switch or a cut-down history. */
	forked: "Forked to new session",
	navigated: "Navigated to selected point",
	sessionCompacted: (count: number) => `Session compacted ${count === 1 ? "1 time" : `${count} times`}`,
	thinkingLevel: (level: string) => `Thinking level: ${level}`,
	thinkingLevelName: (level: string): string => level,
	thinkingUnsupported: "Current model does not support thinking",
	switchedTo: (model: string, level: string | undefined) =>
		level ? `Switched to ${model} (thinking: ${level})` : `Switched to ${model}`,
	thinkingBlocks: (hidden: boolean) => `Thinking blocks: ${hidden ? "hidden" : "visible"}`,
	onlyOneModelInScope: "Only one model in scope",
	onlyOneModelAvailable: "Only one model available",
	historyHiddenForTyping: (keys: string) =>
		`History hidden for typing performance. Press ${keys} to load session history.`,
	olderHistoryHidden: (components: number) =>
		`Older TUI history hidden to preserve FPS (${components} components). Full session remains available to the model.`,
	historyWindow: (lines: number, omitted: number) =>
		`Showing last ~${lines} TUI history lines; omitted ${omitted} older message${omitted === 1 ? "" : "s"}. Full session remains available to the model.`,
	imagesBlocked:
		"The selected model does not accept image input. Switch to an image-capable model or route this inspection to a vision worker.",

	/** What the mode asks before it acts. */
	sessionCwdTitle: "Session cwd not found",
	sessionCwdPrompt: (sessionCwd: string, fallbackCwd: string) =>
		`cwd from session file does not exist\n${sessionCwd}\n\ncontinue in current cwd\n${fallbackCwd}`,
	yes: "Yes",
	no: "No",
	/** The provider that refused a continuation, and the two answers the owner has. */
	continuationTitle: (provider: string) => `${provider} blocked this request`,
	continuationLabel: "Continue",
	continuationDescription: "Send the suggested follow-up as your next message",
	stopLabel: "Stop",
	stopDescription: "Leave the turn as it ended",

	/** Why the self-modification source cannot be used, when the settings screen asks. */
	selfModificationNoSource: "Self modification is enabled, but no pi-adaptative source path is set.",
	selfModificationSourceMissing: (path: string) => `Self modification source path does not exist: ${path}`,
	selfModificationNoPackageJson: (path: string) => `Self modification source path has no package.json: ${path}`,
	selfModificationNotPiAdaptative: (path: string) =>
		`Self modification source path does not look like pi-adaptative (missing packages/coding-agent): ${path}`,

	/** What the mode's own commands answer. A command name, its argument and its usage line stay as they are typed. */
	toolProbeRunning: "Running tool probe...",
	toolRuleRemoved: (mode: string, model: string) => `Removed tool repair rule ${mode} for ${model}.`,
	toolRuleMissing: (mode: string, model: string) => `No tool repair rule ${mode} found for ${model}.`,
	toolRuleUsage: "Usage: /toolrule-remove <provider/model> <mode>",
	protocolReset: (model: string) => `Reset text tool protocol calibration for ${model}.`,
	protocolMissing: (model: string) => `No text tool protocol calibration found for ${model}.`,
	protocolUsage: "Usage: /toolprotocol-reset <provider/model>",
	foregroundBusy: (command: string, interruptKeys: string) =>
		`/${command} requires the foreground to be idle. ${interruptKeys} interrupts it; your command stays in the editor.`,
	bashAlreadyRunning: "A bash command is already running. Press Esc to cancel it first.",

	/** The activity lane rows this mode owns. */
	/** A memory pass that holds the turn until its summaries are built. */
	memorySummariesWaiting: (built: number, needed: number, failed: number) =>
		`waiting for memory summaries (${built} of ${needed} leaves built${failed > 0 ? `, ${failed} failed` : ""})`,
	routing: "Routing",
	turnDone: "Done",
	turnFailed: "Turn failed",
	retryResumed: "Retry resumed",
	retryFailedRow: "Retry failed",
	/** How long a provider wait lasted. */
	waitedFor: (seconds: number) => `after ${seconds}s`,
	/** Why a request is waiting, and the reset time when the provider named one. */
	requestWaiting: (lane: string, provider: string, why: string) => `${lane} request waiting: ${provider} ${why}`,
	waitRateLimited: (resetsIn: string) => `rate-limited${resetsIn}`,
	waitOutOfQuota: (resetsIn: string) => `out of quota${resetsIn}`,
	waitResetsIn: (seconds: number) => `, resets in ${seconds}s`,
	emergencyStopEngaged: "emergency stop engaged",
	waitInFlightLimit: "at its in-flight limit",
	/** A provider's wait for admission, by how it ended; `after` is the elapsed time as the lane writes it. */
	admitted: (provider: string, after: string) => `${provider} admitted ${after}`,
	admittedAtBudget: (provider: string, after: string) => `${provider} admitted at its wait budget ${after}`,
	refusedEmergencyStop: (provider: string, after: string) =>
		`${provider} refused: emergency stop still engaged ${after}`,
	waitBudgetSpent: (provider: string, after: string) => `${provider} wait budget spent ${after}`,
	waitCancelled: (provider: string, after: string) => `${provider} wait cancelled ${after}`,
	notAdmitted: (provider: string, after: string, cause: string) => `${provider} not admitted ${after}: ${cause}`,
	waitInterrupted: (provider: string, after: string) => `${provider} wait interrupted by a new message ${after}`,
	waitClosed: (provider: string, after: string) => `${provider} wait closed ${after}`,
	/** What the paste key reports when the clipboard or the editor cannot take the text. */
	clipboardEmpty: "Clipboard has no text to paste",
	editorCannotPaste: "This editor cannot take a pasted selection",
};
