import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, AgentState } from "@caupulican/pi-agent-core";
import type { FileEntry, SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage, Usage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { SPAWNED_USAGE_CUSTOM_TYPE } from "../src/core/agent-session.ts";
import {
	createSessionCostSummary,
	formatFooterCostParts,
	formatStatusCostSummary,
} from "../src/core/cost/cost-summary.ts";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { SessionAnalytics } from "../src/core/session-analytics.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { tempDir as sessionScratch } from "./temp-dir.ts";

function usage(costTotal: number): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: costTotal / 2, output: costTotal / 2, cacheRead: 0, cacheWrite: 0, total: costTotal },
	};
}

function assistant(id: string, timestamp: Date, costTotal: number): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: id }],
		api: "messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(costTotal),
		stopReason: "stop",
		timestamp: timestamp.getTime(),
	};
	return { type: "message", id, parentId: null, timestamp: timestamp.toISOString(), message };
}

function spawned(id: string, timestamp: Date, costTotal: number, reportId = id): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: timestamp.toISOString(),
		customType: SPAWNED_USAGE_CUSTOM_TYPE,
		data: { usage: usage(costTotal), reportId },
	};
}

function createAnalytics(
	sessionDir: string,
	entries: SessionEntry[],
	onEntriesRead: () => void = () => {},
): SessionAnalytics {
	const sessionManager = {
		getEntries: () => {
			onEntriesRead();
			return entries;
		},
		getEntryCount: () => entries.length,
		getEntriesSince: (startIndex: number) => entries.slice(startIndex),
		getEntry: (id: string) => entries.find((entry) => entry.id === id),
		getSessionDir: () => sessionDir,
		usesDefaultSessionDir: () => false,
		getSessionFile: () => join(sessionDir, "session.jsonl"),
		getSessionId: () => "session-1",
		getBranch: () => entries,
		getCwd: () => sessionDir,
	} as unknown as SessionManager;
	return new SessionAnalytics({
		getState: () => ({ messages: [] }) as unknown as AgentState,
		getMessages: () => [] as AgentMessage[],
		getModel: () => undefined,
		getSessionManager: () => sessionManager,
		getSettingsManager: () => ({}) as SettingsManager,
		getToolDefinition: (_name: string): ToolDefinition | undefined => undefined,
		getToolRecoveryEventLogPath: () => join(sessionDir, "tool-recovery-events.jsonl"),
		getAgentDir: () => sessionDir,
	});
}

