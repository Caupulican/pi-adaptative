import { describe, expect, it } from "vitest";
import { idlePreparationText } from "../src/modes/interactive/components/decision-graph-model.ts";

/** The Decision graph names what the idle root lane's compaction preparation is doing, from its recorded facts. */
describe("idle preparation text", () => {
	it("counts down to the planned moment and names the value it expects", () => {
		expect(idlePreparationText({ state: "armed", prepareAt: 95_000, valueUsd: 0.0123 }, 20_000)).toBe(
			"idle · prepare in 1m15s · ~$0.012 expected",
		);
	});

	it("reports preparing, prepared, and how the next request resumed", () => {
		expect(idlePreparationText({ state: "preparing", since: 10_000 }, 22_000)).toBe("idle · preparing a summary 12s");
		expect(idlePreparationText({ state: "prepared", at: 0 }, 1)).toBe("idle · summary prepared");
		expect(idlePreparationText({ state: "resumed", fresh: true, savedUsd: 0.25, at: 0 }, 1)).toBe(
			"resumed · fresh · saved ~$0.250",
		);
		expect(idlePreparationText({ state: "resumed", fresh: false, at: 0 }, 1)).toBe("resumed · warm");
	});
});
