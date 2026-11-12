/**
 * Domain commands behind the `zoom` and `date` tools of the ICM conversation. No file access: every read goes
 * through the ports declared here. `readMessageDate` yields the exact persisted RFC 3339 timestamp.
 */

import {
	parseWorkerTranscriptReference,
	WORKER_TRANSCRIPT_REFERENCE_PREFIX,
} from "../delegation/worker-transcript-reference.ts";
import { isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";
import {
	CONTINUOUS_CHAT_MAX_IMAGE_BYTES,
	type ContinuousChatImageRef,
	type ContinuousChatMessageKind,
	type ContinuousChatRecord,
	type ContinuousChatToolClipping,
} from "./continuous-chat-contracts.ts";
import { truncateContinuousChatUtf8 } from "./continuous-chat-prompt.ts";
import {
	type ContinuousChatNodeCoordinate,
	type ContinuousChatTreeNode,
	continuousChatNodeFirstMessage,
	continuousChatNodeLabel,
	continuousChatParentCoordinate,
	renderContinuousChatViewLine,
} from "./continuous-chat-tree.ts";
import { assertMemoryReadActive, type MemoryReadContext } from "./memory-read-context.ts";

/** Page size of the root's zoom: a long message or an agent's log comes in pages of this many UTF-8 bytes. */
export const CONTINUOUS_CHAT_ZOOM_PAGE_BYTES = 32_768;
/** Page size of a delegated lane's zoom: fixed, so page numbers hold, and small enough for the lane's room. */
export const CONTINUOUS_CHAT_LANE_PAGE_BYTES = 4_096;
/** Decoded image bytes one zoom result attaches; an image past the remaining budget is named, never attached. */
export const CONTINUOUS_CHAT_ZOOM_IMAGE_MAX_BYTES = CONTINUOUS_CHAT_MAX_IMAGE_BYTES;
/** Images one zoom result attaches, whatever their size; the rest are named in the text. */
export const CONTINUOUS_CHAT_ZOOM_IMAGE_MAX_COUNT = 4;
/** The same budget for a delegated lane's zoom result, which must also fit the lane's room. */
export const CONTINUOUS_CHAT_LANE_IMAGE_MAX_BYTES = CONTINUOUS_CHAT_MAX_IMAGE_BYTES;
export const CONTINUOUS_CHAT_WORKER_NAME_MAX_CHARACTERS = 128;

const DATE_ARGUMENT_KEYS: readonly string[] = ["id"];
const ZOOM_ARGUMENT_KEYS: readonly string[] = ["id", "n", "page"];
const ZOOM_RANGE_MAX_READS = 128;

/** Committed tree nodes, logged messages and their images. `ContinuousChatStore` satisfies it structurally. */
export interface ContinuousChatNavigationSource {
	readNode(
		coordinate: ContinuousChatNodeCoordinate,
		context?: MemoryReadContext,
	): Promise<ContinuousChatTreeNode | undefined>;
	readMessageById(id: number, context?: MemoryReadContext): Promise<ContinuousChatRecord | undefined>;
	readMessageDate(id: number, context?: MemoryReadContext): Promise<string | undefined>;
	readImage(ref: ContinuousChatImageRef, context?: MemoryReadContext): Promise<Buffer>;
}

/** One page of an agent's chat log. `pageCount` is at least 1 and `page` is below it. */
export interface ContinuousChatWorkerLogPage {
	name: string;
	page: number;
	/** True when at least one more bounded page exists. */
	hasMore: boolean;
	text: string;
}

/**
 * Port over an agent's chat log, addressed by a validated name (never a path) with bounded streaming pagination
 * (`maxBytes` per page). Resolves undefined when the name or page does not exist. Malformed or over-limit port replies
 * are refused as `worker-log-unavailable`, never cut or repaired.
 */
export interface ContinuousChatWorkerLogPort {
	readPage(name: string, page: number, maxBytes: number): Promise<ContinuousChatWorkerLogPage | undefined>;
}

/** A validated request. `zoom` with a numeric id is a node command; with an agent name it is a worker-log command. */
export type ContinuousChatNavigationCommand =
	| { tool: "zoom"; kind: "node"; id: number; n: number; page: number }
	| { tool: "zoom"; kind: "worker"; name: string; page: number }
	| { tool: "date"; id: number };

/** Why a command was refused. Refusals are returned as data, never thrown. */
export type ContinuousChatNavigationRejection =
	| "invalid-arguments"
	| "out-of-range"
	| "incomplete"
	| "not-found"
	| "page-out-of-range"
	| "worker-log-unavailable";

/** Outcome of a command: a range, one message page, a date, or one worker-log page. */
export type ContinuousChatNavigationResult =
	| { status: "range"; lines: string[]; continuation?: { id: number; n: number } }
	| {
			status: "message";
			id: number;
			kind: ContinuousChatMessageKind;
			date: string;
			page: number;
			pageCount: number;
			text: string;
			images: ContinuousChatImageRef[];
			toolClipping?: ContinuousChatToolClipping;
	  }
	| { status: "date"; id: number; date: string }
	| { status: "worker-log"; name: string; page: number; hasMore: boolean; text: string }
	| { status: "rejected"; reason: ContinuousChatNavigationRejection; message: string };

function invalidArguments(message: string): { status: "rejected"; reason: "invalid-arguments"; message: string } {
	return { status: "rejected", reason: "invalid-arguments", message };
}

function rejected(reason: ContinuousChatNavigationRejection, message: string): ContinuousChatNavigationResult {
	return { status: "rejected", reason, message };
}

function workerNameProblem(name: string): string | undefined {
	if (name.length === 0) return "Agent name must not be empty.";
	if (Array.from(name).length > CONTINUOUS_CHAT_WORKER_NAME_MAX_CHARACTERS) {
		return `Agent name must be at most ${CONTINUOUS_CHAT_WORKER_NAME_MAX_CHARACTERS} characters.`;
	}
	if (name === "." || name === "..") return "Agent name must not be a dot segment.";
	if (/[\p{Cc}/\\]/u.test(name)) return "Agent name must not contain slashes, backslashes or control characters.";
	return undefined;
}

/** One page of a paged text: `text` is the wanted page, undefined when it lies past the last page. */
export interface ContinuousChatTextPage {
	pageCount: number;
	text: string | undefined;
	hasMore: boolean;
}

/**
 * The one exact paging primitive of the chat's zoom and of the worker log. Pages hold at most `maxBytes` UTF-8 bytes,
 * cut only between code points, so the pages concatenate to the text; empty text is one empty page. The text arrives in
 * chunks read one at a time and only the wanted page is kept, so no caller renders a whole log to read one page.
 */
export function pageContinuousChatText(
	chunks: Iterable<string>,
	maxBytes: number,
	wanted: number,
	stopAfterWanted = false,
): ContinuousChatTextPage {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new RangeError("Page size must be a positive safe integer.");
	}
	let pageCount = 0;
	let page = "";
	let pageBytes = 0;
	let wantedText: string | undefined;
	const closePage = (): void => {
		if (pageCount === wanted) wantedText = page;
		pageCount++;
		page = "";
		pageBytes = 0;
	};
	for (const chunk of chunks) {
		let rest = chunk;
		while (rest.length > 0) {
			const piece = truncateContinuousChatUtf8(rest, maxBytes - pageBytes);
			if (piece.length === 0) {
				// Nothing fits an empty page only when one character is larger than a page: no progress is possible.
				if (pageBytes === 0) throw new RangeError(`Page size ${maxBytes} cannot hold one character.`);
				closePage();
				if (stopAfterWanted && pageCount > wanted + 1) {
					return { pageCount, text: wantedText, hasMore: true };
				}
				continue;
			}
			page += piece;
			pageBytes += Buffer.byteLength(piece, "utf8");
			rest = rest.slice(piece.length);
		}
	}
	closePage();
	return { pageCount, text: wantedText, hasMore: pageCount > wanted + 1 };
}

