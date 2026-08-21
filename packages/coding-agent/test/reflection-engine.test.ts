import type { Usage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type DemandSignals,
	decideDemand,
	ReflectionEngine,
	type ReflectionInput,
} from "../src/core/learning/reflection-engine.ts";

describe("Reflection Engine - decideDemand (heuristic demand-gate)", () => {
	const defaultSignals: DemandSignals = {
		trigger: "none",
		toolCallCount: 0,
		hadCorrection: false,
		contextHeadroomPct: 100,
		usefulLately: 0,
	};

	it("skips if trigger is none", () => {
		const plan = decideDemand({ ...defaultSignals, trigger: "none" });
		expect(plan.act).toBe("skip");
		expect(plan.tokenBudget).toBe(0);
	});

	it("skips if context headroom is critically low", () => {
		const plan = decideDemand({
			...defaultSignals,
			trigger: "session-end",
			contextHeadroomPct: 5,
		});
		expect(plan.act).toBe("skip");
		expect(plan.reason).toContain("headroom");
	});

	it("reflects on correction with appropriate budget", () => {
		const plan = decideDemand({
			...defaultSignals,
			trigger: "complex",
			hadCorrection: true,
			contextHeadroomPct: 80,
		});
		expect(plan.act).toBe("reflect");
		expect(plan.reason).toContain("Correction");
		expect(plan.tokenBudget).toBe(800);
	});

	it("reflects on session-end", () => {
		const plan = decideDemand({
			...defaultSignals,
			trigger: "session-end",
			contextHeadroomPct: 90,
		});
		expect(plan.act).toBe("reflect");
		expect(plan.tokenBudget).toBe(900);
	});

	it("reflects on complex trigger with high tool usage", () => {
		const plan = decideDemand({
			...defaultSignals,
			trigger: "complex",
			toolCallCount: 4,
			contextHeadroomPct: 100,
		});
		expect(plan.act).toBe("reflect");
		expect(plan.tokenBudget).toBe(1000);
	});

	it("skips on complex trigger with low tool usage", () => {
		const plan = decideDemand({
			...defaultSignals,
			trigger: "complex",
			toolCallCount: 1,
			contextHeadroomPct: 100,
		});
		expect(plan.act).toBe("skip");
	});
});

