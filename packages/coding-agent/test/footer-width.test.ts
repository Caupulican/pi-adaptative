import { sep } from "node:path";
import { visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { SessionCostSummary } from "../src/core/cost/cost-summary.ts";
import type { CostGuardDecision } from "../src/core/cost-guard.ts";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type FooterUsageSnapshotForTest = {
	totalInput: number;
	totalOutput: number;
};

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	dailyCost?: number;
	subagentCost?: number;
	subagentReports?: number;
	costGuardDecision?: CostGuardDecision;
	subscription?: boolean;
}): AgentSession {
	const usage = options.usage;
	const entries =
		usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				];

	const ownCost = usage?.cost.total ?? 0;
	const subagentCost = options.subagentCost ?? 0;
	const subagentReports = options.subagentReports ?? (subagentCost > 0 ? 1 : 0);
	const costSummary: SessionCostSummary = {
		ownCost,
		subagentCost,
		subagentReports,
		currentCost: ownCost + subagentCost,
		todayCost: options.dailyCost ?? 0,
		todayOwnCost: 0,
		todaySubagentCost: 0,
		todayWindow: { startMs: 0, endMs: 86_400_000 },
		todayRollover: "local-midnight",
	};

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		getSpawnedUsage: () => ({ cost: subagentCost, reports: subagentReports }),
		getDailyUsageTotals: () => ({ totalCost: options.dailyCost ?? 0 }),
		getCostSummary: () => costSummary,
		getLastCostGuardDecision: () => options.costGuardDecision,
		modelRegistry: {
			isUsingOAuth: () => options.subscription ?? false,
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(
	providerCount: number,
	extensionStatuses = new Map<string, string>(),
	autonomyStatus?: string,
): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => extensionStatuses,
		getAvailableProviderCount: () => providerCount,
		getAutonomyStatus: () => autonomyStatus,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe(`~${sep}project`);
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("accumulates only newly appended usage entries after footer invalidation", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 },
				},
			},
		];
		const getEntries = vi.fn(() => entries.slice());
		const getEntriesSince = vi.fn((startIndex: number) => entries.slice(startIndex));
		const session = {
			state: { messages: [], model: { contextWindow: 100 } },
			sessionManager: {
				getEntryCount: () => entries.length,
				getEntries,
				getEntriesSince,
			},
			getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		} as unknown as AgentSession;
		const footer = new FooterComponent(session, createFooterData(1));
		const getUsageSnapshot = (
			footer as unknown as { getUsageSnapshot(messageCount: number): FooterUsageSnapshotForTest }
		).getUsageSnapshot.bind(footer);

		expect(getUsageSnapshot(0).totalInput).toBe(10);
		footer.invalidate();
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 5, output: 3, cacheRead: 2, cacheWrite: 1 },
			},
		});
		const updated = getUsageSnapshot(1);

		expect(updated.totalInput).toBe(15);
		expect(updated.totalOutput).toBe(5);
		expect(getEntries).toHaveBeenCalledTimes(1);
		expect(getEntriesSince).toHaveBeenCalledWith(1);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("folds duplicate learning footer statuses into one phase chip", () => {
		const session = createSession({ sessionName: "" });
		const statuses = new Map<string, string>([
			["auto-learn", "(learning)"],
			["continuous-learning", "\u001b[33m(learning)\u001b[0m\u001b[2m auto\u001b[0m"],
			["pi-chat", "pi-chat"],
		]);
		const footer = new FooterComponent(session, createFooterData(1, statuses));

		const statusLine = stripAnsi(footer.render(120).at(-1) ?? "");

		expect(statusLine).toContain("learn:auto");
		expect(statusLine).toContain("pi-chat");
		expect(statusLine).not.toContain("(learning) (learning)");
	});

	it("shows the contract cost labels in the visible stats line", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.25 },
			},
			dailyCost: 2.415,
			subagentCost: 0.5,
			subagentReports: 2,
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const statsLine = stripAnsi(footer.render(160)[1] ?? "");

		expect(statsLine).toContain("CURRENT:$1.750");
		expect(statsLine).toContain("TODAY:$2.415");
		expect(statsLine).toContain("SUBAGENTS:$0.500 in CURRENT");
		expect(statsLine).not.toContain("day:");
		expect(statsLine).not.toContain("(sub)");
	});

	it("renders session costs once when the autonomy snapshot also carries costs", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.25 },
			},
			dailyCost: 2.415,
		});
		const footerData = new FooterDataProvider("/tmp/project");
		try {
			footerData.setAutonomyStatusSnapshot({
				latestRoute: { tier: "direct", reasonCode: "allowed" },
				costSummary: session.getCostSummary(),
			});
			const rendered = stripAnsi(new FooterComponent(session, footerData).render(200).join("\n"));

			expect(rendered.match(/CURRENT:/g)).toHaveLength(1);
			expect(rendered.match(/TODAY:/g)).toHaveLength(1);
			expect(rendered).toContain("Route: direct - allowed");
			expect(rendered).not.toContain("Costs:");
		} finally {
			footerData.dispose();
		}
	});

	it("renders an over-ceiling guard warning once without duplicating cost totals", () => {
		const session = createSession({
			sessionName: "",
			usage: {
				input: 300_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 2.1 },
			},
			dailyCost: 2.1,
			costGuardDecision: { over: true, estUsd: 3.25, thresholdUsd: 2.5, action: "warn" },
		});
		const rendered = stripAnsi(new FooterComponent(session, createFooterData(1)).render(200).join("\n"));

		expect(rendered).toContain("GUARD:$3.25/turn");
		expect(rendered.match(/GUARD:/g)).toHaveLength(1);
		expect(rendered.match(/CURRENT:/g)).toHaveLength(1);
		expect(rendered.match(/TODAY:/g)).toHaveLength(1);
	});

	it("marks subscription-equivalent current cost without duplicating the cost bar", () => {
		const session = createSession({
			sessionName: "",
			subscription: true,
			usage: {
				input: 1_000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.25 },
			},
		});
		const rendered = stripAnsi(new FooterComponent(session, createFooterData(1)).render(160).join("\n"));

		expect(rendered).toContain("CURRENT:$0.250 (sub)");
		expect(rendered.match(/CURRENT:/g)).toHaveLength(1);
	});

	it("renders autonomy status on the status line when present", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1, new Map(), "Autonomy: idle"));

		const lines = footer.render(120);
		const statusLine = stripAnsi(lines.at(-1) ?? "");

		expect(lines.length).toBe(3); // pwd, stats, status
		expect(statusLine).toBe("Autonomy: idle");
	});

	it("renders autonomy status before extension statuses when both are present", () => {
		const session = createSession({ sessionName: "" });
		const statuses = new Map<string, string>([["my-ext", "ext-status"]]);
		const footer = new FooterComponent(session, createFooterData(1, statuses, "Autonomy: running"));

		const lines = footer.render(120);
		const statusLine = stripAnsi(lines.at(-1) ?? "");

		expect(statusLine).toBe("Autonomy: running ext-status");
	});

	it("sanitizes autonomy status before rendering it on the footer line", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1, new Map(), "Autonomy:\nrunning\tfast"));

		const lines = footer.render(120);
		const statusLine = stripAnsi(lines.at(-1) ?? "");

		expect(lines).toHaveLength(3);
		expect(statusLine).toBe("Autonomy: running fast");
	});

	it("truncates long autonomy status to width with the existing footer truncation path", () => {
		const session = createSession({ sessionName: "" });
		const longStatus = `Autonomy: ${"running ".repeat(50)}`;
		const footer = new FooterComponent(session, createFooterData(1, new Map(), longStatus));

		const width = 80;
		const lines = footer.render(width);
		const statusLine = lines.at(-1) ?? "";

		expect(visibleWidth(statusLine)).toBeLessThanOrEqual(width);
		expect(stripAnsi(statusLine)).toContain("...");
	});

	it("leaves footer line count unchanged when autonomy status and extension statuses are absent", () => {
		const session = createSession({ sessionName: "" });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(120);
		expect(lines.length).toBe(2); // Only pwd and stats
	});
});
