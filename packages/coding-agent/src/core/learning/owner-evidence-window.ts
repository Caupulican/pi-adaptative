/** Deterministic source-bound views. Windows never create new owner observations. */
import { createHash } from "node:crypto";
import { strictCanonicalDigest } from "../steering/canonical.ts";
import type { OwnerEvidenceRecord } from "./owner-evidence-ledger.ts";

export const OWNER_EVIDENCE_CORE_CHARS = 8_000;
const CONTEXT_CHARS = 2_000;
const sourceDigests = new WeakMap<OwnerEvidenceRecord, { text: string; digest: string }>();
export interface OwnerEvidenceWindow {
	readonly id: string;
	readonly sourceId: string;
	readonly sourceDigest: string;
	readonly sourceChars: number;
	readonly coreStart: number;
	readonly coreEnd: number;
	readonly shownStart: number;
	readonly shownEnd: number;
	readonly text: string;
}

function boundary(text: string, offset: number): number {
	if (
		offset > 0 &&
		offset < text.length &&
		/[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
		/[\uDC00-\uDFFF]/.test(text[offset]!)
	)
		return offset - 1;
	return offset;
}

/** Offsets count UTF-16 code units; every core and context boundary preserves surrogate pairs. */
export function ownerEvidenceWindow(source: OwnerEvidenceRecord, start: number, end: number): OwnerEvidenceWindow {
	if (
		source.chars !== source.text.length ||
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end <= start ||
		end > source.chars
	)
		throw new Error("A source window requires complete evidence and valid bounds");
	const coreStart = boundary(source.text, start);
	const coreEnd = boundary(source.text, end);
	if (coreStart !== start || coreEnd !== end) throw new Error("Source core splits a surrogate pair");
	const shownStart = boundary(source.text, Math.max(0, start - CONTEXT_CHARS));
	const shownEnd = boundary(source.text, Math.min(source.chars, end + CONTEXT_CHARS));
	let cached = sourceDigests.get(source);
	if (!cached || cached.text !== source.text) {
		cached = { text: source.text, digest: createHash("sha256").update(source.text, "utf8").digest("hex") };
		sourceDigests.set(source, cached);
	}
	const sourceDigest = cached.digest;
	const identity = {
		sourceId: source.sourceId,
		sourceDigest,
		sourceChars: source.chars,
		coreStart,
		coreEnd,
		shownStart,
		shownEnd,
	};
	return {
		...identity,
		id: strictCanonicalDigest({ version: 1, ...identity }),
		text: source.text.slice(shownStart, shownEnd),
	};
}

export function nextOwnerEvidenceWindow(source: OwnerEvidenceRecord, start = 0): OwnerEvidenceWindow | undefined {
	if (start === source.chars) return undefined;
	return ownerEvidenceWindow(
		source,
		start,
		boundary(source.text, Math.min(source.chars, start + OWNER_EVIDENCE_CORE_CHARS)),
	);
}

export function splitOwnerEvidenceWindow(
	source: OwnerEvidenceRecord,
	window: OwnerEvidenceWindow,
): readonly [OwnerEvidenceWindow, OwnerEvidenceWindow] {
	const middle = boundary(source.text, Math.floor((window.coreStart + window.coreEnd) / 2));
	if (middle <= window.coreStart || middle >= window.coreEnd)
		throw new Error("Source core cannot be subdivided further");
	return [ownerEvidenceWindow(source, window.coreStart, middle), ownerEvidenceWindow(source, middle, window.coreEnd)];
}
