/** Original-owner evidence shared by reflection and durable knowledge learning. */
import { createHash } from "node:crypto";
import { mergeTextRanges } from "@caupulican/pi-tui";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import {
	appendSessionSnapshot,
	decodeSessionSnapshotPayload,
	getSessionSnapshots,
	type SessionSnapshotCodec,
} from "../session-snapshot.ts";

/**
 * Durable mark that one persisted user message was genuine owner input (typed or sent by the
 * operator through the session's prompt boundary), not an internal prompt, an extension message,
 * a worker report, a tool result or recalled text. The record retains the original words independently
 * of the transformed message it names, so the ledger is rebuilt from the branch after a restart
 * and survives compaction (custom entries are not messages).
 */
export const OWNER_EVIDENCE_CUSTOM_TYPE = "owner_evidence";

export interface OwnerEvidenceRecord {
	/** Full source session identity. Old records without it cannot supply canonical knowledge citations. */
	sessionId?: string;
	/** `<origin session id>/<session entry id>`; older records used a session prefix. */
	sourceId: string;
	entryId: string;
	/**
	 * The owner's ORIGINAL words: what they typed before any input transform, skill or
	 * template expansion rewrote the message the model received. Never reconstructed from the
	 * persisted message content.
	 */
	text: string;
	/** sha256 prefix of `text` as stored; a record whose text does not match on load is dropped. */
	digest: string;
	/** Length of the full original input. Older records may contain only its first 4,000 characters. */
	chars: number;
	createdAt: string;
	/**
	 * Ranges of `text` the owner pasted rather than typed, as the interactive editor reported them: sorted, disjoint,
	 * non-empty. Shown text everywhere the owner's statement is decided. Absent when nothing was pasted, and on records
	 * written before paste provenance or by a programmatic submitter.
	 */
	pasted?: readonly OwnerTextRange[];
}

export interface OwnerEvidenceEntry
	extends Pick<OwnerEvidenceRecord, "sessionId" | "sourceId" | "entryId" | "createdAt" | "text" | "pasted"> {}

/** A range of the owner's original text in UTF-16 code-unit offsets, `end` exclusive. */
export interface OwnerTextRange {
	readonly start: number;
	readonly end: number;
}

/**
 * The owner's original words with the ranges of them they pasted: what every shown-versus-stated decision reads. A
 * record or entry is one; passing only its text would drop the pasted ranges, so the shared functions take this.
 */
export interface OwnerWords {
	readonly text: string;
	readonly pasted?: readonly OwnerTextRange[];
}

/**
 * Ranges in the canonical form a record stores: integral, inside `[0, length)`, non-empty, sorted, with overlapping or
 * touching ranges merged.
 */
export function normalizeOwnerRanges(ranges: readonly OwnerTextRange[] | undefined, length: number): OwnerTextRange[] {
	return mergeTextRanges(
		(ranges ?? [])
			.filter((range) => Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end))
			.map((range) => ({ start: Math.max(0, range.start), end: Math.min(length, range.end) })),
	);
}

/** The part of `ranges` inside `[start, end)` of a text, in offsets of that slice. */
export function sliceOwnerRanges(
	ranges: readonly OwnerTextRange[] | undefined,
	start: number,
	end: number,
): OwnerTextRange[] {
	return normalizeOwnerRanges(
		(ranges ?? []).map((range) => ({ start: range.start - start, end: range.end - start })),
		end - start,
	);
}

/**
 * The words of `[start, end)` of `owner` without surrounding whitespace, with the pasted ranges that fall inside them:
 * how a submission's text transforms (trimming, stripping a prefix) keep its provenance aligned.
 */
export function trimOwnerWords(owner: OwnerWords, start = 0, end = owner.text.length): Required<OwnerWords> {
	const slice = owner.text.slice(start, end);
	const from = start + slice.length - slice.trimStart().length;
	const text = slice.trim();
	return { text, pasted: sliceOwnerRanges(owner.pasted, from, from + text.length) };
}

