import { describe, expect, it } from "vitest";
import {
	buildContextCompositionReport,
	formatContextCompositionDashboard,
} from "../src/core/context/context-composition.ts";
import { createHarness } from "./test-harness.ts";

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 0 });

describe("buildContextCompositionReport", () => {
	it("decomposes system prompt, tools, extensions, and message classes with honest totals", () => {
		const rawMegaSchemaTokens = Math.ceil(
			JSON.stringify({
				name: "mega_tool",
				description: "d".repeat(8000),
				parameters: {
					type: "object",
					properties: { query: { type: "string", description: "q".repeat(2000) } },
				},
			}).length / 4,
		);
		const report = buildContextCompositionReport({
			systemPrompt: "s".repeat(4000),
			tools: [
				{
					name: "mega_tool",
					description: "d".repeat(8000),
					providerDescription: "Search the external index.",
					parameters: {
						type: "object",
						properties: { query: { type: "string", description: "q".repeat(2000) } },
					},
					source: "extension",
				},
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
		expect(report.tools[0]!.schemaTokens).toBeLessThan(rawMegaSchemaTokens * 0.2);
		expect(report.extensions[0]!.activeToolSchemaTokens).toBe(report.tools[0]!.schemaTokens);
		const labels = report.messageClasses.map((row) => row.label);
		expect(labels).toContain("gc-packed stub");
		expect(labels).toContain("memory recall page");
		expect(labels).toContain("user");
		expect(report.estimatedRequestTokens).toBe(
			report.systemPromptTokens + report.toolSchemaTokens + report.messageTokens,
		);
		expect(report.adjustments).toEqual({ memoryEvidenceTokens: 0, enforcementSavedTokens: 0 });
		// Provider projection removes annotation prose, preventing a source-only schema hotspot.
		expect(report.observations.some((line) => line.includes("mega_tool"))).toBe(false);
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
				telemetry: {
					jobsRun: 3,
					parseFailures: 1,
					droppedJobs: 0,
					digestsServed: 2,
					localChars: 4000,
					queued: 2,
					resultsHeld: 3,
				},
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
		expect(text).toContain("2 digest(s) served into stubs");
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
			expect(report.tools.map((tool) => tool.name).sort()).toEqual(
				[
					"artifact_retrieve",
					"ask_question",
					"bash",
					"create_goal",
					"delegate",
					"edit",
					"get_goal",
					"goal",
					"improvement_loop",
					"pipeline",
					"python",
					"read",
					"run_toolkit_script",
					"runtime_update",
					"secret_store",
					"skill",
					"skill_audit",
					"skillify",
					"task_steps",
					"tool_task",
					"update_goal",
					"write",
					"webfetch",
				].sort(),
			);
			// Ceilings are bloat guards. The aggregate ceiling is intentionally recalibrated to 4,500
			// after the action-discriminated task_steps schema raised the measured surface to 4,134;
			// this preserves roughly 8.9% growth headroom without accepting the proposed 8,000-token slack.
			// Earlier ceilings were recalibrated after
			// provider-tool-projection.ts stopped deleting `type` from enum-bearing schema
			// properties (providers whose function-declaration schema requires `type` per property,
			// e.g. Google's OpenAPI subset, reject the whole tool list with a 400 otherwise — see
			// compactRedundantEnumConstraints). Default surface now also includes skillify,
			// skill_audit, improvement_loop, and the three lifecycle goal tools. Delegate's
			// enum-heavy surface measures 844 tokens. task_steps now measures 1,120 after adding
			// authoritative pipeline linkage and action-discriminated admission; its 1,200-token
			// ceiling preserves roughly 7.1% headroom. skill measures 97 after the names array
			// (several skills load in one call, so a setup no longer costs one turn per skill); its
			// 105-token ceiling preserves roughly 8% headroom (annotations are stripped at the
			// provider boundary, so there is no prose to trim).
			expect(report.toolSchemaTokens).toBeLessThanOrEqual(4_500);
			const toolTokens = new Map(report.tools.map((tool) => [tool.name, tool.schemaTokens]));
			expect(toolTokens.get("skill")).toBeLessThanOrEqual(105);
			expect(toolTokens.get("delegate")).toBeLessThanOrEqual(875);
			expect(toolTokens.get("task_steps")).toBeLessThanOrEqual(1_200);
			expect(toolTokens.get("secret_store")).toBeLessThanOrEqual(330);
			expect(toolTokens.get("goal")).toBeLessThanOrEqual(280);
			expect(toolTokens.get("pipeline")).toBeLessThanOrEqual(220);
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

describe("send-time adjustments", () => {
	it("folds the memory evidence block in and the enforcement stub savings out", () => {
		const report = buildContextCompositionReport({
			systemPrompt: "p".repeat(400),
			tools: [],
			extensions: [],
			messages: [user("hello")],
			providerReportedTokens: null,
			contextWindow: null,
			adjustments: { memoryEvidenceTokens: 300, enforcementSavedTokens: 120 },
		});
		expect(report.estimatedRequestTokens).toBe(report.systemPromptTokens + report.messageTokens + 300 - 120);
		const text = formatContextCompositionDashboard(report);
		expect(text).toContain("send-time adjustments: +300 memory evidence, -120 policy stubs");
	});
});
