/**
 * Turn-scoped provider projection of the continuous chat. A turn's wire carries the turn view (summaries of the whole
 * chat), the turn's live state, and the turn's own messages; durable history from before the turn is never sent.
 */

import type { TextContent } from "@caupulican/pi-ai";
import type { AgentContextPlanFn } from "../../kernel/loop-config.ts";
import { createCustomMessage } from "../../kernel/messages.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { PATH_ALIAS_LEGEND_CUSTOM_TYPE } from "../context/path-alias-table.ts";
import type { ContinuousChatAudit } from "../extensions/builtin.ts";
import type { ContinuousChatCacheTextContent, ContinuousChatViewCache } from "./continuous-chat-cache.ts";
import type { IcmTurnCoordinator, IcmTurnHandle } from "./continuous-chat-turn-coordinator.ts";

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
 * Splits a `<chat>` view into text blocks of four whole lines. The boundary stops at the last whole block before
 * the first unresolved row. The closing tag and partial remainder remain outside it. Host provenance explicitly
 * represents an empty stable prefix, so a missing boundary never falls back to a guessed stability threshold.
 */
export function renderContinuousChatViewBlocks(view: string, cache: ContinuousChatViewCache): TextContent[] {
	const lines = view.split("\n");
	if (lines.pop() !== VIEW_CLOSING_TAG) throw new TypeError("Continuous-chat view must end with its closing tag.");
	if (lines.shift() !== "<chat>") throw new TypeError("Continuous-chat view must start with its opening tag.");
	if (cache.lines.length === 0 && lines.length === 1 && lines[0] === "") lines.pop();
	if (
		cache.lines.length !== lines.length ||
		!Number.isSafeInteger(cache.stablePrefixLineCount) ||
		cache.stablePrefixLineCount < 0 ||
		cache.stablePrefixLineCount > lines.length
	)
		throw new TypeError("Continuous-chat cache provenance does not match its rendered view.");
	const wholeBlocks = Math.floor(lines.length / VIEW_BLOCK_LINES);
	const stableBlocks = Math.floor(cache.stablePrefixLineCount / VIEW_BLOCK_LINES);
	const blocks: TextContent[] = [];
	for (let index = 0; index < wholeBlocks; index++) {
		const start = index * VIEW_BLOCK_LINES;
		const body = lines.slice(start, start + VIEW_BLOCK_LINES).join("\n");
		const block: TextContent = { type: "text", text: `${index === 0 ? "<chat>\n" : ""}${body}\n` };
		if (index === stableBlocks - 1) block.cacheBoundary = true;
		blocks.push(block);
	}
	const remainder = [
		...(wholeBlocks === 0 ? ["<chat>"] : []),
		...lines.slice(wholeBlocks * VIEW_BLOCK_LINES),
		VIEW_CLOSING_TAG,
	];
	blocks.push({ type: "text", text: remainder.join("\n") });
	const first: ContinuousChatCacheTextContent = { ...blocks[0]!, icmCache: cache };
	blocks[0] = first;
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
	return continuousChatViewFrameMessages(handle.boundary.view, handle.boundary.viewCache, handle.startedAt, stateText);
}

function continuousChatViewFrameMessages(
	view: string,
	cache: ContinuousChatViewCache,
	startedAt: number,
	stateText: string,
): AgentMessage[] {
	const timestamp = new Date(startedAt).toISOString();
	return [
		createCustomMessage(
			CONTINUOUS_CHAT_VIEW_CUSTOM_TYPE,
			renderContinuousChatViewBlocks(view, cache),
			false,
			undefined,
			timestamp,
		),
		createCustomMessage(CONTINUOUS_CHAT_STATE_CUSTOM_TYPE, stateText, false, undefined, timestamp),
	];
}

/** The projection and turns a dashboard reads to measure what a request carries under ICM. */
export interface ContinuousChatRequestSource {
	wire: ContinuousChatWire | undefined;
	host: { turns: Pick<IcmTurnCoordinator, "current" | "birthView"> } | undefined;
}

/**
 * What a request carries under ICM, split for measurement: the frame (turn view and live state) and the running turn's
 * own messages. Durable history before the turn is not sent, so it is not part of either. Between turns no request is
 * sent; the split then previews the next turn, which opens with the latest pinned view and no messages of its own.
 * Absent when no chat projection owns the wire, so the session's own history is what a request carries.
 */
export function splitContinuousChatRequest(
	source: ContinuousChatRequestSource,
	messages: readonly AgentMessage[],
): { frame: AgentMessage[]; own: AgentMessage[] } | undefined {
	if (source.wire?.kind !== "chat" || source.host === undefined) return undefined;
	const turn = source.host.turns.current();
	if (turn !== undefined) {
		const resolved = resolveContinuousChatTurnStart(turn, messages);
		return {
			frame: turnFrame(turn),
			own: "error" in resolved ? [] : messages.slice(resolved.index),
		};
	}
	const next = source.host.turns.birthView();
	return {
		frame:
			next === undefined
				? []
				: continuousChatViewFrameMessages(
						next.view,
						next.viewCache,
						next.timestamp,
						renderContinuousChatTurnState({ startedAt: next.timestamp }),
					),
		own: [],
	};
}

/**
 * The durable history the next provider request carries: the running turn's own messages under ICM (earlier turns are
 * only summarized in the view), the whole `messages` when no chat projection owns the wire. The one definition of what
 * the model can see of the session's messages; a message outside it is not in the model's context.
 */
