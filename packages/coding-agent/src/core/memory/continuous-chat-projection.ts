/**
 * Turn-scoped provider projection of the continuous chat. A turn's wire carries the turn view (summaries of the whole
 * chat), the turn's live state, and the turn's own messages; durable history from before the turn is never sent.
 */

import type { TextContent } from "@caupulican/pi-ai";
import type { AgentContextPlanFn } from "../../kernel/loop-config.ts";
import { createCustomMessage } from "../../kernel/messages.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import type { ContinuousChatAudit } from "../extensions/builtin.ts";
import type { IcmTurnHandle } from "./continuous-chat-turn-coordinator.ts";

export const CONTINUOUS_CHAT_VIEW_CUSTOM_TYPE = "continuous_chat_view";
export const CONTINUOUS_CHAT_STATE_CUSTOM_TYPE = "continuous_chat_state";

/** Lines per view block. The cache boundary sits on the last whole block. */
const VIEW_BLOCK_LINES = 4;
const VIEW_CLOSING_TAG = "</chat>";

/** The running turn, with the live state fixed for its whole duration. */
export interface ContinuousChatProjectionSource {
	current(): { handle: IcmTurnHandle; stateText: string } | undefined;
}

/** The turn's live state: its start instant in RFC 3339. Fixed per turn, so every plan of the turn stays current. */
export function renderContinuousChatTurnState(handle: Pick<IcmTurnHandle, "startedAt">): string {
	return `Current time: ${new Date(handle.startedAt).toISOString()}`;
}

/**
 * Splits a `<chat>` view into text blocks of four whole lines. Only the last whole block carries the cache boundary:
 * the closing tag and the partial remainder stay outside it, so the marked prefix is byte-identical while the view
 * grows at its end.
 */
export function renderContinuousChatViewBlocks(view: string): TextContent[] {
	const lines = view.split("\n");
	if (lines.pop() !== VIEW_CLOSING_TAG) throw new TypeError("Continuous-chat view must end with its closing tag.");
	if (lines.shift() !== "<chat>") throw new TypeError("Continuous-chat view must start with its opening tag.");
	const wholeBlocks = Math.floor(lines.length / VIEW_BLOCK_LINES);
	const blocks: TextContent[] = [];
	for (let index = 0; index < wholeBlocks; index++) {
		const start = index * VIEW_BLOCK_LINES;
		const body = lines.slice(start, start + VIEW_BLOCK_LINES).join("\n");
		const block: TextContent = { type: "text", text: index === 0 ? `<chat>\n${body}` : body };
		if (index === wholeBlocks - 1) block.cacheBoundary = true;
		blocks.push(block);
	}
	const remainder = [
		...(wholeBlocks === 0 ? ["<chat>"] : []),
		...lines.slice(wholeBlocks * VIEW_BLOCK_LINES),
		VIEW_CLOSING_TAG,
	];
	blocks.push({ type: "text", text: remainder.join("\n") });
	return blocks;
}

/**
 * Which ICM projection owns the provider wire: the running chat, or the block installed while the chat is unavailable.
 * Absent when no ICM projection is installed, so the session's own history rides the wire.
 */
export type ContinuousChatWire = { kind: "chat" } | { kind: "blocked"; reason: string };

/** Blocks every provider request while ICM is selected but its required chat is unavailable. */
export function createBlockedContinuousChatPlanWrapper(
	reason: string,
): (base: AgentContextPlanFn) => AgentContextPlanFn {
	const message = `ICM project chat is unavailable: ${reason}`;
	return () => async () => {
		throw new Error(message);
	};
}

/**
 * The frame every request of a turn opens with: the turn view, then the turn's live state. Both carry the turn's start
 * instant as their timestamp.
 */
export function continuousChatFrameMessages(
	handle: Pick<IcmTurnHandle, "boundary" | "startedAt">,
	stateText: string,
): AgentMessage[] {
	const timestamp = new Date(handle.startedAt).toISOString();
	return [
		createCustomMessage(
			CONTINUOUS_CHAT_VIEW_CUSTOM_TYPE,
			renderContinuousChatViewBlocks(handle.boundary.view),
			false,
			undefined,
			timestamp,
		),
		createCustomMessage(CONTINUOUS_CHAT_STATE_CUSTOM_TYPE, stateText, false, undefined, timestamp),
	];
}

/**
 * Where the running turn's own messages begin in the planned history. Before any compaction that is the turn's start
 * message. A continuation that resumed at a compaction summary did not apply it: that summary is pre-turn history the
 * view already carries, so the turn's own messages begin right after it (an index past the end while the turn has none
 * yet). After a host compaction scoped to this turn, the start may be summarized away, so the turn begins at that
 * checkpoint's summary, or at the start entry the checkpoint kept directly before it. Throws rather than guess.
 */
export function resolveContinuousChatTurnStart(
	handle: IcmTurnHandle,
	messages: readonly AgentMessage[],
): { index: number } | { error: string } {
	const latest = handle.latestCompaction;
	if (latest === undefined) {
		const start = handle.startMessage;
		if (start === undefined) return { error: "Continuous-chat turn has no start message." };
		// Searched from the end: the turn's own messages are the tail, so this costs the turn, not the whole session.
		const startIndex = messages.lastIndexOf(start);
		if (startIndex === -1) return { error: "Continuous-chat turn start is missing from the planned history." };
		return { index: start.role === "compactionSummary" ? startIndex + 1 : startIndex };
	}
	const summaryIndex = messages.findLastIndex(
		(message) => message.role === "compactionSummary" && message.compactionEntryId === latest.entryId,
	);
	if (summaryIndex === -1) {
		return {
			error: `Continuous-chat turn compaction ${latest.entryId} has no summary in the planned history; durable history must not be sent.`,
		};
	}
	const retained = latest.retainedStart;
	return {
		index:
			summaryIndex > 0 && retained !== undefined && retained.matches(messages[summaryIndex - 1])
				? summaryIndex - 1
				: summaryIndex,
	};
}