/** `parts` joined by `separator` into one submission, each part's pasted ranges moved to its place in the result. */
export function joinOwnerWords(parts: readonly OwnerWords[], separator: string): Required<OwnerWords> {
	const pasted: OwnerTextRange[] = [];
	let offset = 0;
	for (const part of parts) {
		for (const range of part.pasted ?? []) pasted.push({ start: range.start + offset, end: range.end + offset });
		offset += part.text.length + separator.length;
	}
	const text = parts.map((part) => part.text).join(separator);
	return { text, pasted: normalizeOwnerRanges(pasted, text.length) };
}

/** Stored ranges must already be canonical: a record is never repaired on load. */
function isCanonicalOwnerRanges(value: unknown, length: number): boolean {
	if (!Array.isArray(value) || value.length === 0) return false;
	let previousEnd = -1;
	for (const range of value) {
		if (!range || typeof range !== "object") return false;
		const { start, end } = range as Record<string, unknown>;
		if (typeof start !== "number" || typeof end !== "number") return false;
		if (!Number.isSafeInteger(start) || start <= previousEnd || start >= end || end > length) return false;
		previousEnd = end;
	}
	return true;
}

const MAX_OWNER_EVIDENCE_ENTRIES = 64;
/** Legacy reflection gets a small preview; collection pages through the original independently. */
export const OWNER_EVIDENCE_PAGE_CHARS = 4_000;

export interface OwnerEvidenceCursor {
	/** Canonical custom-entry identity, so two branches never silently rebind a cursor. */
	recordId: string;
	offset: number;
}

export interface OwnerEvidencePage {
	recordId: string;
	source: Omit<OwnerEvidenceRecord, "text">;
	offset: number;
	text: string;
	/** False for older truncated records; their available prefix cannot acknowledge the full input. */
	completeSource: boolean;
	next?: OwnerEvidenceCursor;
}

/** A bounded collection cursor lists identities and full digests without copying original input. */
export interface OwnerEvidenceDescriptor {
	readonly recordId: string;
	readonly sourceId: string;
	readonly sessionId: string | undefined;
	readonly digest: string;
	readonly createdAt: string;
	readonly chars: number;
	readonly complete: boolean;
}

function evidenceTextDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Shape and integrity: the stored words must carry the digest they were recorded with. */
function isOwnerEvidenceRecord(value: unknown): value is OwnerEvidenceRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		(record.sessionId === undefined ||
			(typeof record.sessionId === "string" &&
				record.sessionId.length > 0 &&
				record.sessionId.length <= 200 &&
				record.sourceId === `${record.sessionId}/${record.entryId}`)) &&
		typeof record.sourceId === "string" &&
		record.sourceId.length > 0 &&
		typeof record.entryId === "string" &&
		typeof record.text === "string" &&
		typeof record.digest === "string" &&
		record.digest === evidenceTextDigest(record.text) &&
		typeof record.chars === "number" &&
		Number.isSafeInteger(record.chars) &&
		record.chars >= record.text.length &&
		typeof record.createdAt === "string" &&
		Number.isFinite(Date.parse(record.createdAt)) &&
		new Date(record.createdAt).toISOString() === record.createdAt &&
		(record.pasted === undefined || isCanonicalOwnerRanges(record.pasted, record.text.length))
	);
}

const OWNER_EVIDENCE_CODEC: SessionSnapshotCodec<OwnerEvidenceRecord, "evidence"> = {
	customType: OWNER_EVIDENCE_CUSTOM_TYPE,
	valueKey: "evidence",
	isValue: isOwnerEvidenceRecord,
	clone: (record) => ({
		...record,
		...(record.pasted ? { pasted: record.pasted.map((range) => ({ start: range.start, end: range.end })) } : {}),
	}),
};

export function getOwnerEvidenceSnapshots(entries: readonly SessionEntry[]): OwnerEvidenceRecord[] {
	return getSessionSnapshots(entries, OWNER_EVIDENCE_CODEC);
}