function isWorkerLogPageFor(reply: ContinuousChatWorkerLogPage, name: string, page: number, maxBytes: number): boolean {
	return (
		isPlainRecord(reply) &&
		reply.name === name &&
		reply.page === page &&
		typeof reply.hasMore === "boolean" &&
		typeof reply.text === "string" &&
		Buffer.byteLength(reply.text, "utf8") <= maxBytes
	);
}

/**
 * Validates model-supplied `zoom` or `date` arguments. Unknown keys and wrong types are refused, never coerced.
 */
export function parseContinuousChatNavigationCommand(
	tool: string,
	args: unknown,
): ContinuousChatNavigationCommand | { status: "rejected"; reason: "invalid-arguments"; message: string } {
	if (tool !== "zoom" && tool !== "date") return invalidArguments(`Unknown tool "${tool}".`);
	if (!isPlainRecord(args)) return invalidArguments(`${tool} arguments must be an object.`);
	const allowedKeys = tool === "date" ? DATE_ARGUMENT_KEYS : ZOOM_ARGUMENT_KEYS;
	const unknownKey = Object.keys(args).find((key) => !allowedKeys.includes(key));
	if (unknownKey !== undefined) return invalidArguments(`Unknown ${tool} argument "${unknownKey}".`);
	const id = args.id;
	if (tool === "date") {
		if (!isNonNegativeSafeInteger(id)) return invalidArguments("date id must be a non-negative safe integer.");
		return { tool: "date", id };
	}
	const page = args.page === undefined ? 0 : args.page;
	if (!isNonNegativeSafeInteger(page)) return invalidArguments("zoom page must be a non-negative safe integer.");
	if (typeof id === "string") {
		if (args.n !== undefined) return invalidArguments("zoom with an agent name takes no n.");
		if (id !== id.trim()) return invalidArguments("Agent name must not have leading or trailing whitespace.");
		if (id.startsWith(WORKER_TRANSCRIPT_REFERENCE_PREFIX)) {
			if (parseWorkerTranscriptReference(id) === undefined)
				return invalidArguments("Invalid worker transcript reference.");
		} else {
			const problem = workerNameProblem(id);
			if (problem !== undefined) return invalidArguments(problem);
		}
		return { tool: "zoom", kind: "worker", name: id, page };
	}
	if (typeof id !== "number" || !isNonNegativeSafeInteger(id)) {
		return invalidArguments("zoom id must be a non-negative safe integer message id or an agent name.");
	}
	const n = args.n;
	if (!isNonNegativeSafeInteger(n) || n === 0) {
		return invalidArguments(
			`zoom with a message id requires n, a positive safe integer (use n: 1 for message ${id}).`,
		);
	}
	return { tool: "zoom", kind: "node", id, n, page };
}

