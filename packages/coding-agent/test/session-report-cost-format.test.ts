import { beforeAll, describe, expect, it } from "vitest";
import type { SessionCostSummary } from "../src/core/cost/cost-summary.ts";
import { formatCostReport } from "../src/modes/interactive/report-commands.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createCosts(overrides: Partial<SessionCostSummary> = {}): SessionCostSummary {
	return {
		ownCost: 0.1234,
		subagentCost: 0.25,
		subagentReports: 3,
		currentCost: 0.3734,
		todayCost: 0.75,
		todayOwnCost: 0.5,
		todaySubagentCost: 0.25,
		todayWindow: { startMs: 0, endMs: 1 },
		todayRollover: "local-midnight",
		...overrides,
	};
}

describe("interactive cost report formatting", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the shared session and usage cost lines exactly", () => {
		expect(stripAnsi(formatCostReport(createCosts()))).toBe(
			[
				"CURRENT (session): $0.3734",
				"SUBAGENTS (included in CURRENT): $0.2500 (3 reports)",
				"TODAY (host local day): $0.7500",
				"Today rollover: local midnight",
			].join("\n"),
		);
	});

	it("keeps the subscription suffix while omitting an empty subagent line", () => {
		const costs = createCosts({ subagentCost: 0, subagentReports: 0, currentCost: 0.1234 });

		expect(stripAnsi(formatCostReport(costs, true))).toBe(
			["CURRENT (session): $0.1234 (sub)", "TODAY (host local day): $0.7500", "Today rollover: local midnight"].join(
				"\n",
			),
		);
	});
});