/**
 * One region of the owner's original text that the owner SHOWED rather than said, in original code-unit offsets
 * (`end` exclusive, delimiters included). `inlineCode` marks a backtick or `<code>` span inside a sentence: how
 * identifiers are written, still shown text for a citation, but not quotation of someone else's words.
 */
export interface OwnerShownRegion {
	readonly start: number;
	readonly end: number;
	readonly inlineCode: boolean;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const SPACE_CHAR = /\s/u;
/** Opening quotation characters and the characters that may close each of them. */
const QUOTE_CLOSERS: Readonly<Record<string, string>> = {
	'"': '"',
	"'": "'",
	"\uff02": "\uff02",
	"\u201c": "\u201d\u201c",
	"\u201e": "\u201c\u201d",
	"\u201f": "\u201d",
	"\u201d": "\u201d",
	"\u2018": "\u2019",
	"\u201a": "\u2018\u2019",
	"\u00ab": "\u00bb",
	"\u00bb": "\u00ab",
	"\u2039": "\u203a",
	"\u203a": "\u2039",
	"\u300c": "\u300d",
	"\u300e": "\u300f",
	"\ufe41": "\ufe42",
	"\ufe43": "\ufe44",
	"\uff62": "\uff63",
};
/** Bracket quotes of scripts written without spaces pair by direction alone. */
const BRACKET_QUOTES = "\u300c\u300d\u300e\u300f\ufe41\ufe42\ufe43\ufe44\uff62\uff63";
/** Guillemets allow typographic spacing inside the quotation. */
const GUILLEMETS = "\u00ab\u00bb\u2039\u203a";
/** Also apostrophes: an unpaired one is a letter, not an open quotation. */
const APOSTROPHES = "'\u2019";
const SHOWN_TAGS = /<(blockquote|q|pre|code)\b[^>]*>/giu;
/** Private use: no letter, digit, space, quotation mark or markup, so pasted text reads as no syntax at all. */
const PASTED_UNIT = String.fromCharCode(0xe000);

/**
 * Every region of the owner's original words that is shown rather than stated: text they pasted (as the editor recorded
 * it, whatever it contains), fenced (``` or ~~~) and indented code blocks, blockquote lines,
 * `<blockquote>`/`<q>`/`<pre>`/`<code>` elements, inline code spans, and quotations in any common style (ASCII, curly,
 * low-9, guillemets, CJK brackets). Computed once on the untrimmed original. Pasted code units are read as a neutral
 * character, so a quotation mark, fence or tag inside a paste never pairs with or extends into typed text. Quotation
 * marks pair by position (an opener follows no letter or digit, a closer precedes none), so a stray `27"` or an escaped
 * `\"` never shifts later quotations into stated text. Unclosed openers, fences and elements extend to the end of the
 * text: every uncertainty resolves to shown.
 */
export function ownerShownRegions(owner: OwnerWords): OwnerShownRegion[] {
	const pasted = normalizeOwnerRanges(owner.pasted, owner.text.length);
	let text = owner.text;
	for (const range of pasted)
		text = text.slice(0, range.start) + PASTED_UNIT.repeat(range.end - range.start) + text.slice(range.end);
	const regions: OwnerShownRegion[] = pasted.map((range) => ({
		start: range.start,
		end: range.end,
		inlineCode: false,
	}));
	const lines: Array<{ start: number; end: number; text: string }> = [];
	for (let start = 0; start <= text.length; ) {
		const newline = text.indexOf("\n", start);
		const end = newline < 0 ? text.length : newline;
		lines.push({ start, end, text: text.slice(start, end).replace(/\r$/, "") });
		if (newline < 0) break;
		start = newline + 1;
	}
	let fence: { marker: string; start: number } | undefined;
	let previousBlank = true;
	let previousIndented = false;
	for (const line of lines) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line.text)?.[1];
		if (fence) {
			if (
				marker &&
				marker[0] === fence.marker[0] &&
				marker.length >= fence.marker.length &&
				!/\S/.test(line.text.slice(line.text.indexOf(marker) + marker.length))
			) {
				regions.push({ start: fence.start, end: line.end, inlineCode: false });
				fence = undefined;
			}
			continue;
		}
		if (marker) {
			fence = { marker, start: line.start };
			previousBlank = false;
			previousIndented = false;
			continue;
		}
		const blank = !/\S/.test(line.text);
		const indented: boolean = !blank && /^( {4}|\t)/.test(line.text) && (previousBlank || previousIndented);
		if (indented || /^ {0,3}>/.test(line.text)) regions.push({ start: line.start, end: line.end, inlineCode: false });
		previousIndented = indented;
		previousBlank = blank;
	}
	if (fence) regions.push({ start: fence.start, end: text.length, inlineCode: false });
	for (const tag of text.matchAll(SHOWN_TAGS)) {
		const close = new RegExp(`</${tag[1]}\\s*>`, "iu");
		const after = tag.index + tag[0].length;
		const found = close.exec(text.slice(after));
		regions.push({
			start: tag.index,
			end: found ? after + found.index + found[0].length : text.length,
			inlineCode: tag[1]!.toLowerCase() === "code",
		});
	}
	const blockMask = shownMask(
		text,
		regions.filter((region) => !region.inlineCode),
	);
	const blocked = (index: number): boolean => blockMask[index] === 1;
	const wordAt = (index: number): boolean => index >= 0 && index < text.length && WORD_CHAR.test(text[index]!);
	const spaceAt = (index: number): boolean => index < 0 || index >= text.length || SPACE_CHAR.test(text[index]!);
	const opens = (index: number): boolean => {
		const char = text[index]!;
		if (BRACKET_QUOTES.includes(char)) return true;
		return !wordAt(index - 1) && (GUILLEMETS.includes(char) || !spaceAt(index + 1));
	};
	const closes = (index: number): boolean => {
		const char = text[index]!;
		if (BRACKET_QUOTES.includes(char)) return true;
		return !wordAt(index + 1) && (GUILLEMETS.includes(char) || !spaceAt(index - 1));
	};
	for (let index = 0; index < text.length; index++) {
		if (blocked(index)) continue;
		const char = text[index]!;
		if (char === "\\") {
			index++;
			continue;
		}
		if (char === "`") {
			let run = 1;
			while (text[index + run] === "`") run++;
			let search = index + run;
			let closing = -1;
			while (search < text.length) {
				const next = text.indexOf("`".repeat(run), search);
				if (next < 0) break;
				let length = run;
				while (text[next + length] === "`") length++;
				if (length === run && text[next - 1] !== "`") {
					closing = next;
					break;
				}
				search = next + length;
			}
			if (closing >= 0) {
				regions.push({ start: index, end: closing + run, inlineCode: true });
				index = closing + run - 1;
			} else index += run - 1;
			continue;
		}
		const closers = QUOTE_CLOSERS[char];
		if (!closers || !opens(index)) continue;
		let closing = -1;
		for (let next = index + 1; next < text.length; next++) {
			if (text[next] === "\\") {
				next++;
				continue;
			}
			if (closers.includes(text[next]!) && !blocked(next) && closes(next)) {
				closing = next;
				break;
			}
		}
		// An unpaired apostrophe-like mark is a letter; any other unpaired opener shows the rest of the text.
		if (closing < 0 && APOSTROPHES.includes(char)) continue;
		const end = closing < 0 ? text.length : closing + 1;
		regions.push({ start: index, end, inlineCode: false });
		index = end - 1;
	}
	return regions.sort((left, right) => left.start - right.start || right.end - left.end);
}