export function continuousChatRequestHistory(
	source: ContinuousChatRequestSource,
	messages: readonly AgentMessage[],
): readonly AgentMessage[] {
	return splitContinuousChatRequest(source, messages)?.own ?? messages;
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
 * The frame a turn's requests carry: the carried head and view the turn's first request noted, else the view and state alone
 * (before that request). One source for the dashboard and the context audit, so both show what the wire carries.
 */
function turnFrame(turn: IcmTurnHandle): AgentMessage[] {
	return turn.frame === undefined
		? continuousChatFrameMessages(turn, renderContinuousChatTurnState(turn))
		: [...turn.frame];
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
	const frame = turnFrame(turn);
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

/** A turn's carried head: the records its first request carried (what reconciliation holds) and their wire form. */
interface CarriedTurnHead {
	readonly handle: IcmTurnHandle;
	readonly records: readonly AgentMessage[];
	readonly wire: readonly AgentMessage[];
}

/** Whether a record is the path-alias legend, the record a carried head ends with when a frame legend exists. */
function isFrameLegend(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === PATH_ALIAS_LEGEND_CUSTOM_TYPE;
}

/**
 * The frame legend's text as the blocks already sent. Text that extends them adds one block holding its new suffix; any other
 * text starts over. The frame text is append-only, so a turn that grows the legend leaves every block sent before byte-identical.
 */
function legendBatches(sent: readonly string[], text: string): string[] {
	const joined = sent.join("");
	if (text === joined) return [...sent];
	return text.startsWith(joined) ? [...sent, text.slice(joined.length)] : [text];
}

/**
 * The wire form of a carried head. Every record but the last is sent as reconciliation holds it. The last one carries the cache
 * boundary on its last block: a frame legend is sent as `legendBlocks` (one text block per append batch, so a block sent before
 * stays byte-identical as the legend grows, and the previous turn's breakpoint still prefix-matches), any other record as one block.
 */
function carriedHeadWire(records: readonly AgentMessage[], legendBlocks: readonly string[]): AgentMessage[] {
	const last = records.at(-1);
	if (last === undefined) return [];
	if (last.role !== "custom") throw new TypeError("A carried record is a custom record.");
	const texts = isFrameLegend(last) ? legendBlocks : [carriedText(last)];
	const blocks: TextContent[] = texts.map((text, index) =>
		index === texts.length - 1 ? { type: "text", text, cacheBoundary: true } : { type: "text", text },
	);
	return [...records.slice(0, -1), { ...last, content: blocks }];
}

/**
 * Projects the installed plan onto the running turn. The base planner receives only the running turn's
 * messages (with `sentPrefixCount` shifted to the turn start) so context GC, path aliasing, prompt
 * enforcement, and transient decisions never inspect or mutate pre-turn durable history that `<chat>`
 * replaced; the wire carries the turn view and state followed by the planned turn messages. The view and
 * state lead the plan as its non-compactable head: compaction can only shrink the turn's own messages.
 * The carried head (skill, authority and task-directory records, then the frame legend) leads the view and is
 * memoized per turn: its records are the ones the first request of the turn carried, so a turn re-derives it
 * only when the next turn starts. Reconciliation reads the carried records as the wire's history.
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
		frame = { handle, stateText, messages: continuousChatFrameMessages(handle, stateText) };
		return frame.messages;
	};
	// The frame legend's text as the blocks sent so far, across turns (see `legendBatches`).
	let legendSent: readonly string[] = [];
	// The running turn's carried head, memoized on its first request.
	let carried: CarriedTurnHead | undefined;
	const carryHead = (
		handle: IcmTurnHandle,
		records: readonly AgentMessage[],
		frameMessages: readonly AgentMessage[],
	): CarriedTurnHead => {
		const legend = records.at(-1);
		legendSent = legend !== undefined && isFrameLegend(legend) ? legendBatches(legendSent, carriedText(legend)) : [];
		const head: CarriedTurnHead = { handle, records, wire: carriedHeadWire(records, legendSent) };
		carried = head;
		handle.noteFrame([...records, ...frameMessages]);
		return head;
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
		// The frame leads the wire: the base plan reads it to learn what the model sees (the legend names every alias the
		// turn view, state or carried head mentions), never to rewrite it. The same frame objects ride every request of the
		// turn and state, so what a reader derives from them is computed once.
		const frameMessages = frameFor(handle, stateText);
		const memoized = carried?.handle === handle ? carried : undefined;
		const plan = await base(
			{
				...request,
				messages: turnMessages,
				sentPrefixCount,
				wire: {
					...request.wire,
					messages: [...(memoized?.wire ?? []), ...frameMessages, ...(request.wire?.messages ?? [])],
					carry: true,
				},
			},
			signal,
		);
		const head = memoized ?? carryHead(handle, plan.carriedRecords ?? [], frameMessages);
		const turnTimestamps = new Set(turnMessages.map((message) => message.timestamp));
		if (plan.messages.some((message) => !turnTimestamps.has(message.timestamp))) {
			throw new Error("Continuous-chat planned history does not end with the running turn.");
		}
		const isTurnCurrent = (): boolean => {
			const now = source.current();
			return now?.handle === handle && now.stateText === stateText;
		};
		const { carriedRecords: _carriedRecords, ...planWithoutHead } = plan;
		return {
			...planWithoutHead,
			messages: [...head.wire, ...frameMessages, ...plan.messages],
			nonCompactableHead: head.wire.length + frameMessages.length + (plan.nonCompactableHead ?? 0),
			transientReconciliationBase: [...head.records, ...turnMessages],
			isCurrent: () => isTurnCurrent() && plan.isCurrent?.() !== false,
			prepareCommit: () => isTurnCurrent() && plan.prepareCommit?.() !== false,
		};
	};
}

/** The text a carried record holds: its string content (`transientRecordMessageOf` builds it so). */
function carriedText(message: AgentMessage): string {
	if (message.role !== "custom" || typeof message.content !== "string") {
		throw new TypeError("A carried record holds its text as string content.");
	}
	return message.content;
}