/** Runs navigation commands against the source and the optional worker-log port. */
export class ContinuousChatNavigator {
	private readonly source: ContinuousChatNavigationSource;
	private readonly workerLogs: ContinuousChatWorkerLogPort | undefined;
	private readonly pageBytes: number;
	private readonly imageBytes: number;

	constructor(
		source: ContinuousChatNavigationSource,
		workerLogs?: ContinuousChatWorkerLogPort,
		pageBytes = CONTINUOUS_CHAT_ZOOM_PAGE_BYTES,
		imageBytes = CONTINUOUS_CHAT_ZOOM_IMAGE_MAX_BYTES,
	) {
		this.source = source;
		this.workerLogs = workerLogs;
		this.pageBytes = pageBytes;
		this.imageBytes = imageBytes;
	}

	/** Executes one validated command. Source and port errors propagate; only refusals come back as data. */
	async execute(
		command: ContinuousChatNavigationCommand,
		signal?: AbortSignal,
		readContext?: MemoryReadContext,
	): Promise<ContinuousChatNavigationResult> {
		const context: MemoryReadContext = {
			...readContext,
			signal:
				signal && readContext?.signal
					? AbortSignal.any([signal, readContext.signal])
					: (signal ?? readContext?.signal),
		};
		assertMemoryReadActive(context);
		if (command.tool === "date") return this.lookupDate(command.id, context);
		if (command.kind === "worker") return this.zoomWorker(command.name, command.page, context);
		if (command.n === 1) return this.zoomMessage(command.id, command.page, context);
		return this.zoomRange(command.id, command.n, command.page, context);
	}