/** One flag per code unit of `text`: 1 inside any of `regions`. */
function shownMask(text: string, regions: readonly OwnerShownRegion[]): Uint8Array {
	const mask = new Uint8Array(text.length);
	for (const region of regions) mask.fill(1, region.start, region.end);
	return mask;
}

/** The original text of `[start, end)` with every shown code unit removed. */
function statedText(text: string, mask: Uint8Array, start: number, end: number): string {
	let result = "";
	for (let index = start; index < end; index++) if (mask[index] !== 1) result += text[index];
	return result;
}

/**
 * Lowercase, plain quotes and single spaces, with each normalized code unit mapped back to the original range that
 * produced it, so a match found on normalized text is tested against regions computed on the untrimmed original.
 */
function normalizeWithOrigins(text: string): { text: string; starts: number[]; ends: number[] } {
	let normalized = "";
	const starts: number[] = [];
	const ends: number[] = [];
	for (let index = 0; index < text.length; ) {
		const point = String.fromCodePoint(text.codePointAt(index)!);
		const end = index + point.length;
		if (SPACE_CHAR.test(point)) {
			if (normalized.length > 0 && !normalized.endsWith(" ")) {
				normalized += " ";
				starts.push(index);
				ends.push(end);
			}
		} else {
			const lowered = point
				.replace(/[\u2018\u2019\u201a\u201b]/u, "'")
				.replace(/[\u201c\u201d\u201e\u201f\u00ab\u00bb\uff02]/u, '"')
				.toLowerCase();
			for (const unit of lowered) {
				normalized += unit;
				for (let count = 0; count < unit.length; count++) {
					starts.push(index);
					ends.push(end);
				}
			}
		}
		index = end;
	}
	while (normalized.endsWith(" ")) {
		normalized = normalized.slice(0, -1);
		starts.pop();
		ends.pop();
	}
	return { text: normalized, starts, ends };
}

