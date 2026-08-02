import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { truncateHead, truncateTail } from "../src/utils/truncate.ts";

describe("truncation ownership", () => {
	it("keeps unchanged content and its exact measurements", () => {
		for (const truncate of [truncateHead, truncateTail]) {
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
		expect(truncateTail("a🙂b", { maxLines: 10, maxBytes: 5 })).toMatchObject({
			content: "🙂b",
			firstLineExceedsLimit: false,
			lastLinePartial: true,
		});
	});

	it("has one measurement and result-construction owner", () => {
		const source = readFileSync(new URL("../src/utils/truncate.ts", import.meta.url), "utf8");
		expect(source).toContain("function measureTruncation(");
		expect(source).toContain("function buildTruncationResult(");
		expect(source.match(/splitLinesForCounting\(content\)/g)).toHaveLength(1);
	});
});
