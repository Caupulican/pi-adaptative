/**
 * The English words of the queue and the external editor: what waits behind the current turn and where it will be
 * delivered, what a send-now did to it, and what the terminal says while the owner edits the buffer in another program.
 */

export const QUEUE = {
	/** The lane row that counts what waits, then the parts that say where each part goes. */
	queued: (total: number, details: string) => `Queued ${total} · ${details}`,
	steering: (count: number, onePerTurn: boolean) =>
		onePerTurn && count > 1 ? `${count} steering → one per model turn` : `${count} steering → next model turn`,
	followUp: (count: number) => `${count} follow-up → after this run`,
	commands: (count: number) => `${count} command${count > 1 ? "s" : ""} → after this run`,
	sendNow: "enter send now",
	editHint: (keys: string) => `${keys} edit`,

	/** Sending the queue before the turn ends on its own. */
	interrupting: (count: number) => `Interrupting to send ${count} queued message${count > 1 ? "s" : ""} now`,
	sendNowFailed: (detail: string, withImages: boolean) =>
		`Send now failed: ${detail}. The queued input is back in the editor${withImages ? " with its images" : ""}.`,
	interruptFailed: (detail: string) => `Interrupt failed: ${detail}`,
	/** Restoring the queue into the editor by hand. */
	messagesStayQueued: "Messages remain queued until their images can be read",
	nothingToRestore: "No queued messages to restore",
	restored: (count: number) => `Restored ${count} queued message${count > 1 ? "s" : ""} to editor`,
	/** A queue that waits for the compaction that is running. */
	compactionInProgress: "Compaction in progress; queued messages are sent when it ends",

	queuedForAfterCompaction: "Queued message for after compaction",

	/** What a compaction does with an input it could not send, and what it says. */
	compactionFailedAfterAccepted: (detail: string) => `A queued message failed after it was accepted: ${detail}`,
	compactionFailedBackInQueue: (detail: string) => `A queued message failed; it is back in the queue: ${detail}`,
	compactionFailedToSend: (count: number, detail: string) =>
		`Failed to send ${count} queued message${count === 1 ? "" : "s"}; ${count === 1 ? "it is" : "they are"} back in the queue: ${detail}`,

	/** The buffer handed to $VISUAL or $EDITOR, and the way back into the interface. */
	launching: (command: string) => `Launching external editor: ${command}\nPi will resume when the editor exits.\n`,
	noEditor: "No editor configured. Set $VISUAL or $EDITOR environment variable.",
	setEditorVariable: "Please set the $EDITOR or $VISUAL environment variable to edit inline.",
	launchFailedFallback: (name: string) => `\nError: Failed to launch fallback editor "${name}".\n`,
	launchFailed: (name: string) => `\nError: Failed to launch editor "${name}".\n`,
	absolutePath: (path: string) => `Absolute file path: ${path}\n\nPress Enter to return to Pi...`,
};