/** Where a cited quote sits in the owner's original words; see {@link locateOwnerQuote}. */
export interface OwnerQuoteLocation {
	readonly found: boolean;
	readonly shown: boolean;
	readonly sentence: string;
	readonly stated: string;
	readonly start: number;
	readonly end: number;
}

/** Shown-region masks of one original: every region, and only quotations and blocks (inline code excluded). */
function shownMasks(owner: OwnerWords): { all: Uint8Array; quoted: Uint8Array } {
	const regions = ownerShownRegions(owner);
	return {
		all: shownMask(owner.text, regions),
		quoted: shownMask(
			owner.text,
			regions.filter((region) => !region.inlineCode),
		),
	};
}

function spanIsShown(ownerText: string, masks: { all: Uint8Array; quoted: Uint8Array }, start: number, end: number) {
	return (
		masks.quoted.subarray(start, end).includes(1) || !WORD_CHAR.test(statedText(ownerText, masks.all, start, end))
	);
}

/**
 * Whether `[start, end)` of the owner's original text is text the owner SHOWED rather than said: it overlaps any
 * pasted text, quotation, quoted block or code block, or none of its letters or digits lies outside inline code. A
 * pasted excerpt is evidence of what the owner showed, never automatically of what they believe; this is the host's
 * deterministic half of that judgment. The semantic half stays model work. Inline code inside a stated sentence
 * (`we use \`vitest\``) does not make the sentence shown.
 */
export function isShownSpan(owner: OwnerWords, start: number, end: number): boolean {
	return spanIsShown(owner.text, shownMasks(owner), start, end);
}

/**
 * Where a cited quote sits in the owner's words. Every occurrence is tried; an occurrence that is not shown (see
 * {@link isShownSpan}) wins, the one with the most stated letters first, so a quote that appears inside shown text
 * and also as the owner's own statement is found as stated. `stated` is the chosen occurrence's words without inline
 * code, and `sentence` the stated words of the sentence around it, both normalized, for the explicit/corrective
 * wording check. `start`/`end` are the chosen occurrence's original offsets (-1 when no stated occurrence exists).
 */