/**
 * The running turn as the context audit shows it: its frame, and the session entry its own messages begin at in `messages`
 * (`getEntryId` reads a persisted message's entry), or why that entry is not known.
 */
export function continuousChatTurnAudit(
	turn: IcmTurnHandle,
	messages: readonly AgentMessage[],
	getEntryId: (message: AgentMessage) => string | undefined,
): NonNullable<ContinuousChatAudit["turn"]> {
	const frame = continuousChatFrameMessages(turn, renderContinuousChatTurnState(turn));
	const resolved = resolveContinuousChatTurnStart(turn, messages);
	if ("error" in resolved) return { turnId: turn.turnId, frame, start: { unresolved: resolved.error } };
	const first = messages[resolved.index];
	const entryId =
		first === undefined
			? undefined
			: first.role === "compactionSummary"
				? first.compactionEntryId
				: getEntryId(first);
	return {
		turnId: turn.turnId,
		frame,
		start:
			entryId !== undefined
				? { entryId }
				: {
						unresolved:
							first === undefined
								? "the turn has no message of its own yet"
								: "the turn's first message is not persisted in the session yet",
					},
	};
}

function turnStartIndex(handle: IcmTurnHandle, messages: readonly AgentMessage[]): number {
	const resolved = resolveContinuousChatTurnStart(handle, messages);
	if ("error" in resolved) throw new Error(resolved.error);
	return resolved.index;
}

/**
 * Projects the installed plan onto the running turn. The base planner receives only the running turn's
 * messages (with `sentPrefixCount` shifted to the turn start) so context GC, path aliasing, prompt
 * enforcement, and transient decisions never inspect or mutate pre-turn durable history that `<chat>`
 * replaced; the wire carries the turn view and state followed by the planned turn messages. The view and
 * state lead the plan as its non-compactable head: compaction can only shrink the turn's own messages.
 * Throws rather than send durable history when no turn is running, the turn start is missing from the
 * request, a compaction summary in the turn is not one this turn applied, or the planned history contains
 * messages outside the running turn.
 */
export function createContinuousChatPlanWrapper(
	source: ContinuousChatProjectionSource,
): (base: AgentContextPlanFn) => AgentContextPlanFn {
	// One frame per turn and state: every tool-loop request of the turn carries the same messages, byte for byte.
	let frame: { handle: IcmTurnHandle; stateText: string; messages: AgentMessage[] } | undefined;
	const frameFor = (handle: IcmTurnHandle, stateText: string): AgentMessage[] => {
		if (frame?.handle === handle && frame.stateText === stateText) return frame.messages;
		const messages = continuousChatFrameMessages(handle, stateText);
		frame = { handle, stateText, messages };
		return messages;
	};
	return (base) => async (request, signal) => {
		const current = source.current();
		if (current === undefined) {
			throw new Error("Continuous-chat provider request has no running turn; durable history must not be sent.");
		}
		const { handle, stateText } = current;
		const startIndex = turnStartIndex(handle, request.messages);
		// The turn's messages, untransformed: the durable form transient records were committed in.
		// Only the running turn is handed to the base planner so context GC, path aliasing, prompt
		// enforcement, and transient-cleared checks never inspect or rewrite pre-turn durable history
		// that `<chat>` already replaced.
		const turnMessages = request.messages.slice(startIndex);
		// A summary is pre-turn history unless this turn applied it: only the turn's own checkpoints may ride the wire.
		const foreignSummary = turnMessages.find(
			(message) =>
				message.role === "compactionSummary" &&
				(message.compactionEntryId === undefined || !handle.notedCompactions.has(message.compactionEntryId)),
		);
		if (foreignSummary !== undefined) {
			throw new Error(
				"Continuous-chat turn carries a compaction summary this turn did not apply; pre-turn history must not be sent.",
			);
		}
		const sentPrefixCount = Math.max(0, request.sentPrefixCount - startIndex);
		const plan = await base({ ...request, messages: turnMessages, sentPrefixCount }, signal);
		const turnTimestamps = new Set(turnMessages.map((message) => message.timestamp));
		if (plan.messages.some((message) => !turnTimestamps.has(message.timestamp))) {
			throw new Error("Continuous-chat planned history does not end with the running turn.");
		}
		const isTurnCurrent = (): boolean => {
			const now = source.current();
			return now?.handle === handle && now.stateText === stateText;
		};
		const frameMessages = frameFor(handle, stateText);
		return {
			...plan,
			messages: [...frameMessages, ...plan.messages],
			nonCompactableHead: frameMessages.length + (plan.nonCompactableHead ?? 0),
			transientReconciliationBase: turnMessages,
			isCurrent: () => isTurnCurrent() && plan.isCurrent?.() !== false,
			prepareCommit: () => isTurnCurrent() && plan.prepareCommit?.() !== false,
		};
	};
}
