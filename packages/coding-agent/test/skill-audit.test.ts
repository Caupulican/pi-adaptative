import { describe, expect, it } from "vitest";
import { jaccard, tokenize } from "../src/core/tools/skill-audit.ts";

describe("skill-audit helpers", () => {
	describe("tokenize", () => {
		it("should tokenize text and remove stopwords", () => {
			const tokens = tokenize("the quick brown fox");
			expect(tokens).toContain("quick");
			expect(tokens).toContain("brown");
			expect(tokens).toContain("fox");
			expect(tokens).not.toContain("the");
		});

		it("should lowercase all tokens", () => {
			const tokens = tokenize("Quick Brown FOX");
			expect(tokens).toHaveLength(3);
			for (const token of tokens) {
				expect(token).toEqual(token.toLowerCase());
			}
		});

		it("should filter out short tokens (< 3 chars)", () => {
			const tokens = tokenize("a an go hello world");
			expect(tokens).not.toContain("go");
			expect(tokens).toContain("hello");
			expect(tokens).toContain("world");
		});

		it("should remove duplicates", () => {
			const tokens = tokenize("foo foo bar bar");
			expect(tokens).toHaveLength(2);
			expect(tokens).toContain("foo");
			expect(tokens).toContain("bar");
		});

		it("should handle hyphens and colons in tokens", () => {
			const tokens = tokenize("auto-learn skill:audit");
			expect(tokens).toContain("auto-learn");
			expect(tokens).toContain("skill:audit");
		});

		it("should return empty array for text with only stopwords", () => {
			const tokens = tokenize("the a an and or of");
			expect(tokens).toHaveLength(0);
		});
	});

	describe("jaccard", () => {
		it("should return 1.0 for identical sets", () => {
			const a = ["foo", "bar", "baz"];
			const b = ["foo", "bar", "baz"];
			expect(jaccard(a, b)).toBe(1.0);
		});

		it("should return 0 for disjoint sets", () => {
			const a = ["foo", "bar"];
			const b = ["baz", "qux"];
			expect(jaccard(a, b)).toBe(0);
		});

		it("should calculate correct similarity for partial overlap", () => {
			const a = ["foo", "bar", "baz"];
			const b = ["bar", "baz", "qux"];
			// intersection: {bar, baz} = 2
			// union: {foo, bar, baz, qux} = 4
			// similarity: 2/4 = 0.5
			expect(jaccard(a, b)).toBe(0.5);
		});

		it("should return 0 for empty set", () => {
			const a = ["foo", "bar"];
			const b: string[] = [];
			expect(jaccard(a, b)).toBe(0);
		});

		it("should handle duplicates in input (treat as sets)", () => {
			const a = ["foo", "foo", "bar"];
			const b = ["foo", "bar", "bar"];
			// Both should be treated as {foo, bar}
			expect(jaccard(a, b)).toBe(1.0);
		});

		it("should return correct similarity for near-duplicates", () => {
			// High overlap (90%+)
			const a = ["auto", "learn", "skill", "skill:audit", "background", "agent"];
			const b = ["auto", "learn", "skill", "skill:audit", "background", "continuous"];
			// intersection: 5 tokens
			// union: 7 tokens
			// similarity: 5/7 ≈ 0.714
			const sim = jaccard(a, b);
			expect(sim).toBeGreaterThan(0.5);
			expect(sim).toBeLessThan(0.9);
		});
	});

	describe("integration: skill similarity detection", () => {
		it("should detect high similarity between very similar skill names/descriptions", () => {
			const skillA = tokenize("auto-learn background agent continuous learning");
			const skillB = tokenize("auto-learn agent continuous learning task");

			const similarity = jaccard(skillA, skillB);
			expect(similarity).toBeGreaterThanOrEqual(0.55);
		});

		it("should NOT flag unrelated skills as duplicates", () => {
			const skillA = tokenize("file reader text parser");
			const skillB = tokenize("network request http client");

			const similarity = jaccard(skillA, skillB);
			expect(similarity).toBeLessThan(0.55);
		});

		it("should flag skills with >55% overlap", () => {
			// Create two token sets with 60% overlap
			const base = ["skill", "audit", "overlap", "detection", "duplicate"];
			const similar = ["skill", "audit", "overlap", "detection", "similar"];
			// 4 common, 1 unique each = 4/(5+1) ≈ 0.67 (67%)
			const similarity = jaccard(base, similar);
			expect(similarity).toBeGreaterThanOrEqual(0.55);
		});
	});
});
