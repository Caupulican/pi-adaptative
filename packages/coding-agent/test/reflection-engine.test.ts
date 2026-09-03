import type { Usage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { OKF_MEMORY_LIMITS } from "../src/core/context/okf-memory.ts";
import {
	type DemandSignals,
	decideDemand,
	MAX_REFLECTION_SCAN_ENTRIES,
	MAX_REFLECTION_WRITES,
	ReflectionEngine,
	type ReflectionInput,
} from "../src/core/learning/reflection-engine.ts";
import { MAX_ACTIVE_SKILL_BODY_BYTES } from "../src/core/skill-vault.ts";
import { MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_NAME_LENGTH } from "../src/core/skills.ts";

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
			existingMemory: "Other hot fact\nKnown decision text\nAnother hot fact",
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

	it("rejects a sourceText substring of a current hot-memory fact", async () => {
		const result = await new ReflectionEngine().reflect({
			recentTurnText: "Organize a claimed decision.",
			existingMemory: "Decision: use artifacts",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async () => ({
				text: '```json\n{"writes":[{"kind":"okf_organize","type":"Design Decision","title":"Artifact output","description":"Large output uses artifacts.","scope":"project","text":"Store large output as artifacts.","sourceText":"Decision","evidenceRefs":["transcript:entry-3"]}]}\n```',
				usage: defaultUsage,
				stopReason: "stop",
			}),
		});

		expect(result.writes).toEqual([]);
	});

	it("accepts organization of a fact from either hot-memory section of the rendered block, never from USER.md or OKF", async () => {
		const rendered = [
			"=== Persistent Memory (file-store) ===",
			"## MEMORY.md (general):\nGeneral fact",
			"## MEMORY.md (project pi-adaptative):\nProject fact",
			"## USER.md:\nUser preference",
			"OKF record text",
		].join("\n\n");
		const organize = (sourceText: string) =>
			`\`\`\`json\n{"writes":[{"kind":"okf_organize","type":"Design Decision","title":"Moved","description":"Moved into OKF.","scope":"project","text":"Structured body.","sourceText":${JSON.stringify(sourceText)},"evidenceRefs":["transcript:entry-4"]}]}\n\`\`\``;
		const reflectOn = async (sourceText: string) =>
			(
				await new ReflectionEngine().reflect({
					recentTurnText: "Organize.",
					existingMemory: rendered,
					plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
					complete: async () => ({ text: organize(sourceText), usage: defaultUsage, stopReason: "stop" }),
				})
			).writes;

		expect(await reflectOn("General fact")).toHaveLength(1);
		expect(await reflectOn("Project fact")).toHaveLength(1);
		expect(await reflectOn("User preference")).toEqual([]);
		expect(await reflectOn("OKF record text")).toEqual([]);
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

	it("bounds the number of accepted reflection writes", async () => {
		const result = await new ReflectionEngine().reflect({
			recentTurnText: "Record the bounded facts.",
			existingMemory: "",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async () => ({
				text: `\`\`\`json\n${JSON.stringify({
					writes: Array.from({ length: MAX_REFLECTION_WRITES + 1 }, (_, index) => ({
						kind: "memory_add",
						section: "MEMORY",
						text: `fact-${index}`,
					})),
				})}\n\`\`\``,
				usage: defaultUsage,
				stopReason: "stop",
			}),
		});

		expect(result.writes).toHaveLength(MAX_REFLECTION_WRITES);
		expect(result.writes.at(-1)).toEqual({
			kind: "memory_add",
			section: "MEMORY",
			text: `fact-${MAX_REFLECTION_WRITES - 1}`,
		});
	});

	it("rejects oversized ordinary memory fields while retaining bounded controls", async () => {
		const writes = [
			{ kind: "memory_add", section: "MEMORY", text: "x".repeat(OKF_MEMORY_LIMITS.bodyChars + 1) },
			{ kind: "memory_replace", target: "x".repeat(OKF_MEMORY_LIMITS.bodyChars + 1), text: "bounded" },
			{ kind: "memory_replace", target: "bounded", text: "x".repeat(OKF_MEMORY_LIMITS.bodyChars + 1) },
			{ kind: "memory_remove", target: "x".repeat(OKF_MEMORY_LIMITS.bodyChars + 1) },
			{ kind: "memory_add", section: "MEMORY", text: "x".repeat(OKF_MEMORY_LIMITS.bodyChars) },
		];
		const result = await new ReflectionEngine().reflect({
			recentTurnText: "Store bounded memory.",
			existingMemory: "",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async () => ({
				text: `\`\`\`json\n${JSON.stringify({ writes })}\n\`\`\``,
				usage: defaultUsage,
				stopReason: "stop",
			}),
		});

		expect(result.writes).toEqual([
			{ kind: "memory_add", section: "MEMORY", text: "x".repeat(OKF_MEMORY_LIMITS.bodyChars) },
		]);
	});

	it("counts accepted writes separately from the bounded input scan", async () => {
		const acceptedWrite = { kind: "memory_add", section: "MEMORY", text: "valid after rejected entries" };
		const lateWrite = { kind: "memory_add", section: "MEMORY", text: "outside the bounded scan" };
		const writes = Array.from({ length: MAX_REFLECTION_SCAN_ENTRIES + 1 }, (_, index) =>
			index === MAX_REFLECTION_WRITES
				? acceptedWrite
				: index === MAX_REFLECTION_SCAN_ENTRIES
					? lateWrite
					: { kind: "unsupported" },
		);
		const result = await new ReflectionEngine().reflect({
			recentTurnText: "Record the valid fact.",
			existingMemory: "",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async () => ({
				text: `\`\`\`json\n${JSON.stringify({ writes })}\n\`\`\``,
				usage: defaultUsage,
				stopReason: "stop",
			}),
		});

		expect(result.writes).toEqual([acceptedWrite]);
	});

	it("bounds promote_skill name, description, and body fields", async () => {
		const oversizedWrites = [
			{ kind: "promote_skill", name: "x".repeat(MAX_SKILL_NAME_LENGTH + 1), description: "ok", body: "ok" },
			{
				kind: "promote_skill",
				name: "ok",
				description: "x".repeat(MAX_SKILL_DESCRIPTION_LENGTH + 1),
				body: "ok",
			},
			{
				kind: "promote_skill",
				name: "ok",
				description: "ok",
				body: "x".repeat(MAX_ACTIVE_SKILL_BODY_BYTES + 1),
			},
			{
				kind: "promote_skill",
				name: "a".repeat(MAX_SKILL_NAME_LENGTH),
				description: "x".repeat(MAX_SKILL_DESCRIPTION_LENGTH),
				body: "x".repeat(MAX_ACTIVE_SKILL_BODY_BYTES),
			},
		];
		const result = await new ReflectionEngine().reflect({
			recentTurnText: "Promote the bounded workflow.",
			existingMemory: "",
			plan: { act: "reflect", reason: "test", tokenBudget: 1000 },
			complete: async () => ({
				text: `\`\`\`json\n${JSON.stringify({ writes: oversizedWrites })}\n\`\`\``,
				usage: defaultUsage,
				stopReason: "stop",
			}),
		});

		expect(result.writes).toEqual([oversizedWrites[3]]);
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
