import { describe, expect, it } from "vitest";
import {
	buildContextCompositionReport,
	formatContextCompositionDashboard,
} from "../src/core/context/context-composition.ts";
import { createHarness } from "./test-harness.ts";

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });

describe("buildContextCompositionReport", () => {
	it("decomposes system prompt, tools, extensions, and message classes with honest totals", () => {
		const report = buildContextCompositionReport({
			systemPrompt: "s".repeat(4000),
			tools: [
				{ name: "mega_tool", description: "d".repeat(8000), parameters: {}, source: "extension" },
				{ name: "read", description: "read a file", parameters: { type: "object" } },
			],
			extensions: [{ name: "my-ext", path: "/ext/my-ext", toolNames: ["mega_tool"], commandCount: 2 }],
			messages: [
				user("hello"),
				{
					role: "toolResult" as const,
					toolCallId: "tc-1",
					toolName: "grep",
					content: [{ type: "text" as const, text: "packed stub" }],
					details: { contextGc: { packed: true } },
					isError: false,
					timestamp: 0,
				},
				{
					role: "custom" as const,
					customType: "memory_context",
					content: [
						{ type: "text" as const, text: `<memory_context source="transcript-recall">${"r".repeat(400)}` },
					],
					display: false,
					timestamp: 0,
				} as never,
			],
			providerReportedTokens: 50_000,
			contextWindow: 100_000,
			gc: { packedCount: 1, savedTokens: 500 },
			enforcement: { enforcedCount: 0, advisoryEvictions: 0 },
		});

		expect(report.systemPromptTokens).toBe(1000);
		expect(report.tools[0]!.name).toBe("mega_tool"); // sorted heaviest first
		expect(report.extensions[0]!.activeToolSchemaTokens).toBe(report.tools[0]!.schemaTokens);
		const labels = report.messageClasses.map((row) => row.label);
		expect(labels).toContain("gc-packed stub");
		expect(labels).toContain("memory recall page");
		expect(labels).toContain("user");
		expect(report.estimatedRequestTokens).toBe(
			report.systemPromptTokens + report.toolSchemaTokens + report.messageTokens,
		);
		// the mega tool dominates -> actionable observation; provider delta is large -> flagged
		expect(report.observations.some((line) => line.includes("mega_tool"))).toBe(true);
		expect(report.observations.some((line) => line.includes("provider-reported"))).toBe(true);
	});

	it("renders a bounded dashboard with every section", () => {
		const report = buildContextCompositionReport({
			systemPrompt: "base prompt",
			tools: Array.from({ length: 15 }, (_, index) => ({ name: `tool_${index}`, description: "x".repeat(100) })),
			extensions: [],
			messages: [user("hi")],
			providerReportedTokens: null,
			contextWindow: 32_000,
			curation: {
				enabled: true,
				telemetry: { jobsRun: 3, parseFailures: 1, droppedJobs: 0, localChars: 4000, queued: 2, resultsHeld: 3 },
				lastSkipReason: "curation_model_unprobed",
			},
			spawned: { cost: 0.12, reports: 4 },
		});
		const text = formatContextCompositionDashboard(report);
		expect(text).toContain("Context composition");
		expect(text).toContain("system prompt:");
		expect(text).toContain("tool schemas:");
		expect(text).toContain("(+5 more:"); // 15 tools, 10 shown
		expect(text).toContain("brain curation: enabled");
		expect(text).toContain("curation_model_unprobed");
		expect(text).toContain("spawned/background spend");
		expect(text).toContain("$0.1200");
	});
});

describe("AgentSession.getContextCompositionReport", () => {
	it("assembles a live report from the real session state", () => {
		const harness = createHarness();
		try {
			const report = harness.session.getContextCompositionReport();
			expect(report.systemPromptTokens).toBeGreaterThan(0);
			expect(report.tools.length).toBeGreaterThan(0);
			// sorted heaviest-first
			for (let index = 1; index < report.tools.length; index++) {
				expect(report.tools[index - 1]!.schemaTokens).toBeGreaterThanOrEqual(report.tools[index]!.schemaTokens);
			}
			expect(report.curation?.enabled).toBe(false);
			const text = harness.session.formatContextCompositionDashboard();
			expect(text).toContain("Context composition");
			expect(text).toContain("tool schemas:");
		} finally {
			harness.cleanup();
		}
	});
});
