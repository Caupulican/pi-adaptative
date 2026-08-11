import { describe, expect, it } from "vitest";
import { assessCompactionNeed, type CompactionSettings } from "../../src/compaction/compaction.ts";

const settings: CompactionSettings = {
	enabled: true,
	reserveTokens: 1_000,
	keepRecentTokens: 500,
	triggerPercent: 0.5,
};

describe("compaction trigger assessment", () => {
	it("distinguishes hard capacity enforcement from optional early cost compaction", () => {
		expect(assessCompactionNeed(4_000, 10_000, settings)).toBe("none");
		expect(assessCompactionNeed(6_000, 10_000, settings)).toBe("early");
		expect(assessCompactionNeed(9_001, 10_000, settings)).toBe("hard");
		expect(assessCompactionNeed(7_001, 10_000, settings, 7_000)).toBe("hard");
		expect(assessCompactionNeed(9_001, 10_000, { ...settings, enabled: false })).toBe("none");
	});
});
