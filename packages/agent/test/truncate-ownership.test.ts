import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { truncateHead, truncateKnownHeadTail, truncateMiddle, truncateTail } from "../src/utils/truncate.ts";

describe("truncation ownership", () => {
	it("keeps unchanged content and its exact measurements", () => {
		for (const truncate of [truncateHead, truncateTail, truncateMiddle]) {
			expect(truncate("one\ntwo", { maxLines: 2, maxBytes: 7 })).toMatchObject({
				content: "one\ntwo",
				truncated: false,
				totalLines: 2,
				totalBytes: 7,
				outputLines: 2,
				outputBytes: 7,
			});
		}
	});

	it("preserves direction-specific oversized-line behavior", () => {
		expect(truncateHead("abcdefgh", { maxLines: 10, maxBytes: 4 })).toMatchObject({
			content: "",
			firstLineExceedsLimit: true,
			lastLinePartial: false,
		});
		expect(truncateMiddle("abcdefgh", { maxLines: 10, maxBytes: 4 })).toMatchObject({
			content: "",
			firstLineExceedsLimit: true,
			lastLinePartial: false,
		});
		expect(truncateTail("a🙂b", { maxLines: 10, maxBytes: 5 })).toMatchObject({
			content: "🙂b",
			firstLineExceedsLimit: false,
			lastLinePartial: true,
		});
	});

	it("keeps first and last lines when the middle is omitted", () => {
		const lines = Array.from({ length: 20 }, (_, index) => `line-${index}`);
		const result = truncateMiddle(lines.join("\n"), { maxLines: 6, maxBytes: 10_000 });
		expect(result.truncated).toBe(true);
		expect(result.content.startsWith("line-0\n")).toBe(true);
		expect(result.content.endsWith("\nline-19")).toBe(true);
		expect(result.content).toContain("middle omitted");
		expect(result.content).not.toContain("line-10");
	});

	it("reconstructs a known head and tail when they cover the whole payload", () => {
		const unique = ["a", "b", "c", "d", "e", "f"];
		const result = truncateKnownHeadTail(
			["a", "b", "c", "d"],
			["c", "d", "e", "f"],
			{
				totalLines: 6,
				totalBytes: unique.join("\n").length,
			},
			{ maxLines: 4, maxBytes: 10_000 },
		);
		expect(result.truncated).toBe(true);
		expect(result.content.startsWith("a\n")).toBe(true);
		expect(result.content.endsWith("\nf")).toBe(true);
		expect(result.content).toContain("middle omitted");
	});

	it("composes a hole between a known head and tail without inventing middle lines", () => {
		const result = truncateKnownHeadTail(
			["head-0", "head-1"],
			["tail-8", "tail-9"],
			{ totalLines: 10, totalBytes: 200 },
			{ maxLines: 5, maxBytes: 10_000 },
		);
		expect(result.truncated).toBe(true);
		expect(result.content.startsWith("head-0\n")).toBe(true);
		expect(result.content.endsWith("\ntail-9")).toBe(true);
		expect(result.content).toContain("middle omitted");
		expect(result.content).not.toContain("head-5");
	});

	it("has one measurement and result-construction owner", () => {
		const source = readFileSync(new URL("../src/utils/truncate.ts", import.meta.url), "utf8");
		expect(source).toContain("function measureTruncation(");
		expect(source).toContain("function buildTruncationResult(");
		expect(source.match(/splitLinesForCounting\(content\)/g)).toHaveLength(1);
	});
});
