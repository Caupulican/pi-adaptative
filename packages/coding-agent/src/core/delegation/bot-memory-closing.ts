/**
 * The words that close a bot's memory block, for the runtime that runs the bot (`BotMemoryRuntime`): each names only what
 * that runtime holds and does. A worker reports at its end and can inspect the root's chat with `zoom`; a bot's own
 * session holds no `zoom` and no team blackboard, and a line from each of its finished turns is added to its blackboard.
 */

/** What runs a bot whose memory block is composed. */
export type BotMemoryRuntime = "worker" | "session";

export function botMemoryClosingWords(runtime: BotMemoryRuntime): string {
	return runtime === "session"
		? "\nRead your memory blackboard for continuity; it is outside your workspace, so you cannot edit it. A line from each of your finished turns is added to it, so say in your answer what should be remembered."
		: "\nRead your memory blackboard and your team blackboards for continuity; they are outside your workspace, so you cannot edit them. Put what should be remembered in your final report. You can also use `zoom` to inspect root <chat> message IDs if needed.";
}
