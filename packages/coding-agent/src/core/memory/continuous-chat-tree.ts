/** Exact binary summary tree used by the permanent ICM chat. */

import { isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";
import { type ContinuousChatRecord, continuousChatDay } from "./continuous-chat-contracts.ts";

/** Compaction target. After five corrections the reference keeps the shortest reply even if slightly over. */
export const CONTINUOUS_CHAT_NODE_TARGET_BYTES = 512;
/** Bounded interpretation of the reference's "a few bytes over is fine" exception. */
export const CONTINUOUS_CHAT_NODE_MAX_BYTES = CONTINUOUS_CHAT_NODE_TARGET_BYTES + 16;
export const CONTINUOUS_CHAT_TREE_SCHEMA_VERSION = 1;

export interface ContinuousChatNodeCoordinate {
	level: number;
	ordinal: number;
}

export interface ContinuousChatTreeNode extends ContinuousChatNodeCoordinate {
	schemaVersion: typeof CONTINUOUS_CHAT_TREE_SCHEMA_VERSION;
	text: string;
	size: number;
	date: string;
	children?: [ContinuousChatNodeCoordinate, ContinuousChatNodeCoordinate];
}

export function continuousChatNodeMessageCount(level: number): number {
	if (!isNonNegativeSafeInteger(level) || level > 52) throw new RangeError("Invalid continuous-chat node level.");
	const count = 2 ** level;
	if (!Number.isSafeInteger(count)) throw new RangeError("Continuous-chat node coverage exceeds safe integers.");
	return count;
}

export function continuousChatNodeFirstMessage(coordinate: ContinuousChatNodeCoordinate): number {
	if (!isNonNegativeSafeInteger(coordinate.ordinal)) throw new RangeError("Invalid continuous-chat node ordinal.");
	const first = coordinate.ordinal * continuousChatNodeMessageCount(coordinate.level);
	if (!Number.isSafeInteger(first)) throw new RangeError("Continuous-chat node coordinate exceeds safe integers.");
	return first;
}

export function continuousChatNodeKey(coordinate: ContinuousChatNodeCoordinate): string {
	return `${coordinate.level}:${coordinate.ordinal}`;
}

export function continuousChatNodeLabel(coordinate: ContinuousChatNodeCoordinate): string {
	return `${continuousChatNodeFirstMessage(coordinate)}+${continuousChatNodeMessageCount(coordinate.level)}`;
}

export function continuousChatParentCoordinate(
	left: ContinuousChatNodeCoordinate,
	right: ContinuousChatNodeCoordinate,
): ContinuousChatNodeCoordinate | undefined {
	if (left.level !== right.level || left.ordinal % 2 !== 0 || right.ordinal !== left.ordinal + 1) return undefined;
	return { level: left.level + 1, ordinal: left.ordinal / 2 };
}

/** Model input for a message leaf. It is also the leaf itself when it already fits. */
export function renderContinuousChatLeaf(record: ContinuousChatRecord): string {
	return `${record.kind}: ${record.text}`;
}

export function createContinuousChatLeaf(record: ContinuousChatRecord, summary?: string): ContinuousChatTreeNode {
	const source = renderContinuousChatLeaf(record);
	const text = summary ?? source;
	if (summary === undefined && Buffer.byteLength(source, "utf8") > CONTINUOUS_CHAT_NODE_TARGET_BYTES) {
		throw new RangeError("An overlong message leaf requires a summary.");
	}
	return createContinuousChatTreeNode({
		level: 0,
		ordinal: record.id,
		text,
		date: record.date,
	});
}

export function createContinuousChatParent(
	left: ContinuousChatTreeNode,
	right: ContinuousChatTreeNode,
	text: string,
): ContinuousChatTreeNode {
	const coordinate = continuousChatParentCoordinate(left, right);
	if (coordinate === undefined)
		throw new TypeError("Continuous-chat parent children must be adjacent aligned siblings.");
	return createContinuousChatTreeNode({
		...coordinate,
		text,
		date: left.date,
		children: [
			{ level: left.level, ordinal: left.ordinal },
			{ level: right.level, ordinal: right.ordinal },
		],
	});
}

/** Adjacent short child lines need no model call when their exact join still fits. */
export function createContinuousChatParentWithoutCall(
	left: ContinuousChatTreeNode,
	right: ContinuousChatTreeNode,
): ContinuousChatTreeNode | undefined {
	const text = `${left.text}\n${right.text}`;
	if (Buffer.byteLength(text, "utf8") > CONTINUOUS_CHAT_NODE_TARGET_BYTES) return undefined;
	return createContinuousChatParent(left, right, text);
}

function createContinuousChatTreeNode(input: {
	level: number;
	ordinal: number;
	text: string;
	date: string;
	children?: [ContinuousChatNodeCoordinate, ContinuousChatNodeCoordinate];
}): ContinuousChatTreeNode {
	continuousChatNodeFirstMessage(input);
	continuousChatDay(input.date);
	const size = Buffer.byteLength(input.text, "utf8");
	if (size > CONTINUOUS_CHAT_NODE_MAX_BYTES) {
		throw new RangeError(`Continuous-chat node exceeds ${CONTINUOUS_CHAT_NODE_MAX_BYTES} UTF-8 bytes.`);
	}
	const node: ContinuousChatTreeNode = {
		schemaVersion: CONTINUOUS_CHAT_TREE_SCHEMA_VERSION,
		level: input.level,
		ordinal: input.ordinal,
		text: input.text,
		size,
		date: input.date,
	};
	if (input.children !== undefined) node.children = input.children;
	return node;
}

export function parseContinuousChatNodeCoordinate(value: unknown): ContinuousChatNodeCoordinate | undefined {
	if (!isPlainRecord(value) || !isNonNegativeSafeInteger(value.level) || !isNonNegativeSafeInteger(value.ordinal)) {
		return undefined;
	}
	const coordinate = { level: value.level, ordinal: value.ordinal };
	try {
		continuousChatNodeFirstMessage(coordinate);
	} catch {
		return undefined;
	}
	return coordinate;
}

export function parseContinuousChatTreeNode(value: unknown): ContinuousChatTreeNode | undefined {
	if (!isPlainRecord(value) || value.schemaVersion !== CONTINUOUS_CHAT_TREE_SCHEMA_VERSION) return undefined;
	const coordinate = parseContinuousChatNodeCoordinate(value);
	if (coordinate === undefined || typeof value.text !== "string" || typeof value.date !== "string") return undefined;
	try {
		continuousChatDay(value.date);
	} catch {
		return undefined;
	}
	if (!isNonNegativeSafeInteger(value.size) || Buffer.byteLength(value.text, "utf8") !== value.size) return undefined;
	if (value.size > CONTINUOUS_CHAT_NODE_MAX_BYTES) return undefined;
	const node: ContinuousChatTreeNode = {
		schemaVersion: CONTINUOUS_CHAT_TREE_SCHEMA_VERSION,
		...coordinate,
		text: value.text,
		size: value.size,
		date: value.date,
	};
	if (value.children !== undefined) {
		if (!Array.isArray(value.children) || value.children.length !== 2) return undefined;
		const left = parseContinuousChatNodeCoordinate(value.children[0]);
		const right = parseContinuousChatNodeCoordinate(value.children[1]);
		if (left === undefined || right === undefined) return undefined;
		const parent = continuousChatParentCoordinate(left, right);
		if (parent === undefined || parent.level !== node.level || parent.ordinal !== node.ordinal) return undefined;
		node.children = [left, right];
	} else if (node.level !== 0) {
		return undefined;
	}
	return node;
}

export function renderContinuousChatViewLine(node: ContinuousChatTreeNode): string {
	return `${continuousChatNodeLabel(node)}|${node.text.replaceAll(/\r?\n/g, " ")}`;
}