describe("Reflection Engine - reflect (learning mechanism)", () => {
	const defaultUsage: Usage = {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
	};

	it("parses valid json memory additions, replacements, and removals", async () => {
		const mockResponse = {
			text: `
Some conversational prelude.
\`\`\`json
{
  "rationale": "Updating project facts and user preferences.",
  "writes": [
    { "kind": "memory_add", "section": "MEMORY", "text": "Deploy command is npm run check." },
    { "kind": "memory_replace", "target": "Prefer npm ci", "text": "Prefer npm install --ignore-scripts" },
    { "kind": "memory_remove", "target": "Obsolete fact here" }
  ]
}
\`\`\`
`,
			usage: defaultUsage,
			stopReason: "stop",
		};

		const engine = new ReflectionEngine();
		const input: ReflectionInput = {
			recentTurnText: "User asked to deploy via check and use npm install.",
			existingMemory: "MEMORY:\nPrefer npm ci\nObsolete fact here",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async (system, user) => {
				expect(system).toContain("Reflection engine");
				expect(system).toContain("untrusted_content");
				expect(user).toContain("Recent turn transcript");
				return mockResponse;
			},
		};

		const result = await engine.reflect(input);
		expect(result.rationale).toBe("Updating project facts and user preferences.");
		expect(result.usage).toEqual(defaultUsage);
		expect(result.writes).toEqual([
			{ kind: "memory_add", section: "MEMORY", text: "Deploy command is npm run check." },
			{ kind: "memory_replace", target: "Prefer npm ci", text: "Prefer npm install --ignore-scripts" },
			{ kind: "memory_remove", target: "Obsolete fact here" },
		]);
	});

	it("routes durable project knowledge to a structured OKF reflection write", async () => {
		const engine = new ReflectionEngine();
		const result = await engine.reflect({
			recentTurnText: "The project chose artifact-backed tool output.",
			existingMemory: "",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async () => ({
				text: '```json\n{"rationale":"durable decision","writes":[{"kind":"okf_add","type":"Design Decision","title":"Artifact-backed tool output","description":"Large output stays out of prompt.","scope":"project","text":"Store large tool output as an artifact and retain its id.","evidenceRefs":["transcript:entry-1"]}]}\n```',
				usage: defaultUsage,
				stopReason: "stop",
			}),
		});

		expect(result.writes).toEqual([
			{
				kind: "okf_add",
				type: "Design Decision",
				title: "Artifact-backed tool output",
				description: "Large output stays out of prompt.",
				scope: "project",
				text: "Store large tool output as an artifact and retain its id.",
				evidenceRefs: ["transcript:entry-1"],
			},
		]);
	});

	it("accepts only explicit exact-text OKF organization writes", async () => {
		const result = await new ReflectionEngine().reflect({
			recentTurnText: "Organize the verified project decision.",
			existingMemory: "Known decision text",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async () => ({
				text: '```json\n{"writes":[{"kind":"okf_organize","type":"Design Decision","title":"Artifact output","description":"Large output uses artifacts.","scope":"project","text":"Store large output as artifacts.","sourceText":"Known decision text","evidenceRefs":["transcript:entry-2"]}]}\n```',
				usage: defaultUsage,
				stopReason: "stop",
			}),
		});
		expect(result.writes[0]).toMatchObject({ kind: "okf_organize", sourceText: "Known decision text" });
	});

	it("rejects organization unless sourceText is an exact current hot-memory fact", async () => {
		const result = await new ReflectionEngine().reflect({
			recentTurnText: "Organize a claimed decision.",
			existingMemory: "Different current decision text",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async () => ({
				text: '```json\n{"writes":[{"kind":"okf_organize","type":"Design Decision","title":"Artifact output","description":"Large output uses artifacts.","scope":"project","text":"Store large output as artifacts.","sourceText":"Missing decision text","evidenceRefs":["transcript:entry-2"]}]}\n```',
				usage: defaultUsage,
				stopReason: "stop",
			}),
		});

		expect(result.writes).toEqual([]);
	});

	it("rejects oversized structured memory fields at the reflection boundary", async () => {
		const result = await new ReflectionEngine().reflect({
			recentTurnText: "Store a decision.",
			existingMemory: "",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async () => ({
				text: `\`\`\`json\n${JSON.stringify({
					writes: [
						{
							kind: "okf_add",
							type: "Design Decision",
							title: "x".repeat(300),
							description: "bounded",
							scope: "project",
							text: "body",
							evidenceRefs: ["transcript:entry-3"],
						},
					],
				})}\n\`\`\``,
				usage: defaultUsage,
				stopReason: "stop",
			}),
		});

		expect(result.writes).toEqual([]);
	});

	it("gracefully falls back on malformed or missing json responses", async () => {
		const mockResponse = {
			text: "No code blocks here, just plain text analysis.",
			usage: defaultUsage,
			stopReason: "stop",
		};

		const engine = new ReflectionEngine();
		const input: ReflectionInput = {
			recentTurnText: "...",
			existingMemory: "",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async () => mockResponse,
		};

		const result = await engine.reflect(input);
		expect(result.writes).toEqual([]);
		expect(result.usage).toEqual(defaultUsage);
		expect(result.rationale).toContain("Failed to locate JSON response");
	});

	it("preserves usage when fenced JSON is malformed", async () => {
		const engine = new ReflectionEngine();
		const result = await engine.reflect({
			recentTurnText: "...",
			existingMemory: "",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async () => ({ text: "```json\n{ bad json\n```", usage: defaultUsage, stopReason: "stop" }),
		});

		expect(result.writes).toEqual([]);
		expect(result.usage).toEqual(defaultUsage);
		expect(result.rationale).toContain("Error during reflection");
	});
});
