import { describe, expect, it } from "vitest";
import {
	CONTEXT_VISIBILITY_LONG_CHARS,
	CONTEXT_VISIBILITY_SHORT_CHARS,
	contextVisibilityExcerpt,
	selectContextVisibility,
} from "../src/core/context/context-query-visibility.ts";

describe("query-time context visibility", () => {
	it("keeps the absolute floor full and preserves the legacy no-curator recent/stale split", () => {
		expect(
			selectContextVisibility({
				insideAbsoluteFloor: true,
				insideRecentWindow: true,
				originalChars: 20_000,
				queryAware: true,
				verdict: { relevant: false, confidence: 1 },
			}),
		).toEqual({ selected: "full", reason: "absolute_floor", candidates: ["full"] });
		expect(
			selectContextVisibility({
				insideAbsoluteFloor: false,
				insideRecentWindow: true,
				originalChars: 20_000,
				queryAware: false,
				verdict: undefined,
			}).selected,
		).toBe("full");
		expect(
			selectContextVisibility({
				insideAbsoluteFloor: false,
				insideRecentWindow: false,
				originalChars: 20_000,
				queryAware: false,
				verdict: undefined,
			}).selected,
		).toBe("hidden");
	});

	it("fails open when missing and selects bounded tiers only from fresh confidence", () => {
		const base = {
			insideAbsoluteFloor: false,
			insideRecentWindow: false,
			originalChars: 20_000,
			queryAware: true,
		};
		expect(selectContextVisibility({ ...base, verdict: undefined })).toMatchObject({
			selected: "full",
			reason: "judgment_missing",
		});
		expect(selectContextVisibility({ ...base, verdict: { relevant: true, confidence: 0.5 } })).toMatchObject({
			selected: "short",
			reason: "query_uncertain",
		});
		expect(selectContextVisibility({ ...base, verdict: { relevant: false, confidence: 0.95 } })).toMatchObject({
			selected: "hidden",
			reason: "query_irrelevant",
		});
		expect(selectContextVisibility({ ...base, verdict: { relevant: true, confidence: 0.95 } })).toMatchObject({
			selected: "long",
			reason: "query_relevant",
		});
		expect(
			selectContextVisibility({
				...base,
				originalChars: CONTEXT_VISIBILITY_LONG_CHARS,
				verdict: { relevant: true, confidence: 0.95 },
			}).selected,
		).toBe("full");
		expect(
			selectContextVisibility({
				...base,
				originalChars: CONTEXT_VISIBILITY_SHORT_CHARS,
				verdict: { relevant: false, confidence: 0.5 },
			}).selected,
		).toBe("full");
	});

	it("uses one exact bounded head/tail excerpt for scoring and projection", () => {
		const source = `HEAD-${"x".repeat(2_000)}-TAIL`;
		const excerpt = contextVisibilityExcerpt(source, 100);
		expect(excerpt).toHaveLength(100);
		expect(excerpt.startsWith("HEAD-")).toBe(true);
		expect(excerpt.endsWith("-TAIL")).toBe(true);
		expect(contextVisibilityExcerpt(source, source.length)).toBe(source);
		expect(contextVisibilityExcerpt(source, 0)).toBe("");
	});
});