describe("session cost summary", () => {
	it("does not qualify current dollars for estimated usage that contributes no valid cost", () => {
		const invalid = assistant("invalid-ultra", new Date(), Number.NaN);
		if (invalid.type !== "message" || invalid.message.role !== "assistant") throw new Error("Expected assistant");
		invalid.message.usage.cost.estimate = "base-rates";
		const summary = createSessionCostSummary({
			entries: [invalid, assistant("exact", new Date(), 1)],
			dailyTotals: {
				ownCost: 1,
				spawnedCost: 0,
				totalCost: 1,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				sessions: 1,
				reports: 0,
			},
			todayWindow: { startMs: 0, endMs: 86400000 },
		});
		expect(summary.currentCost).toBe(1);
		expect(summary.costEstimate).toBeUndefined();
	});
	it("retains earlier estimated TODAY costs across a fresh exact session and cached redraws", () => {
		const sessionDir = sessionScratch("pi-session-tier-estimate-");
		const now = new Date();
		const earlier = assistant("earlier-ultra", now, 1);
		if (earlier.type !== "message" || earlier.message.role !== "assistant") throw new Error("Expected assistant");
		earlier.message.usage.cost.estimate = "base-rates";
		const header: FileEntry = {
			type: "session",
			id: "earlier-session",
			timestamp: now.toISOString(),
			cwd: sessionDir,
		};
		writeFileSync(
			join(sessionDir, "earlier-session.jsonl"),
			[header, earlier].map((entry) => JSON.stringify(entry)).join("\n"),
		);
		const currentEntries = [assistant("current-exact", now, 0.4)];
		writeFileSync(
			join(sessionDir, "session.jsonl"),
			[{ ...header, id: "session-1" }, ...currentEntries].map((entry) => JSON.stringify(entry)).join("\n"),
		);
		const analytics = createAnalytics(sessionDir, currentEntries);

		const totals = analytics.getDailyUsageTotals(now);
		expect(analytics.getDailyUsageTotals(now)).toBe(totals);
		expect(totals.totalCost).toBeCloseTo(1.4, 10);
		expect(totals.costEstimate).toBe("base-rates");
		const summary = analytics.getCostSummary(now);
		expect(analytics.getCostSummary(now)).toBe(summary);
		expect(summary.costEstimate).toBeUndefined();
		expect(summary.todayCostEstimate).toBe("base-rates");
		expect(formatFooterCostParts(summary)).toEqual(["CURRENT:$0.400", "TODAY:~$1.400"]);
		expect(formatStatusCostSummary(summary)).toBe("CURRENT $0.4000, TODAY ~$1.4000 (base-rate estimate)");
	});
	it("qualifies today's dollars when a fresh session has no estimated requests", () => {
		const summary = createSessionCostSummary({
			entries: [],
			dailyTotals: {
				ownCost: 1,
				spawnedCost: 0,
				totalCost: 1,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				sessions: 1,
				reports: 0,
				costEstimate: "base-rates",
			},
			todayWindow: { startMs: 0, endMs: 86400000 },
		});
		expect(summary.costEstimate).toBeUndefined();
		expect(summary.todayCostEstimate).toBe("base-rates");
		expect(formatFooterCostParts(summary)).toEqual(["TODAY:~$1.000"]);
		expect(formatStatusCostSummary(summary)).toContain("TODAY ~$1.0000 (base-rate estimate)");
	});
	it("qualifies session dollars when a processing tier has no published prices", () => {
		const entry = assistant("ultra", new Date(), 1);
		if (entry.type !== "message" || entry.message.role !== "assistant") throw new Error("Expected assistant");
		entry.message.usage.cost.estimate = "base-rates";
		const summary = createSessionCostSummary({
			entries: [entry],
			dailyTotals: {
				ownCost: 1,
				spawnedCost: 0,
				totalCost: 1,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				sessions: 1,
				reports: 0,
			},
			todayWindow: { startMs: 0, endMs: 86400000 },
		});
		expect(summary.costEstimate).toBe("base-rates");
		expect(formatFooterCostParts(summary)[0]).toBe("CURRENT:~$1.000");
		expect(formatStatusCostSummary(summary)).toContain("CURRENT ~$1.0000 (base-rate estimate)");
	});
	it("aggregates CURRENT/TODAY/SUBAGENTS once and formats both cost surfaces", () => {
		const summary = createSessionCostSummary({
			entries: [
				assistant("own", new Date(2026, 5, 28, 12), 0.7),
				spawned("sub-a", new Date(2026, 5, 28, 13), 0.2, "sub-a"),
				spawned("sub-b", new Date(2026, 5, 28, 14), 0.3, "sub-b"),
				spawned("sub-b-dup", new Date(2026, 5, 28, 15), 0.3, "sub-b"),
			],
			dailyTotals: {
				ownCost: 1,
				spawnedCost: 0.5,
				totalCost: 1.5,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				sessions: 1,
				reports: 2,
			},
			todayWindow: { startMs: 0, endMs: 86_400_000 },
		});

		expect(summary.ownCost).toBeCloseTo(0.7, 10);
		expect(summary.subagentCost).toBeCloseTo(0.5, 10);
		expect(summary.subagentReports).toBe(2);
		expect(summary.currentCost).toBeCloseTo(1.2, 10);
		expect(formatFooterCostParts(summary)).toEqual(["CURRENT:$1.200", "TODAY:$1.500", "SUBAGENTS:$0.500 in CURRENT"]);
		expect(formatStatusCostSummary(summary)).toBe(
			"CURRENT $1.2000, TODAY $1.5000, SUBAGENTS $0.5000 (included in CURRENT)",
		);
	});

	it("omits the SUBAGENTS component when no subagents ran", () => {
		const summary = createSessionCostSummary({
			entries: [assistant("own", new Date(2026, 5, 28, 12), 0.7)],
			dailyTotals: {
				ownCost: 0.7,
				spawnedCost: 0,
				totalCost: 0.7,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				sessions: 1,
				reports: 0,
			},
			todayWindow: { startMs: 0, endMs: 86_400_000 },
		});

		expect(formatFooterCostParts(summary)).toEqual(["CURRENT:$0.700", "TODAY:$0.700"]);
		expect(formatFooterCostParts(summary, 3, { subscription: true })).toEqual([
			"CURRENT:$0.700 (sub)",
			"TODAY:$0.700",
		]);
		expect(formatStatusCostSummary(summary)).toBe("CURRENT $0.7000, TODAY $0.7000");
	});

	it("keeps the subscription marker visible when pricing-equivalent usage is still zero", () => {
		const summary = createSessionCostSummary({
			entries: [],
			dailyTotals: {
				ownCost: 0,
				spawnedCost: 0,
				totalCost: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				sessions: 0,
				reports: 0,
			},
			todayWindow: { startMs: 0, endMs: 86_400_000 },
		});

		expect(formatFooterCostParts(summary, 3, { subscription: true })).toEqual(["CURRENT:$0.000 (sub)"]);
	});

	it("does not rescan the session log on unchanged footer redraws", () => {
		const tempDir = sessionScratch("pi-session-cost-cache-");
		try {
			const now = new Date();
			const entries = [assistant("one", now, 0.4)];
			const header: FileEntry = { type: "session", id: "session-1", timestamp: now.toISOString(), cwd: tempDir };
			writeFileSync(
				join(tempDir, "session.jsonl"),
				`${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
				"utf-8",
			);
			let entriesRead = 0;
			const analytics = createAnalytics(tempDir, entries, () => entriesRead++);

			const first = analytics.getCostSummary(now);
			const readsAfterFirstSummary = entriesRead;
			const second = analytics.getCostSummary(now);

			expect(second).toBe(first);
			expect(entriesRead).toBe(readsAfterFirstSummary);

			entries.push(assistant("two", now, 0.6));
			expect(analytics.getCostSummary(now).currentCost).toBeCloseTo(1, 10);
			expect(entriesRead).toBe(readsAfterFirstSummary);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("bounds live tool-recovery telemetry retained by a long session", () => {
		const tempDir = sessionScratch("pi-session-tool-recovery-cap-");
		try {
			const analytics = createAnalytics(tempDir, []);
			for (let index = 0; index < 1_001; index++) {
				analytics.recordToolArgumentValidation({
					kind: "tool_argument_validation",
					version: 1,
					recordId: `session-1:${index}`,
					ts: new Date().toISOString(),
					sessionId: "session-1",
					outcome: "repaired",
					tool: "edit",
					source: "text-protocol",
					failureModes: ["jsonStringParse"],
					repairsApplied: ["jsonStringParse"],
					taught: "none",
					executionOutcome: "succeeded",
				});
			}

			expect(analytics.getToolArgumentValidationStats().repaired).toBe(1_001);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rolls TODAY at local midnight without changing CURRENT mid-session", () => {
		const tempDir = sessionScratch("pi-session-cost-summary-");
		try {
			const dayOne = new Date(2026, 5, 28, 12);
			const dayTwo = new Date(2026, 5, 29, 12);
			const entries = [assistant("day-one", dayOne, 0.4), assistant("day-two", dayTwo, 0.6)];
			const header: FileEntry = { type: "session", id: "session-1", timestamp: dayOne.toISOString(), cwd: tempDir };
			writeFileSync(
				join(tempDir, "session.jsonl"),
				`${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
				"utf-8",
			);
			const analytics = createAnalytics(tempDir, entries);

			const beforeRollover = analytics.getCostSummary(new Date(2026, 5, 28, 23, 59, 59, 900));
			const afterRollover = analytics.getCostSummary(new Date(2026, 5, 29, 0, 0, 0, 100));

			expect(beforeRollover.currentCost).toBeCloseTo(1, 10);
			expect(afterRollover.currentCost).toBeCloseTo(1, 10);
			expect(beforeRollover.todayCost).toBeCloseTo(0.4, 10);
			expect(afterRollover.todayCost).toBeCloseTo(0.6, 10);
			expect(beforeRollover.todayWindow.startMs).not.toBe(afterRollover.todayWindow.startMs);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
