import { describe, expect, it } from "vitest";
import {
	SELF_COMPACTION_GAUGE_CELLS,
	selfCompactionGauge,
} from "../src/modes/interactive/components/self-compaction-gauge.ts";
import { gaugeView } from "./self-compaction-view-fixture.ts";

describe("self-compaction gauge", () => {
	it("draws twenty cells of cached, uncached and free context with the three lines marked", () => {
		const gauge = selfCompactionGauge(gaugeView())!;
		expect(gauge.bar).toHaveLength(SELF_COMPACTION_GAUGE_CELLS + 2);
		const cells = gauge.bar.slice(1, -1);
		expect(cells.slice(0, 6)).toBe("######");
		expect(cells.slice(6, 8)).toBe("==");
		expect(cells[8]).toBe("+");
		expect(cells[10]).toBe("!");
		expect(cells[17]).toBe("|");
		expect(cells.slice(18)).toBe("..");
		expect(gauge).toMatchObject({ percent: "55.0%", tag: "WARNING", tone: "warning", cycle: null });
	});

	it("names each handoff phase and the finished cycles, and stays quiet while the context is clear", () => {
		expect(selfCompactionGauge(gaugeView({ phase: "forced", cycles: 2 }))).toMatchObject({
			tag: "FORCED",
			tone: "error",
			cycle: "cycle 2",
		});
		expect(selfCompactionGauge(gaugeView({ phase: "compacting" }))?.tag).toBe("COMPACTING");
		expect(selfCompactionGauge(gaugeView({ phase: "compacted" }))?.tag).toBe("COMPACTED");
		expect(selfCompactionGauge(gaugeView({ phase: "resuming" }))?.tag).toBe("RESUMING");
		expect(selfCompactionGauge(gaugeView({ phase: "clear", usedTokens: 10_000, cachedTokens: 0 }))).toMatchObject({
			tag: null,
			tone: null,
			percent: "5.0%",
		});
	});

	it("shows unknown usage without inventing cells and renders nothing when self-compaction is off", () => {
		const unknown = selfCompactionGauge(gaugeView({ usedTokens: null, cachedTokens: null, phase: "clear" }))!;
		expect(unknown.percent).toBe("?%");
		expect(unknown.bar.replace(/[+!|[\]]/g, "")).toMatch(/^\.+$/);
		expect(selfCompactionGauge(gaugeView({ thresholds: null, phase: "off" }))).toBeNull();
	});
});
