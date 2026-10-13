/**
 * Domain commands behind the `zoom` and `date` tools of the ICM conversation. No file access: every read goes
 * through the ports declared here. `readMessageDate` yields the exact persisted RFC 3339 timestamp.
 */

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
	continuousChatNodeLabel,
	continuousChatParentCoordinate,
	renderContinuousChatViewLine,
} from "./continuous-chat-tree.ts";

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

/** Committed tree nodes, logged messages and their images. `ContinuousChatStore` satisfies it structurally. */
export interface ContinuousChatNavigationSource {
	readNode(coordinate: ContinuousChatNodeCoordinate): Promise<ContinuousChatTreeNode | undefined>;
	readMessageById(id: number): Promise<ContinuousChatRecord | undefined>;
	readMessageDate(id: number): Promise<string | undefined>;
	readImage(ref: ContinuousChatImageRef): Promise<Buffer>;
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
	| "not-power-of-two"
	| "misaligned"
	| "out-of-range"
	| "not-summarized"
	| "incomplete"
	| "not-found"
	| "page-out-of-range"
	| "worker-log-unavailable";

/** Outcome of a command: two child lines, one message page, a date, or one worker-log page. */
export type ContinuousChatNavigationResult =
	| { status: "children"; id: number; n: number; lines: [string, string] }
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
		const problem = workerNameProblem(id);
		if (problem !== undefined) return invalidArguments(problem);
		return { tool: "zoom", kind: "worker", name: id, page };
	}
	if (typeof id !== "number" || !isNonNegativeSafeInteger(id)) {
		return invalidArguments("zoom id must be a non-negative safe integer message id or an agent name.");
	}
	const n = args.n;
	if (!isNonNegativeSafeInteger(n) || n === 0) {
		return invalidArguments("zoom with a message id requires n, a positive safe integer.");
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
	): Promise<ContinuousChatNavigationResult> {
		if (command.tool === "date") return this.lookupDate(command.id, signal);
		if (command.kind === "worker") return this.zoomWorker(command.name, command.page, signal);
		if (command.n === 1) return this.zoomMessage(command.id, command.page, signal);
		return this.zoomNode(command.id, command.n, command.page, signal);
	}

	private async lookupDate(id: number, signal?: AbortSignal): Promise<ContinuousChatNavigationResult> {
		const date = await this.source.readMessageDate(id);
		signal?.throwIfAborted();
		if (date === undefined) return rejected("not-found", `No message ${id}.`);
		return { status: "date", id, date };
	}

	private async zoomMessage(id: number, page: number, signal?: AbortSignal): Promise<ContinuousChatNavigationResult> {
		const record = await this.source.readMessageById(id);
		signal?.throwIfAborted();
		if (record === undefined) return rejected("not-found", `No message ${id}.`);
		const textPage = pageContinuousChatText([record.text], this.pageBytes, page);
		const imagePages: ContinuousChatImageRef[][] = [];
		for (const image of record.images ?? []) {
			let current = imagePages.at(-1);
			const currentBytes = current?.reduce((total, item) => total + item.bytes, 0) ?? 0;
			if (
				current === undefined ||
				current.length === CONTINUOUS_CHAT_ZOOM_IMAGE_MAX_COUNT ||
				currentBytes + image.bytes > this.imageBytes
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

	private async zoomNode(
		id: number,
		n: number,
		page: number,
		signal?: AbortSignal,
	): Promise<ContinuousChatNavigationResult> {
		const level = Math.round(Math.log2(n));
		if (2 ** level !== n) return rejected("not-power-of-two", `n must be a power of two, got ${n}.`);
		if (id % n !== 0) return rejected("misaligned", `id ${id} is not a multiple of n ${n}.`);
		if (!Number.isSafeInteger(id + n - 1)) {
			return rejected("out-of-range", `Line ${id}+${n} exceeds the safe message-id range.`);
		}
		const coordinate = { level, ordinal: id / n };
		const label = continuousChatNodeLabel(coordinate);
		const node = await this.source.readNode(coordinate);
		signal?.throwIfAborted();
		if (node === undefined) {
			const lastDate = await this.source.readMessageDate(id + n - 1);
			signal?.throwIfAborted();
			if (lastDate === undefined) {
				return rejected("out-of-range", `Messages ${id} to ${id + n - 1} are not all logged.`);
			}
			return rejected("not-summarized", `Line ${label} is not summarized yet.`);
		}
		if (page !== 0) return rejected("page-out-of-range", `Line ${label} has no pages; page must be 0.`);
		const children = node.children;
		if (children === undefined) return rejected("incomplete", `Line ${label} has no children.`);
		// The parent of two adjacent aligned siblings is exact: it equals this line only when the children are
		// {level-1, 2*ordinal} and {level-1, 2*ordinal+1}.
		const parent = continuousChatParentCoordinate(children[0], children[1]);
		if (parent === undefined || parent.level !== level || parent.ordinal !== coordinate.ordinal) {
			return rejected("incomplete", `Line ${label} does not cover its two children.`);
		}
		const left = await this.source.readNode(children[0]);
		signal?.throwIfAborted();
		const right = await this.source.readNode(children[1]);
		signal?.throwIfAborted();
		if (left === undefined || right === undefined) {
			return rejected("incomplete", `Line ${label} is missing a child line.`);
		}
		return {
			status: "children",
			id,
			n,
			lines: [renderContinuousChatViewLine(left), renderContinuousChatViewLine(right)],
		};
	}

	private async zoomWorker(name: string, page: number, signal?: AbortSignal): Promise<ContinuousChatNavigationResult> {
		if (this.workerLogs === undefined) {
			return rejected("worker-log-unavailable", "Agent chat logs are not available.");
		}
		const reply = await this.workerLogs.readPage(name, page, this.pageBytes);
		signal?.throwIfAborted();
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
		case "children":
			return result.lines.join("\n");
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
