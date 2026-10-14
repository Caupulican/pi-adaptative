/**
 * Canonical contracts for ICM's project-wide, append-only conversation.
 *
 * This is the durable conversation domain, not the transcript recall index. Every accepted record
 * receives one permanent integer id; derived summaries and views may name those ids but never
 * replace, renumber or delete their source records.
 */

import { createHash } from "node:crypto";
import { isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";

export const CONTINUOUS_CHAT_SCHEMA_VERSION = 1;
export const CONTINUOUS_CHAT_MAX_TEXT_CHARACTERS = 30_000;
export const CONTINUOUS_CHAT_MAX_SOURCE_KEY_CHARACTERS = 1_024;
export const CONTINUOUS_CHAT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export type ContinuousChatMessageKind = "user" | "pi" | "tool" | "echo" | "work" | "note";

export interface ContinuousChatSource {
	sessionId: string;
	entryId: string;
	unit: number;
}

export interface ContinuousChatImageRef {
	digest: string;
	mimeType: string;
	bytes: number;
}

export interface ContinuousChatToolClipping {
	originalCharacters: number;
	headCharacters: number;
	tailCharacters: number;
}

export interface ContinuousChatRecord {
	schemaVersion: typeof CONTINUOUS_CHAT_SCHEMA_VERSION;
	id: number;
	kind: ContinuousChatMessageKind;
	date: string;
	text: string;
	textBytes: number;
	sourceKey: string;
	source?: ContinuousChatSource;
	images?: ContinuousChatImageRef[];
	toolClipping?: ContinuousChatToolClipping;
}

export interface ContinuousChatImageInput {
	mimeType: string;
	data: string;
}

export interface ContinuousChatAppendInput {
	kind: ContinuousChatMessageKind;
	date: string;
	text: string;
	sourceKey: string;
	source?: Omit<ContinuousChatSource, "unit">;
	images?: ContinuousChatImageInput[];
}

export interface ContinuousChatAppendUnit {
	kind: ContinuousChatMessageKind;
	date: string;
	text: string;
	textBytes: number;
	sourceKey: string;
	source?: ContinuousChatSource;
	images?: ContinuousChatImageInput[];
	toolClipping?: ContinuousChatToolClipping;
}

export interface ContinuousChatAppendResult {
	revision: number;
	records: ContinuousChatRecord[];
	deduplicated: boolean;
}

export interface ContinuousChatRoot {
	schemaVersion: typeof CONTINUOUS_CHAT_SCHEMA_VERSION;
	revision: number;
	nextId: number;
	lastSegment?: string;
	lastSegmentBytes: number;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MESSAGE_KINDS: ReadonlySet<string> = new Set(["user", "pi", "tool", "echo", "work", "note"]);

function requireTimestamp(value: string): void {
	const match = TIMESTAMP_PATTERN.exec(value);
	if (match === null) throw new TypeError(`Invalid continuous-chat timestamp: ${value}`);
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
	const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
	if (
		daysInMonth === undefined ||
		day < 1 ||
		day > daysInMonth ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 23 ||
		offsetMinute > 59 ||
		Number.isNaN(Date.parse(value))
	) {
		throw new TypeError(`Invalid continuous-chat timestamp: ${value}`);
	}
}

/** Daily segment name for an RFC 3339 message timestamp, preserving its stated calendar day. */
export function continuousChatDay(timestamp: string): string {
	requireTimestamp(timestamp);
	const day = timestamp.slice(0, 10);
	if (!DAY_PATTERN.test(day)) throw new TypeError(`Invalid continuous-chat timestamp: ${timestamp}`);
	return day;
}

function requireSourceKey(value: string): void {
	if (value.length === 0 || value.length > CONTINUOUS_CHAT_MAX_SOURCE_KEY_CHARACTERS || /[\r\n\0]/.test(value)) {
		throw new TypeError("Continuous-chat sourceKey must be a bounded, non-empty single line.");
	}
}

function codePointLength(text: string): number {
	let length = 0;
	for (const _character of text) length++;
	return length;
}

/** Split without trimming or splitting a Unicode code point. Concatenation reproduces the input. */
export function splitContinuousChatText(text: string, maxCharacters = CONTINUOUS_CHAT_MAX_TEXT_CHARACTERS): string[] {
	if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
		throw new RangeError("Continuous-chat text chunk size must be a positive safe integer.");
	}
	if (text.length === 0) return [""];
	const chunks: string[] = [];
	let chunk = "";
	let characters = 0;
	for (const character of text) {
		if (characters === maxCharacters) {
			chunks.push(chunk);
			chunk = "";
			characters = 0;
		}
		chunk += character;
		characters++;
	}
	chunks.push(chunk);
	return chunks;
}

/** Tool output alone is clipped, keeping equal head/tail budgets and explicit omission metadata. */
export function clipContinuousChatToolText(text: string): {
	text: string;
	toolClipping?: ContinuousChatToolClipping;
} {
	const originalCharacters = codePointLength(text);
	if (originalCharacters <= CONTINUOUS_CHAT_MAX_TEXT_CHARACTERS) return { text };
	const headCharacters = Math.floor(CONTINUOUS_CHAT_MAX_TEXT_CHARACTERS / 2);
	const tailCharacters = CONTINUOUS_CHAT_MAX_TEXT_CHARACTERS - headCharacters;
	const characters = Array.from(text);
	return {
		text: `${characters.slice(0, headCharacters).join("")}${characters.slice(-tailCharacters).join("")}`,
		toolClipping: { originalCharacters, headCharacters, tailCharacters },
	};
}

/** Normalize one append command into the exact immutable records it will allocate ids for. */
export function normalizeContinuousChatAppend(input: ContinuousChatAppendInput): ContinuousChatAppendUnit[] {
	if (!MESSAGE_KINDS.has(input.kind)) throw new TypeError(`Invalid continuous-chat kind: ${input.kind}`);
	requireTimestamp(input.date);
	requireSourceKey(input.sourceKey);
	if (input.source !== undefined) {
		requireSourceKey(input.source.sessionId);
		requireSourceKey(input.source.entryId);
	}
	for (const image of input.images ?? []) {
		if (!MIME_TYPE_PATTERN.test(image.mimeType)) throw new TypeError(`Invalid image MIME type: ${image.mimeType}`);
		if (image.data.length === 0 || !BASE64_PATTERN.test(image.data)) {
			throw new TypeError("Continuous-chat image data must be non-empty canonical base64.");
		}
		const bytes = Buffer.from(image.data, "base64").byteLength;
		if (bytes > CONTINUOUS_CHAT_MAX_IMAGE_BYTES)
			throw new RangeError("Continuous-chat image exceeds its size limit.");
	}

	const textUnits: Array<{ text: string; toolClipping?: ContinuousChatToolClipping }> =
		input.kind === "echo"
			? [clipContinuousChatToolText(input.text)]
			: splitContinuousChatText(input.text).map((text) => ({ text }));
	return textUnits.map((unit, index) => {
		const sourceKey = `${input.sourceKey}:${index}`;
		requireSourceKey(sourceKey);
		const normalized: ContinuousChatAppendUnit = {
			kind: input.kind,
			date: input.date,
			text: unit.text,
			textBytes: Buffer.byteLength(unit.text, "utf8"),
			sourceKey,
		};
		if (input.source !== undefined) normalized.source = { ...input.source, unit: index };
		if (index === 0 && input.images !== undefined && input.images.length > 0) normalized.images = input.images;
		if ("toolClipping" in unit && unit.toolClipping !== undefined) normalized.toolClipping = unit.toolClipping;
		return normalized;
	});
}

export function continuousChatImageDigest(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function parseImageRef(value: unknown): ContinuousChatImageRef | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (typeof value.digest !== "string" || !DIGEST_PATTERN.test(value.digest)) return undefined;
	if (typeof value.mimeType !== "string" || !MIME_TYPE_PATTERN.test(value.mimeType)) return undefined;
	if (!isNonNegativeSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > CONTINUOUS_CHAT_MAX_IMAGE_BYTES) {
		return undefined;
	}
	return { digest: value.digest, mimeType: value.mimeType, bytes: value.bytes };
}

export function parseContinuousChatRecord(value: unknown): ContinuousChatRecord | undefined {
	if (!isPlainRecord(value) || value.schemaVersion !== CONTINUOUS_CHAT_SCHEMA_VERSION) return undefined;
	if (!isNonNegativeSafeInteger(value.id)) return undefined;
	if (typeof value.kind !== "string" || !MESSAGE_KINDS.has(value.kind)) return undefined;
	if (typeof value.date !== "string") return undefined;
	try {
		requireTimestamp(value.date);
	} catch {
		return undefined;
	}
	if (
		typeof value.text !== "string" ||
		codePointLength(value.text) > CONTINUOUS_CHAT_MAX_TEXT_CHARACTERS ||
		!isNonNegativeSafeInteger(value.textBytes)
	) {
		return undefined;
	}
	if (Buffer.byteLength(value.text, "utf8") !== value.textBytes) return undefined;
	if (typeof value.sourceKey !== "string") return undefined;
	try {
		requireSourceKey(value.sourceKey);
	} catch {
		return undefined;
	}

	const record: ContinuousChatRecord = {
		schemaVersion: CONTINUOUS_CHAT_SCHEMA_VERSION,
		id: value.id,
		kind: value.kind as ContinuousChatMessageKind,
		date: value.date,
		text: value.text,
		textBytes: value.textBytes,
		sourceKey: value.sourceKey,
	};
	if (value.source !== undefined) {
		if (!isPlainRecord(value.source)) return undefined;
		if (typeof value.source.sessionId !== "string" || typeof value.source.entryId !== "string") return undefined;
		if (!isNonNegativeSafeInteger(value.source.unit)) return undefined;
		try {
			requireSourceKey(value.source.sessionId);
			requireSourceKey(value.source.entryId);
		} catch {
			return undefined;
		}
		record.source = {
			sessionId: value.source.sessionId,
			entryId: value.source.entryId,
			unit: value.source.unit,
		};
	}
	if (value.images !== undefined) {
		if (!Array.isArray(value.images)) return undefined;
		const images = value.images.map(parseImageRef);
		if (images.some((image) => image === undefined)) return undefined;
		record.images = images as ContinuousChatImageRef[];
	}
	if (value.toolClipping !== undefined) {
		if (!isPlainRecord(value.toolClipping)) return undefined;
		const { originalCharacters, headCharacters, tailCharacters } = value.toolClipping;
		if (
			!isNonNegativeSafeInteger(originalCharacters) ||
			!isNonNegativeSafeInteger(headCharacters) ||
			!isNonNegativeSafeInteger(tailCharacters) ||
			headCharacters + tailCharacters !== CONTINUOUS_CHAT_MAX_TEXT_CHARACTERS ||
			originalCharacters <= CONTINUOUS_CHAT_MAX_TEXT_CHARACTERS
		) {
			return undefined;
		}
		record.toolClipping = { originalCharacters, headCharacters, tailCharacters };
	}
	return record;
}

export function parseContinuousChatRoot(value: unknown): ContinuousChatRoot | undefined {
	if (!isPlainRecord(value) || value.schemaVersion !== CONTINUOUS_CHAT_SCHEMA_VERSION) return undefined;
	if (!isNonNegativeSafeInteger(value.revision) || !isNonNegativeSafeInteger(value.nextId)) {
		return undefined;
	}
	if (!isNonNegativeSafeInteger(value.lastSegmentBytes)) return undefined;
	if (
		value.lastSegment !== undefined &&
		(typeof value.lastSegment !== "string" || !DAY_PATTERN.test(value.lastSegment))
	) {
		return undefined;
	}
	return {
		schemaVersion: CONTINUOUS_CHAT_SCHEMA_VERSION,
		revision: value.revision,
		nextId: value.nextId,
		lastSegment: value.lastSegment,
		lastSegmentBytes: value.lastSegmentBytes,
	};
}
