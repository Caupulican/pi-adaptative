import { tokenize } from "../tools/skill-audit.ts";
import {
	formatTranscriptSourceHandle,
	type TranscriptSearchHit,
	type TranscriptSourceSpan,
} from "./transcript-memory-contracts.ts";

/** One span handed to the index: bounded metadata plus the exact captured text. */
export interface IndexableSpan {
	span: TranscriptSourceSpan;
	text: string;
}

export interface TranscriptIndexQueryOptions {
	k?: number;
	minScore?: number;
	maxSnippetChars?: number;
	/** Include spans on side branches. Default: selected lineage only. */
	includeAlternateBranches?: boolean;
	/** Include the current session's own spans. Default false: they are already in context. */
	includeCurrentSession?: boolean;
}

interface IndexedSpan {
	id: number;
	sessionId: string;
	span: TranscriptSourceSpan;
	text: string;
	/** Epoch milliseconds of the span timestamp; -Infinity when absent or unparseable. */
	time: number;
}

interface SessionBucket {
	current: boolean;
	spans: Map<string, IndexedSpan>;
}

function spanKey(span: TranscriptSourceSpan): string {
	return `${span.ref.entryId}\u0000${span.ref.part}`;
}

function spanTime(span: TranscriptSourceSpan): number {
	if (span.timestamp === undefined) return Number.NEGATIVE_INFINITY;
	const time = Date.parse(span.timestamp);
	return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/**
 * Lowercase with a guaranteed one-to-one index mapping onto `text`. A few code points change length
 * when lowercased; snippet windows are positions in the original text, so those stay as they are.
 */
function lowerWithStableIndices(text: string): string {
	const lower = text.toLowerCase();
	if (lower.length === text.length) return lower;
	return Array.from(text, (character) => {
		const lowered = character.toLowerCase();
		return lowered.length === character.length ? lowered : character;
	}).join("");
}

function buildSnippet(text: string, queryTokens: readonly string[], maxSnippetChars: number): string {
	const lowerText = lowerWithStableIndices(text);
	// Find matching indices of query tokens in the text (case-insensitive).
	const matchIndices: number[] = [];
	for (const token of queryTokens) {
		let pos = lowerText.indexOf(token);
		while (pos !== -1) {
			matchIndices.push(pos);
			pos = lowerText.indexOf(token, pos + 1);
		}
	}

	let bestStart = 0;
	let bestEnd = Math.min(text.length, maxSnippetChars);

	if (matchIndices.length > 0) {
		matchIndices.sort((a, b) => a - b);
		let maxMatchesInWindow = 0;

		// Candidate windows are derived from ascending centers, so their start and
		// end are both non-decreasing: two monotone pointers count the matches per
		// window instead of rescanning every index for every center, which was
		// quadratic in match count (a query token dense in one span).
		let lo = 0;
		let hi = 0;
		for (const center of matchIndices) {
			let start = Math.max(0, center - Math.floor(maxSnippetChars / 2));
			const end = Math.min(text.length, start + maxSnippetChars);
			if (end - start < maxSnippetChars && start > 0) {
				start = Math.max(0, end - maxSnippetChars);
			}

			while (lo < matchIndices.length && (matchIndices[lo] ?? Number.POSITIVE_INFINITY) < start) lo++;
			if (hi < lo) hi = lo;
			while (hi < matchIndices.length && (matchIndices[hi] ?? Number.POSITIVE_INFINITY) < end) hi++;
			const matches = hi - lo;

			if (matches > maxMatchesInWindow) {
				maxMatchesInWindow = matches;
				bestStart = start;
				bestEnd = end;
			}
		}
	}

	const prefix = bestStart > 0 ? "..." : "";
	const suffix = bestEnd < text.length ? "..." : "";
	return prefix + text.slice(bestStart, bestEnd) + suffix;
}

/**
 * Inverted index over captured source spans. A hit always names one span, so every result resolves
 * to an exact source; the snippet is only a display window into that span's text.
 */
export class TranscriptIndex {
	private nextId = 0;
	private readonly postings = new Map<string, Set<number>>();
	private readonly spansById = new Map<number, IndexedSpan>();
	private readonly sessions = new Map<string, SessionBucket>();

	/**
	 * Replace one session's spans. Spans whose entry, part and digest are unchanged keep their postings
	 * (a lineage relabel only swaps the stored span); everything else is added or removed.
	 */
	replaceSession(sessionId: string, spans: Iterable<IndexableSpan>, options: { current: boolean }): void {
		const previous = this.sessions.get(sessionId)?.spans ?? new Map<string, IndexedSpan>();
		const next = new Map<string, IndexedSpan>();
		for (const { span, text } of spans) {
			const key = spanKey(span);
			const existing = previous.get(key);
			if (existing && existing.span.ref.digest === span.ref.digest) {
				existing.span = span;
				next.set(key, existing);
				previous.delete(key);
				continue;
			}
			next.set(key, this.addSpan(sessionId, span, text));
		}
		for (const stale of previous.values()) this.removeSpan(stale);
		this.sessions.set(sessionId, { current: options.current, spans: next });
	}

	removeSession(sessionId: string): void {
		const bucket = this.sessions.get(sessionId);
		if (!bucket) return;
		for (const indexed of bucket.spans.values()) this.removeSpan(indexed);
		this.sessions.delete(sessionId);
	}

	hasSession(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	query(queryText: string, opts?: TranscriptIndexQueryOptions): TranscriptSearchHit[] {
		const k = opts?.k ?? 5;
		const minScore = opts?.minScore ?? 0.34;
		const maxSnippetChars = opts?.maxSnippetChars ?? 600;
		const includeAlternate = opts?.includeAlternateBranches === true;
		const includeCurrent = opts?.includeCurrentSession === true;

		const queryTokens = tokenize(queryText);
		if (queryTokens.length === 0 || this.spansById.size === 0) return [];

		const matched = new Map<number, number>();
		for (const token of queryTokens) {
			const ids = this.postings.get(token);
			if (!ids) continue;
			for (const id of ids) matched.set(id, (matched.get(id) ?? 0) + 1);
		}

		const candidates: Array<{ indexed: IndexedSpan; score: number }> = [];
		for (const [id, count] of matched) {
			const score = count / queryTokens.length;
			if (score <= minScore) continue;
			const indexed = this.spansById.get(id);
			if (!indexed) continue;
			if (indexed.span.lineage === "alternate" && !includeAlternate) continue;
			if (!includeCurrent && this.sessions.get(indexed.sessionId)?.current) continue;
			candidates.push({ indexed, score });
		}

		candidates.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			if (right.indexed.time !== left.indexed.time) return right.indexed.time > left.indexed.time ? 1 : -1;
			const leftHandle = formatTranscriptSourceHandle(left.indexed.span.ref);
			const rightHandle = formatTranscriptSourceHandle(right.indexed.span.ref);
			return leftHandle < rightHandle ? -1 : leftHandle > rightHandle ? 1 : 0;
		});

		return candidates.slice(0, k).map(({ indexed, score }) => ({
			span: indexed.span,
			score,
			snippet: buildSnippet(indexed.text, queryTokens, maxSnippetChars),
		}));
	}

	get size(): number {
		return this.spansById.size;
	}

	private addSpan(sessionId: string, span: TranscriptSourceSpan, text: string): IndexedSpan {
		const indexed: IndexedSpan = { id: this.nextId++, sessionId, span, text, time: spanTime(span) };
		this.spansById.set(indexed.id, indexed);
		for (const token of tokenize(text)) {
			let ids = this.postings.get(token);
			if (!ids) {
				ids = new Set<number>();
				this.postings.set(token, ids);
			}
			ids.add(indexed.id);
		}
		return indexed;
	}

	private removeSpan(indexed: IndexedSpan): void {
		this.spansById.delete(indexed.id);
		for (const token of tokenize(indexed.text)) {
			const ids = this.postings.get(token);
			if (!ids) continue;
			ids.delete(indexed.id);
			if (ids.size === 0) this.postings.delete(token);
		}
	}
}
