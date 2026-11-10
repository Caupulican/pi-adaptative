/**
 * Words more than one surface draws: what a bot's state is called wherever a bot is listed, and the way a team with no
 * members is described. A state is an identifier in the data, so the word the owner reads for it is written here.
 */

/** The owner's word for a bot, by its state. */
const BOT_STATE: Readonly<Record<string, string>> = {
	running: "running",
	queued: "queued",
	awaiting_parent: "awaiting_parent",
	failed: "failed",
	idle: "idle",
	retired: "retired",
	offline: "offline",
};

export const COMMON = {
	noMembers: "no members",
	botState: (state: string) => BOT_STATE[state] ?? state,
	/** A failure whose text nobody wrote: the owner reads this, the code keeps its own message. */
	unknownError: "Unknown error",
};