	private async lookupDate(id: number, context?: MemoryReadContext): Promise<ContinuousChatNavigationResult> {
		const date = await this.source.readMessageDate(id, context);
		assertMemoryReadActive(context);
		if (date === undefined) return rejected("not-found", `No message ${id}.`);
		return { status: "date", id, date };
	}

	private async zoomMessage(
		id: number,
		page: number,
		context?: MemoryReadContext,
	): Promise<ContinuousChatNavigationResult> {
		const record = await this.source.readMessageById(id, context);
		assertMemoryReadActive(context);
		if (record === undefined) return rejected("not-found", `No message ${id}.`);
		const textPage = pageContinuousChatText([record.text], this.pageBytes, page);
		const imagePages: ContinuousChatImageRef[][] = [];
		for (const image of record.images ?? []) {
			let current = imagePages.at(-1);
			const currentBytes = current?.reduce((total, item) => total + item.bytes, 0) ?? 0;
			if (
				current === undefined ||
				current.length === CONTINUOUS_CHAT_ZOOM_IMAGE_MAX_COUNT ||
				(this.imageBytes > 0 && currentBytes + image.bytes > this.imageBytes)
			) {
				current = [];
				imagePages.push(current);
			}
			current.push(image);
		}
		const pageCount = Math.max(textPage.pageCount, imagePages.length, 1);
		if (page >= pageCount) {
			return rejected("page-out-of-range", `Message ${id} has ${pageCount} page(s), not page ${page}.`);
		}
		const message: Extract<ContinuousChatNavigationResult, { status: "message" }> = {
			status: "message",
			id,
			kind: record.kind,
			date: record.date,
			page,
			pageCount,
			text: textPage.text ?? "",
			images: imagePages[page] ?? [],
		};
		if (record.toolClipping !== undefined) message.toolClipping = record.toolClipping;
		return message;
	}

	/** Opens a bounded range without making the persisted summary tree non-dyadic. */
	private async zoomRange(
		id: number,
		n: number,
		page: number,
		context?: MemoryReadContext,
	): Promise<ContinuousChatNavigationResult> {
		if (n - 1 > Number.MAX_SAFE_INTEGER - id)
			return rejected("out-of-range", `Range ${id}+${n} exceeds the safe message-id range.`);
		if (page !== 0)
			return rejected("page-out-of-range", "Ranges have no numbered pages; use the remaining range instead.");
		const end = id + (n - 1);
		const lastDate = await this.source.readMessageDate(end, context);
		assertMemoryReadActive(context);
		if (lastDate === undefined) return rejected("out-of-range", `Messages ${id} to ${end} are not all logged.`);

		type Item = { coordinate: ContinuousChatNodeCoordinate; expand: boolean; required: boolean };
		const cover: Item[] = [];
		let cursor = id;
		while (cursor <= end) {
			const remaining = end - cursor + 1;
			let level = Math.min(52, Math.floor(Math.log2(remaining)));
			while (2 ** level > remaining) level--;
			while (cursor % 2 ** level !== 0) level--;
			const count = 2 ** level;
			cover.push({ coordinate: { level, ordinal: cursor / count }, expand: true, required: false });
			cursor += count;
		}
		const pending = cover.reverse();
		const lines: string[] = [];
		let reads = 1;
		let next = id;
		let bytes = 0;
		// Reserve enough room for the longest possible safe-integer continuation, including separators.
		const textBudget = this.pageBytes - 128;
		if (textBudget < 896)
			throw new RangeError("Zoom range budget is too small for a bounded summary and continuation.");
		while (pending.length > 0 && reads < ZOOM_RANGE_MAX_READS) {
			const item = pending.pop()!;
			const coordinate = item.coordinate;
			const first = continuousChatNodeFirstMessage(coordinate);
			const count = 2 ** coordinate.level;
			const node = await this.source.readNode(coordinate, context);
			reads++;
			assertMemoryReadActive(context);
			if (!node && item.required)
				return rejected("incomplete", `Line ${continuousChatNodeLabel(coordinate)} is missing.`);
			if (coordinate.level > 0 && (!node || item.expand)) {
				const left = { level: coordinate.level - 1, ordinal: coordinate.ordinal * 2 };
				const right = { level: coordinate.level - 1, ordinal: coordinate.ordinal * 2 + 1 };
				if (node) {
					const parent = node.children && continuousChatParentCoordinate(node.children[0], node.children[1]);
					if (!parent || parent.level !== coordinate.level || parent.ordinal !== coordinate.ordinal)
						return rejected(
							"incomplete",
							`Line ${continuousChatNodeLabel(coordinate)} does not cover its two children.`,
						);
				}
				pending.push({ coordinate: right, expand: false, required: !!node });
				pending.push({ coordinate: left, expand: false, required: !!node });
				continue;
			}
			let line: string;
			if (node) {
				line = renderContinuousChatViewLine(node);
				if (coordinate.level === 0) line += ` [full message and images: zoom({id:${first},n:1,page:0})]`;
			} else {
				if (reads >= ZOOM_RANGE_MAX_READS) break;
				const record = await this.source.readMessageById(first, context);
				reads++;
				assertMemoryReadActive(context);
				if (!record) return rejected("not-found", `No message ${first}.`);
				const reference = `zoom({id:${first},n:1,page:0})`;
				line = `${first}+1|${record.kind}: ${record.text}${record.images?.length ? ` [images: ${reference}]` : ""}`;
				if (record.toolClipping || Buffer.byteLength(line, "utf8") > textBudget)
					line = `${first}+1|${record.toolClipping ? "Clipped tool output" : "Full message"}: ${reference}`;
			}
			const lineBytes = Buffer.byteLength(line, "utf8") + (lines.length ? 1 : 0);
			if (bytes + lineBytes > textBudget) break;
			lines.push(line);
			bytes += lineBytes;
			next = first + count;
		}
		return { status: "range", lines, ...(next <= end ? { continuation: { id: next, n: end - next + 1 } } : {}) };
	}

