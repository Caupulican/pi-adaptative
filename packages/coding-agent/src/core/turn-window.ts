import type { AgentMessage } from "../kernel/index.ts";
import type { SessionManager } from "../kernel/node.ts";

/**
 * Where `message` is in `messages`: the same object, or the message a history rebuild materialized from the session
 * entry that holds it (a rebuilt custom message is a new object). The last match; -1 when it is not there.
 */
export function findMessageInHistory(
	sessionManager: Pick<SessionManager, "getMessageEntryId">,
	message: AgentMessage,
	messages: readonly AgentMessage[],
): number {
	const entryId = sessionManager.getMessageEntryId(message);
	return messages.findLastIndex(
		(candidate) =>
			candidate === message || (entryId !== undefined && sessionManager.getMessageEntryId(candidate) === entryId),
	);
}

/**
 * A turn's own messages in the current history, found from the turn's opening message (the first message its run
 * sent) and never from a history length read before the turn: a compaction applied inside the turn rebuilds the
 * history (session-wide outside ICM), so a pre-turn length no longer marks where the turn began.
 *
 * - No compaction inside the turn: everything from the opening on, as the turn appended it. With no compaction the
 *   opening sits at the index the pre-turn length named, so this is the slice that length gave.
 * - A compaction inside the turn: the turn begins at the opening when it survived, else at the first message from the
 *   opening's entry or an entry after it on the active branch (that checkpoint's summary, or a turn entry it kept
 *   before the summary). A rebuild places what it carries forward from before the turn (transient records, restored
 *   gaps) after the summary, so only messages from the turn's entries, or with no entry (not yet persisted), are kept.
 * - The opening never entered the conversation (not in the history and never persisted): the run was closed before it
 *   started, so the turn has no messages of its own. Undefined.
 *
 * Throws when the turn cannot be located: the opening was persisted but neither it nor any message of its turn is in
 * the history, its entry is not on the active branch, or it was never persisted yet a compaction summary follows it.
 * Any other answer would hand the reader earlier conversation, or drop the turn.
 */
export function resolveTurnMessages(
	sessionManager: Pick<SessionManager, "getMessageEntryId" | "getBranch">,
	opening: AgentMessage,
	messages: readonly AgentMessage[],
): AgentMessage[] | undefined {
	const openingIndex = findMessageInHistory(sessionManager, opening, messages);
	if (openingIndex !== -1) {
		const turn = messages.slice(openingIndex);
		if (!turn.some((message) => message.role === "compactionSummary")) return turn;
	}
	const openingEntryId = sessionManager.getMessageEntryId(opening);
	if (openingEntryId === undefined) {
		if (openingIndex === -1) return undefined;
		throw new Error(
			"Turn opening message was never persisted, yet a compaction summary follows it; the turn cannot be located.",
		);
	}
	const branch = sessionManager.getBranch();
	const openingPosition = branch.findLastIndex((entry) => entry.id === openingEntryId);
	if (openingPosition === -1) {
		throw new Error(`Turn opening entry ${openingEntryId} is not on the active branch; the turn cannot be located.`);
	}
	const turnEntryIds = new Set(branch.slice(openingPosition).map((entry) => entry.id));
	const entryIdOf = (message: AgentMessage): string | undefined =>
		message.role === "compactionSummary" ? message.compactionEntryId : sessionManager.getMessageEntryId(message);
	const start =
		openingIndex !== -1
			? openingIndex
			: messages.findIndex((message) => {
					const entryId = entryIdOf(message);
					return entryId !== undefined && turnEntryIds.has(entryId);
				});
	if (start === -1) {
		throw new Error(
			`Turn opening entry ${openingEntryId} is not in the history and no message of its turn is (no compaction summary of the turn replaced it); the turn cannot be located.`,
		);
	}
	return messages.slice(start).filter((message) => {
		const entryId = entryIdOf(message);
		return entryId === undefined || turnEntryIds.has(entryId);
	});
}