export function locateOwnerQuote(owner: OwnerWords, quote: string): OwnerQuoteLocation {
	const ownerText = owner.text;
	const haystack = normalizeWithOrigins(ownerText);
	const needle = normalizeWithOrigins(quote)
		.text.replace(/^["'`]+|["'`.,;:!?]+$/g, "")
		.trim();
	if (needle.length === 0) return { found: false, shown: false, sentence: "", stated: "", start: -1, end: -1 };
	const masks = shownMasks(owner);
	const mask = masks.all;
	let best: { start: number; end: number; stated: string; letters: number } | undefined;
	let found = false;
	for (let index = haystack.text.indexOf(needle); index >= 0; index = haystack.text.indexOf(needle, index + 1)) {
		found = true;
		const start = haystack.starts[index]!;
		const end = haystack.ends[index + needle.length - 1]!;
		if (spanIsShown(ownerText, masks, start, end)) continue;
		const stated = statedText(ownerText, mask, start, end);
		const letters = stated.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
		if (letters > (best?.letters ?? 0)) best = { start, end, stated, letters };
	}
	if (!best) return { found, shown: found, sentence: "", stated: "", start: -1, end: -1 };
	const boundary = (index: number): boolean => /[.!?\n]/.test(ownerText[index]!) && mask[index] !== 1;
	let sentenceStart = best.start;
	while (sentenceStart > 0 && !boundary(sentenceStart - 1)) sentenceStart--;
	let sentenceEnd = best.end;
	while (sentenceEnd < ownerText.length && !boundary(sentenceEnd)) sentenceEnd++;
	return {
		found: true,
		shown: false,
		sentence: normalizeWithOrigins(statedText(ownerText, mask, sentenceStart, sentenceEnd)).text,
		stated: normalizeWithOrigins(best.stated).text,
		start: best.start,
		end: best.end,
	};
}

/** A record's reflection preview: its first page of text, with the pasted ranges inside that page. */
function evidenceEntry(record: OwnerEvidenceRecord): OwnerEvidenceEntry {
	const text = record.text.slice(0, OWNER_EVIDENCE_PAGE_CHARS);
	const pasted = sliceOwnerRanges(record.pasted, 0, text.length);
	return {
		...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
		sourceId: record.sourceId,
		entryId: record.entryId,
		text,
		createdAt: record.createdAt,
		...(pasted.length > 0 ? { pasted } : {}),
	};
}

interface OwnerEvidenceLedgerDeps {
	getSessionManager(): SessionManager;
	warn(message: string): void;
}

/** One branch-bound ledger; only the host's original-input persistence path can append evidence. */
export class OwnerEvidenceLedger {
	private readonly listeners = new Set<(change: "source" | "branch") => void>();
	private readonly deps: OwnerEvidenceLedgerDeps;
	private ownerEvidence: OwnerEvidenceEntry[] | undefined;
	/** Identity index follows the canonical branch; only the text projection is limited to 64 records. */
	private sourceEntries: Set<string> | undefined;
	private records: Array<{ recordId: string; record: OwnerEvidenceRecord; digest: string }> = [];
	private readonly byRecord = new Map<string, number>();
	private readonly bySource = new Map<string, number>();
	private readonly ownerInputOriginals = new WeakMap<AgentMessage, OwnerWords>();
	/**
	 * Sources this process recorded since the session's last completed run. Not rebuilt from the branch: after a
	 * restart or branch change no earlier statement is current, so a destructive request must be stated again.
	 */
	private readonly currentTurn = new Set<string>();

	constructor(deps: OwnerEvidenceLedgerDeps) {
		this.deps = deps;
	}

	/** Listeners only schedule work; they must not throw or mutate the ledger. */
	subscribe(listener: (change: "source" | "branch") => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	invalidate(): void {
		this.ownerEvidence = undefined;
		this.sourceEntries = undefined;
		this.records = [];
		this.byRecord.clear();
		this.bySource.clear();
		this.currentTurn.clear();
		for (const listener of this.listeners) listener("branch");
	}

	/** The session's run ended (not a retry): every statement recorded so far belongs to a past owner turn. */
	endOwnerTurn(): void {
		this.currentTurn.clear();
	}

	/** Whether `sourceId` is owner input recorded during the current run, the turn a tool call answers. */
	isCurrentTurnSource(sourceId: string): boolean {
		return this.currentTurn.has(sourceId);
	}

	/**
	 * Every owner source recorded during the current run, in order: empty when the owner has said nothing in it (a
	 * routine result, CI event or other wake opened it) or no run is active. A source is recorded where its message is
	 * persisted, which is where the run takes it into the model's context, before the model call that reads it; so while
	 * a tool call of the run executes, the context that issued it held every one of them.
	 */
	currentTurnSources(): readonly string[] {
		return [...this.currentTurn];
	}

	/**
	 * The session admitted `message` as the operator's own input; `originalText` is what they submitted and `pasted` the
	 * ranges of it the editor recorded as pasted rather than typed.
	 */
	markOwnerInput(message: AgentMessage, originalText: string, pasted?: readonly OwnerTextRange[]): void {
		const ranges = normalizeOwnerRanges(pasted, originalText.length);
		this.ownerInputOriginals.set(message, { text: originalText, ...(ranges.length > 0 ? { pasted: ranges } : {}) });
	}

	/**
	 * Persistence hook: a message reached durable history under `entryId`. Owner evidence is
	 * recorded exactly here, with the original words; a withdrawn queued message is never
	 * persisted and therefore never becomes evidence. Non-owner messages are ignored.
	 */
	noteOwnerInputPersisted(message: AgentMessage, entryId: string | undefined): void {
		if (!entryId || message.role !== "user") return;
		const original = this.ownerInputOriginals.get(message);
		if (original === undefined || !original.text.trim()) return;
		if (this.recordOwnerEvidence(entryId, original)) this.ownerInputOriginals.delete(message);
	}

	/**
	 * Mark one persisted user message as genuine owner input and return its source id. Called by
	 * the session at the persistence boundary of a prompt that came through its own owner input
	 * path (never for internal, extension, worker, tool or recalled messages).
	 */
	private recordOwnerEvidence(entryId: string, original: OwnerWords): boolean {
		const sessionId = this.deps.getSessionManager().getSessionId();
		const sourceId = `${sessionId}/${entryId}`;
		// Load before appending: a first read that scans the branch must not see this record twice.
		const ledger = this.loadOwnerEvidence();
		if (this.sourceEntries?.has(entryId)) return true;
		// Strictly increasing within the session, so evidence order is total even inside one millisecond.
		let createdAtMs = Date.now();
		const last = ledger.at(-1);
		if (last) {
			const lastMs = Date.parse(last.createdAt);
			if (Number.isFinite(lastMs) && createdAtMs <= lastMs) createdAtMs = lastMs + 1;
		}
		const createdAt = new Date(createdAtMs).toISOString();
		const text = original.text;
		const record: OwnerEvidenceRecord = {
			sessionId,
			sourceId,
			entryId,
			text,
			digest: evidenceTextDigest(text),
			chars: text.length,
			createdAt,
			...(original.pasted ? { pasted: original.pasted } : {}),
		};
		let recordId: string;
		try {
			recordId = appendSessionSnapshot(this.deps.getSessionManager(), OWNER_EVIDENCE_CODEC, record);
		} catch {
			this.deps.warn("Owner evidence could not be recorded durably for this turn.");
			return false;
		}
		this.sourceEntries?.add(entryId);
		this.indexRecord(recordId, record);
		this.currentTurn.add(sourceId);
		ledger.push(evidenceEntry(record));
		if (ledger.length > MAX_OWNER_EVIDENCE_ENTRIES) ledger.splice(0, ledger.length - MAX_OWNER_EVIDENCE_ENTRIES);
		for (const listener of this.listeners) listener("source");
		return true;
	}

	/** The owner evidence this branch knows, oldest first, bounded. */
	listOwnerEvidence(): readonly OwnerEvidenceEntry[] {
		return this.loadOwnerEvidence().map((entry) => ({ ...entry }));
	}

	/**
	 * Read one bounded page from original owner input, oldest first, without the reflection cache's
	 * 64-source limit. A cursor names the exact custom entry and offset; a missing cursor is stale,
	 * never permission to start reading a different branch. No summaries or transformed messages enter.
	 */
	readPage(cursor?: OwnerEvidenceCursor): OwnerEvidencePage | undefined {
		if (cursor && (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0))
			throw new RangeError("Invalid owner evidence cursor");
		this.loadOwnerEvidence();
		const start = cursor ? this.byRecord.get(cursor.recordId) : 0;
		if (start === undefined) throw new Error("Owner evidence cursor is no longer on the active branch");
		for (let index = start; index < this.records.length; index++) {
			const { recordId, record } = this.records[index]!;
			const offset = index === start ? (cursor?.offset ?? 0) : 0;
			if (offset > record.text.length) throw new RangeError("Owner evidence cursor exceeds its original input");
			if (offset === record.text.length) continue;
			const text = record.text.slice(offset, offset + OWNER_EVIDENCE_PAGE_CHARS);
			const { text: _original, ...source } = record;
			return {
				recordId,
				source,
				offset,
				text,
				completeSource: record.chars === record.text.length,
				next: { recordId, offset: offset + text.length },
			};
		}
		return undefined;
	}

	/** Resolve a citation against the actual original input, never a reflection preview. */
	findSource(sourceId: string): OwnerEvidenceRecord | undefined {
		this.loadOwnerEvidence();
		const index = this.bySource.get(sourceId);
		return index === undefined ? undefined : { ...this.records[index]!.record };
	}

	/** Retain the last returned record id at the end; a later append is then visible without rescanning. */
	readSources(after?: string): readonly OwnerEvidenceDescriptor[] {
		this.loadOwnerEvidence();
		const previous = after === undefined ? -1 : this.byRecord.get(after);
		if (previous === undefined) throw new Error("Owner source cursor is no longer on the active branch");
		return this.records.slice(previous + 1, previous + 33).map(({ recordId, record, digest }) => ({
			recordId,
			sourceId: record.sourceId,
			sessionId: record.sessionId,
			digest,
			createdAt: record.createdAt,
			chars: record.chars,
			complete: record.chars === record.text.length,
		}));
	}

	private indexRecord(recordId: string, record: OwnerEvidenceRecord): void {
		this.byRecord.set(recordId, this.records.length);
		this.bySource.set(record.sourceId, this.records.length);
		this.records.push({ recordId, record, digest: createHash("sha256").update(record.text, "utf8").digest("hex") });
	}

	/**
	 * One pass over the branch on first use (then incremental through `recordOwnerEvidence`):
	 * owner marks retain original words alongside their source entry identity, so the
	 * ledger is identical after a reopen and unaffected by compaction.
	 */
	private loadOwnerEvidence(): OwnerEvidenceEntry[] {
		if (this.ownerEvidence) return this.ownerEvidence;
		const records: OwnerEvidenceEntry[] = [];
		const sourceEntries = new Set<string>();
		this.records = [];
		this.byRecord.clear();
		this.bySource.clear();
		const entries = this.deps.getSessionManager().getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]);
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== OWNER_EVIDENCE_CUSTOM_TYPE) continue;
			// The codec verifies shape and the stored digest; a tampered or legacy record is skipped.
			const record = decodeSessionSnapshotPayload(entry.data, OWNER_EVIDENCE_CODEC);
			if (!record || sourceEntries.has(record.entryId)) continue;
			sourceEntries.add(record.entryId);
			this.indexRecord(entry.id, record);
			records.push(evidenceEntry(record));
			if (records.length > MAX_OWNER_EVIDENCE_ENTRIES) records.shift();
		}
		this.sourceEntries = sourceEntries;
		this.ownerEvidence = records;
		return this.ownerEvidence;
	}
}
