/**
 * Regression test for `fetchCommandCodeAccountUsage` -> `commandCodeUsageSnapshot`: verifies `5h`, `weekly`,
 * `monthly`, and `orgLimits` windows are projected accurately while `purchasedCredits` and `freeCredits` stay in
 * `balance` and never mask an exhausted subscription or organization window.
 */

import { fetchCommandCodeAccountUsage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { commandCodeUsageSnapshot } from "../src/core/provider-admission/usage-overview.ts";

describe("Command Code usage snapshot projection", () => {
	it("projects 5h, weekly, monthly, and orgLimits windows while keeping purchased/free credits in balance", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const parsed = new URL(url);
			if (parsed.pathname === "/alpha/whoami") {
				return Response.json({
					user: { id: "usr_1", name: "Ada" },
					org: { id: "org_42", name: "Core Lab" },
					orgLimits: [
						{
							scope: "org",
							spent: 150,
							limit: 200,
							exceeded: false,
							resetInterval: "monthly",
							resetAt: "2026-12-01T00:00:00.000Z",
						},
						{
							scope: "model",
							model: "claude-opus-4-6",
							modelLabel: "Claude Opus 4.6",
							spent: 50,
							limit: 50,
							exceeded: true,
							resetInterval: "weekly",
							resetAt: "2026-11-16T00:00:00.000Z",
						},
					],
				});
			}
			if (parsed.pathname === "/alpha/billing/credits") {
				return Response.json({
					credits: {
						planId: "individual_pro_v1",
						monthlyCredits: 0,
						purchasedCredits: 250,
						freeCredits: 25.5,
					},
					windowLimits: {
						limited: true,
						fiveHour: { used: 100, cap: 100, resetAt: 1_794_400_000_000 },
						weekly: { used: 300, cap: 400, resetAt: 1_794_800_000_000 },
					},
				});
			}
			if (parsed.pathname === "/alpha/billing/subscriptions") {
				return Response.json({
					data: {
						planId: "individual_pro_v1",
						status: "active",
						currentPeriodStart: "2026-11-01T00:00:00.000Z",
						currentPeriodEnd: 1_796_083_200_000,
					},
				});
			}
			if (parsed.pathname === "/alpha/usage/summary") {
				return Response.json({
					data: {
						totalCost: 80,
						totalCount: 95,
						periodBasis: "billing-period",
					},
				});
			}
			return new Response("not found", { status: 404 });
		});

		const accountUsage = await fetchCommandCodeAccountUsage("cc-live-key", {
			baseUrl: "https://api.commandcode.ai",
			fetch: fetchMock,
		});
		const snapshot = commandCodeUsageSnapshot(accountUsage);

		expect(snapshot).toEqual({
			plan: "Pro v1",
			balance: "extra credits $275.50 USD",
			details: ["billing period $80.00 · 95 requests", "org Core Lab"],
			windows: [
				{
					id: "5h",
					label: "5h window",
					usedPercent: 100,
					resetsAt: 1_794_400_000_000,
				},
				{
					id: "weekly",
					label: "Weekly window",
					usedPercent: 75,
					resetsAt: 1_794_800_000_000,
				},
				{
					id: "monthly",
					label: "Monthly included",
					usedPercent: 100,
					resetsAt: 1_796_083_200_000,
					detail: "$0.00 of $80.00 left",
				},
				{
					id: "org:monthly:0",
					label: "Org spend cap",
					usedPercent: 75,
					resetsAt: Date.parse("2026-12-01T00:00:00.000Z"),
					detail: "$150.00 of $200.00/mo",
				},
				{
					id: "org:model:claude-opus-4-6",
					label: "Org cap (Claude Opus 4.6)",
					usedPercent: 100,
					resetsAt: Date.parse("2026-11-16T00:00:00.000Z"),
					detail: "$50.00 of $50.00/week",
				},
			],
		});
	});
});