	private async zoomWorker(
		name: string,
		page: number,
		context?: MemoryReadContext,
	): Promise<ContinuousChatNavigationResult> {
		if (this.workerLogs === undefined) {
			return rejected("worker-log-unavailable", "Agent chat logs are not available.");
		}
		const reply = await this.workerLogs.readPage(name, page, this.pageBytes);
		assertMemoryReadActive(context);
		if (reply === undefined) return rejected("not-found", `No page ${page} of agent ${name}.`);
		if (!isWorkerLogPageFor(reply, name, page, this.pageBytes)) {
			return rejected("worker-log-unavailable", `The agent chat log port returned an invalid page for ${name}.`);
		}
		return { status: "worker-log", name, page, hasMore: reply.hasMore, text: reply.text };
	}
}

/** Renders a result as the compact, deterministic text returned to the model. */
export function renderContinuousChatNavigationResult(result: ContinuousChatNavigationResult): string {
	switch (result.status) {
		case "range":
			return [
				...result.lines,
				...(result.continuation
					? [`Continue: zoom({id:${result.continuation.id},n:${result.continuation.n}})`]
					: []),
			].join("\n");
		case "message": {
			const lines = [
				`message ${result.id} (${result.kind}, ${result.date}) page ${result.page + 1}/${result.pageCount}`,
			];
			for (const image of result.images) lines.push(`image ${image.digest} ${image.mimeType} ${image.bytes}`);
			if (result.toolClipping !== undefined) {
				const { originalCharacters, headCharacters, tailCharacters } = result.toolClipping;
				const clipped = `${originalCharacters} characters, head ${headCharacters} + tail ${tailCharacters}`;
				lines.push(`tool output clipped: ${clipped}`);
			}
			return [...lines, "---", result.text].join("\n");
		}
		case "date":
			return result.date;
		case "worker-log":
			return [
				`agent ${result.name} page ${result.page + 1}${result.hasMore ? " (more available)" : " (last)"}`,
				"---",
				result.text,
			].join("\n");
		case "rejected":
			return `rejected (${result.reason}): ${result.message}`;
	}
}
