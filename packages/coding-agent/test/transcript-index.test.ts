import { describe, expect, it } from "vitest";
import { type TranscriptDoc, TranscriptIndex } from "../src/core/memory/transcript-index.ts";

describe("TranscriptIndex similarity recall", () => {
	it("handles empty corpus and queryText with no matches", () => {
		const index = new TranscriptIndex([]);
		expect(index.size).toBe(0);
		expect(index.query("test query")).toEqual([]);
	});

	it("returns identical text with high score", () => {
		const doc: TranscriptDoc = {
			sessionId: "session-1",
			text: "This is a unique session log containing specific instructions for the agent.",
		};
		const index = new TranscriptIndex([doc]);
		expect(index.size).toBe(1);

		const hits = index.query("unique session log specific instructions");
		expect(hits.length).toBe(1);
		expect(hits[0].sessionId).toBe("session-1");
		expect(hits[0].score).toBe(1);
	});

	it("sorts by top-k score in descending order", () => {
		const docs: TranscriptDoc[] = [
			{ sessionId: "s1", text: "apple banana" },
			{ sessionId: "s2", text: "apple banana cherry date" },
			{ sessionId: "s3", text: "apple grape" },
		];
		const index = new TranscriptIndex(docs);
		expect(index.size).toBe(3);

		const hits = index.query("apple banana cherry", { k: 2 });
		expect(hits.length).toBe(2);
		expect(hits[0].sessionId).toBe("s2");
		expect(hits[1].sessionId).toBe("s1");
		expect(hits[0].score).toBeGreaterThan(hits[1].score);
	});

	it("honors minScore cutoff filter", () => {
		const docs: TranscriptDoc[] = [
			{ sessionId: "s1", text: "apple banana" },
			{ sessionId: "s2", text: "grape pineapple orange" },
		];
		const index = new TranscriptIndex(docs);

		const hits = index.query("grape and pineapple and banana", { minScore: 0.5 });
		expect(hits.length).toBe(1);
		expect(hits[0].sessionId).toBe("s2");

		const highCutoff = index.query("grape and pineapple and banana", { minScore: 0.8 });
		expect(highCutoff.length).toBe(0);
	});

	it("trims snippet to maxSnippetChars around the best-matching region", () => {
		const longText = `Start of the document. ${"x ".repeat(100)}magic word found here. ${"y ".repeat(100)}End of the document.`;
		const doc: TranscriptDoc = {
			sessionId: "session-long",
			text: longText,
		};
		const index = new TranscriptIndex([doc]);

		const hits = index.query("magic word", { maxSnippetChars: 30 });
		expect(hits.length).toBe(1);
		expect(hits[0].snippet).toContain("magic word");
		expect(hits[0].snippet.length).toBeLessThanOrEqual(30 + 6); // 30 chars + optional prefix/suffix ellipses "..."
		expect(hits[0].snippet.startsWith("...")).toBe(true);
		expect(hits[0].snippet.endsWith("...")).toBe(true);
	});

	it("scores a high-unique-vocab doc with partial query overlap above minScore", () => {
		const vocab = Array.from({ length: 250 }, (_, i) => `word${i}`).join(" ");
		const docText = `${vocab} kubernetes deployment staging config`;
		const doc: TranscriptDoc = {
			sessionId: "long-session",
			text: docText,
		};
		const index = new TranscriptIndex([doc]);

		const hits = index.query("kubernetes deployment staging config unrelated banana");
		expect(hits.length).toBe(1);
		expect(hits[0].sessionId).toBe("long-session");
		expect(hits[0].score).toBeCloseTo(0.67, 2);
	});
});
