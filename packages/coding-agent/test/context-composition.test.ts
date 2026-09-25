import { projectToolSchemaForProvider } from "@caupulican/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	buildContextCompositionReport,
	formatContextCompositionDashboard,
} from "../src/core/context/context-composition.ts";
import { createHarness } from "./test-harness.ts";

// The schema budget below measures every default tool's definition without importing it.
// @guards src/core/tools/ src/core/default-tool-surface.ts src/core/improvement-loop.ts
// @guards src/core/compaction/self-compaction.ts ../agent/src/provider-tool-projection.ts

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
					"decision_ledger_read",
					"delegate",
					"edit",
					"get_goal",
					"goal",
					"improvement_loop",
					"pipeline",
					"python",
					"read",
					"repo_read",
					"run_toolkit_script",
					"runtime_update",
					"secret_store",
					"self_compact",
					"skill",
					"skill_audit",
					"skillify",
					"task_automation",
					"task_directory",
					"task_steps",
					"tool_task",
					"typesafe_review",
					"update_goal",
					"write",
					"webfetch",
				].sort(),
			);
			// Ceilings are bloat guards. Persistent project routing deliberately adds task_directory
			// (132 measured tokens, 350 ceiling including the bounded status cursor) to the previous
			// 4,500-token aggregate allowance. Task-local deterministic automation deliberately adds
			// task_automation (681 measured tokens, 720 ceiling preserving roughly 5.7% headroom)
			// covering action-discriminated lifecycle contracts (spec, validate, run, bind, status).
			// Account for those deliberate additions separately: the pre-existing tool surface keeps
			// its original budget, not extra slack.
			// Earlier ceilings were recalibrated after
			// provider-tool-projection.ts stopped deleting `type` from enum-bearing schema
			// properties (providers whose function-declaration schema requires `type` per property,
			// e.g. Google's OpenAPI subset, reject the whole tool list with a 400 otherwise — see
			// compactRedundantEnumConstraints). Default surface now also includes skillify,
			// skill_audit, improvement_loop, and the three lifecycle goal tools. Delegate's
			// enum-heavy surface measures 864 tokens (875 ceiling). task_steps measures 607 tokens
			// (1,200 ceiling). skill measures 150 tokens (160 ceiling, roughly 6.7% headroom) after
			// deliberate additions for inspect, versioned repair with versionToken, and session-wide
			// exclude with reason. goal measured 330 tokens before requirement checks (see the
			// goal-checks allowance below). Its closed edgeClass enum adds 28 tokens to the prior 295-token surface;
			// provider projection already strips descriptions and compacts literal unions. Those
			// six exact values prevent invented grants; the aggregate allowance remains unchanged.
			// The requested Jev tool gets its own 512-token policy ceiling inside the unchanged
			// aggregate allowance. Its actual cost is removed only from the pre-Jev subtotal,
			// so unused Jev allowance cannot hide growth in the original tool surface.
			// The decision ledger's read tool (System One's bounded ledger query, root only) gets its
			// own 100-token ceiling on the same terms: added to the aggregate, removed from the base
			// subtotal by its actual cost, never a slack for the pre-existing surface.
			// repo_read is the root git read now that bash refuses raw git. Measured 143 tokens.
			// Requirement checks and owner amendments are a deliberate goal addition: the check object
			// on goal and in create_goal's requirements, plus amend_goal and set_requirement_check.
			// Measured growth over the prior surfaces (goal 330, create_goal 84): 162 tokens. The base
			// subtotal removes only that measured growth, never the whole allowance.
			const goalChecksAllowance = 162;
			expect(
				report.toolSchemaTokens,
				JSON.stringify(report.tools.map(({ name, schemaTokens }) => ({ name, schemaTokens }))),
			).toBeLessThanOrEqual(4_500 + 350 + 720 + 100 + 143 + 140 + goalChecksAllowance);
			const toolTokens = new Map(report.tools.map((tool) => [tool.name, tool.schemaTokens]));
			expect(toolTokens.get("goal")).toBeLessThanOrEqual(399);
			expect(toolTokens.get("create_goal")).toBeLessThanOrEqual(177);
			const goalChecksGrowth = toolTokens.get("goal")! - 330 + (toolTokens.get("create_goal")! - 84);
			expect(toolTokens.get("task_directory")).toBeLessThanOrEqual(350);
			expect(toolTokens.get("task_automation")).toBeLessThanOrEqual(720);
			expect(toolTokens.get("typesafe_review")).toBeGreaterThan(0);
			expect(toolTokens.get("typesafe_review")).toBeLessThanOrEqual(512);
			expect(toolTokens.get("decision_ledger_read")).toBeGreaterThan(0);
			expect(toolTokens.get("decision_ledger_read")).toBeLessThanOrEqual(100);
			expect(toolTokens.get("repo_read")).toBeGreaterThan(0);
			expect(toolTokens.get("repo_read")).toBeLessThanOrEqual(143);
			expect(toolTokens.get("self_compact")).toBeGreaterThan(0);
			expect(toolTokens.get("self_compact")).toBeLessThanOrEqual(140);
			expect(
				report.toolSchemaTokens -
					toolTokens.get("task_directory")! -
					toolTokens.get("task_automation")! -
					toolTokens.get("typesafe_review")! -
					toolTokens.get("decision_ledger_read")! -
					toolTokens.get("repo_read")! -
					toolTokens.get("self_compact")! -
					goalChecksGrowth,
			).toBeLessThanOrEqual(4_500);
			expect(toolTokens.get("skill")).toBeLessThanOrEqual(160);
			// Explicit independent work adds one bounded object to delegate's wire contract. Keep
			// the old surface's 875-token ceiling and budget this addition independently.
			const delegate = harness.agent.state.tools.find((tool) => tool.name === "delegate")!;
			const parameters = delegate.parameters as { properties: Record<string, unknown> };
			const { parallelWork, ...priorProperties } = parameters.properties;
			expect(parallelWork).toBeDefined();
			const priorReport = buildContextCompositionReport({
				systemPrompt: "",
				tools: [{ ...delegate, parameters: { ...parameters, properties: priorProperties } }],
				extensions: [],
				messages: [],
				providerReportedTokens: null,
				contextWindow: null,
			});
			expect(priorReport.tools[0].schemaTokens).toBeLessThanOrEqual(875);
			const parallelTokens = Math.ceil(
				(JSON.stringify({ parallelWork: projectToolSchemaForProvider(parallelWork) }).length - 1) / 4,
			);
			expect(parallelTokens).toBeLessThanOrEqual(75);
			expect(toolTokens.get("delegate")).toBeLessThanOrEqual(875 + parallelTokens);
			expect(toolTokens.get("task_steps")).toBeLessThanOrEqual(1_200);
			expect(toolTokens.get("secret_store")).toBeLessThanOrEqual(330);
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
