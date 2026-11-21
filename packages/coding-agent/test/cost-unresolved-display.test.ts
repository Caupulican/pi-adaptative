import { afterEach, expect, it, vi } from "vitest";
import {
	formatFooterCostParts,
	formatStatusCostSummary,
	type SessionCostSummary,
} from "../src/core/cost/cost-summary.ts";
import { interfaceLanguage, interfaceText, setInterfaceLanguage } from "../src/core/language/interface-text.ts";
import type { UsageOverview } from "../src/core/provider-admission/usage-overview.ts";
import { formatCostBreakdownLines } from "../src/modes/interactive/components/usage-dashboard.ts";
import { formatCostReport } from "../src/modes/interactive/report-commands.ts";

vi.mock("../src/presentation/theme-model.ts", () => ({
	theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
}));
const previousLanguage = interfaceLanguage();
afterEach(() => setInterfaceLanguage(previousLanguage));

it.each(["en", "pt-BR"] as const)(
	"explains unresolved request costs without blaming historical accounting in %s",
	(language) => {
		setInterfaceLanguage(language);
		const summary: SessionCostSummary = {
			ownCost: 0,
			subagentCost: 0,
			subagentReports: 0,
			historySummaryCost: 0,
			historySummaryReports: 0,
			currentCost: 0,
			todayCost: 0,
			todayOwnCost: 0,
			todaySubagentCost: 0,
			todayHistorySummaryCost: 0,
			todayWindow: { startMs: 0, endMs: 1 },
			todayRollover: "local-midnight",
			unresolvedUsageRequests: 1,
		};
		const expected = interfaceText().reports.cost.unresolvedUsage(1);
		expect(formatCostReport(summary)).toContain(expected);
		expect(formatCostReport(summary)).not.toContain(interfaceText().reports.cost.historicalAccounting("pending"));
		expect(formatStatusCostSummary(summary)).toContain(expected);
		expect(formatFooterCostParts(summary).join(" ")).toContain(expected);
		const overview = {
			session: { costUsd: 0, subagentCostUsd: 0, icmCostUsd: 0, subscription: false, unresolvedUsageRequests: 1 },
			today: { costUsd: 0, subagentCostUsd: 0, icmCostUsd: 0 },
		} as UsageOverview;
		expect(formatCostBreakdownLines(overview, 240).join("\n")).toContain(expected);
		const incomplete = { ...summary, unresolvedUsageRequests: undefined, usageAccountingIncomplete: true as const };
		const generic = interfaceText().reports.cost.unresolvedUsage();
		expect(formatCostReport(incomplete)).toContain(generic);
		expect(formatStatusCostSummary(incomplete)).toContain(generic);
		expect(formatFooterCostParts(incomplete).join(" ")).toContain(generic);
		const resolved = { ...summary, unresolvedUsageRequests: undefined };
		expect(formatCostReport(resolved)).not.toContain(expected);
	},
);
