/**
 * Turn-scoped provider projection of the continuous chat. A turn's wire carries the turn view (summaries of the whole
 * chat), the turn's live state, and the turn's own messages; durable history from before the turn is never sent.
 */

import type { TextContent } from "@caupulican/pi-ai";
import type { AgentContextPlanFn } from "../../kernel/loop-config.ts";
import { createCustomMessage } from "../../kernel/messages.ts";
import type { AgentMessage } from "../../kernel/types.ts";
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
 * Projects the installed plan onto the running turn, as its last stage. The base plans over the whole durable history,
 * so its transient decisions still see the earlier records; the wire takes only the turn's own messages from the base
 * output, after the turn view and state. Throws rather than send durable history when no turn is running, the turn
 * start is missing from the request, or the planned history no longer ends with the turn.
 */
export function createContinuousChatPlanWrapper(
	source: ContinuousChatProjectionSource,
): (base: AgentContextPlanFn) => AgentContextPlanFn {
	// One frame per turn and state: every tool-loop request of the turn carries the same messages, byte for byte.
	let frame: { handle: IcmTurnHandle; stateText: string; messages: AgentMessage[] } | undefined;
	const frameFor = (handle: IcmTurnHandle, stateText: string): AgentMessage[] => {
		if (frame?.handle === handle && frame.stateText === stateText) return frame.messages;
		const timestamp = new Date(handle.startedAt).toISOString();
		const messages = [
			createCustomMessage(
				CONTINUOUS_CHAT_VIEW_CUSTOM_TYPE,
				renderContinuousChatViewBlocks(handle.boundary.view),
				false,
				undefined,
				timestamp,
			),
			createCustomMessage(CONTINUOUS_CHAT_STATE_CUSTOM_TYPE, stateText, false, undefined, timestamp),
		];
		frame = { handle, stateText, messages };
		return messages;
	};
	return (base) => async (request, signal) => {
		const current = source.current();
		if (current === undefined) {
			throw new Error("Continuous-chat provider request has no running turn; durable history must not be sent.");
		}
		const { handle, stateText } = current;
		const start = handle.startMessage;
		if (start === undefined) throw new Error("Continuous-chat turn has no start message.");
		const startIndex = request.messages.indexOf(start);
		if (startIndex === -1) throw new Error("Continuous-chat turn start is missing from the planned history.");
		// The turn's messages, untransformed: the durable form transient records were committed in.
		const turnMessages = request.messages.slice(startIndex);
		const plan = await base(request, signal);
		// Context transforms may rewrite the turn's messages (path aliases) but keep their count and timestamps.
		const turnStart = plan.messages.length - turnMessages.length;
		const planned = turnStart >= 0 ? plan.messages[turnStart] : undefined;
		if (planned?.role !== start.role || planned.timestamp !== start.timestamp) {
			throw new Error("Continuous-chat planned history does not end with the running turn.");
		}
		const isTurnCurrent = (): boolean => {
			const now = source.current();
			return now?.handle === handle && now.stateText === stateText;
		};
		return {
			...plan,
			messages: [...frameFor(handle, stateText), ...plan.messages.slice(turnStart)],
			transientReconciliationBase: turnMessages,
			isCurrent: () => isTurnCurrent() && plan.isCurrent?.() !== false,
			prepareCommit: () => isTurnCurrent() && plan.prepareCommit?.() !== false,
		};
	};
}
