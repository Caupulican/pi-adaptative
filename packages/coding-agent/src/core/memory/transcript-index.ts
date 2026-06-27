import { tokenize } from "../tools/skill-audit.ts";

export interface RecallHit {
	sessionId: string;
	score: number;
	snippet: string;
	timestamp?: string;
}

export interface TranscriptDoc {
	sessionId: string;
	timestamp?: string;
	text: string;
}

interface IndexedDoc {
	doc: TranscriptDoc;
	tokens: string[];
}

export class TranscriptIndex {
	private indexedDocs: IndexedDoc[] = [];

	constructor(docs: TranscriptDoc[]) {
		this.indexedDocs = docs.map((doc) => ({
			doc,
			tokens: tokenize(doc.text),
		}));
	}

	query(queryText: string, opts?: { k?: number; minScore?: number; maxSnippetChars?: number }): RecallHit[] {
		const k = opts?.k ?? 5;
		const minScore = opts?.minScore ?? 0.34;
		const maxSnippetChars = opts?.maxSnippetChars ?? 600;

		const qTokens = tokenize(queryText);
		if (qTokens.length === 0 || this.indexedDocs.length === 0) {
			return [];
		}

		const qSet = new Set(qTokens);
		const hits: RecallHit[] = [];

		for (const { doc, tokens } of this.indexedDocs) {
			const dSet = new Set(tokens);
			let intersection = 0;
			for (const token of qSet) {
				if (dSet.has(token)) {
					intersection++;
				}
			}
			const score = intersection / qSet.size;
			if (score <= minScore) {
				continue;
			}

			// Find matching indices of query tokens in the document text (case-insensitive)
			const lowerText = doc.text.toLowerCase();
			const matchIndices: number[] = [];
			for (const token of qTokens) {
				let pos = lowerText.indexOf(token);
				while (pos !== -1) {
					matchIndices.push(pos);
					pos = lowerText.indexOf(token, pos + 1);
				}
			}

			let bestStart = 0;
			let bestEnd = Math.min(doc.text.length, maxSnippetChars);

			if (matchIndices.length > 0) {
				matchIndices.sort((a, b) => a - b);
				let maxMatchesInWindow = 0;

				for (const center of matchIndices) {
					let start = Math.max(0, center - Math.floor(maxSnippetChars / 2));
					const end = Math.min(doc.text.length, start + maxSnippetChars);
					if (end - start < maxSnippetChars && start > 0) {
						start = Math.max(0, end - maxSnippetChars);
					}

					let matches = 0;
					for (const idx of matchIndices) {
						if (idx >= start && idx < end) {
							matches++;
						}
					}

					if (matches > maxMatchesInWindow) {
						maxMatchesInWindow = matches;
						bestStart = start;
						bestEnd = end;
					}
				}
			}

			const rawSnippet = doc.text.slice(bestStart, bestEnd);
			const prefix = bestStart > 0 ? "..." : "";
			const suffix = bestEnd < doc.text.length ? "..." : "";
			const snippet = prefix + rawSnippet + suffix;

			hits.push({
				sessionId: doc.sessionId,
				score,
				snippet,
				timestamp: doc.timestamp,
			});
		}

		// Sort by score desc
		hits.sort((a, b) => b.score - a.score);

		return hits.slice(0, k);
	}

	get size(): number {
		return this.indexedDocs.length;
	}
}
