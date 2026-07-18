import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Usage } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { estimateContextPromptTokens } from "../../src/core/models/perf-profile.ts";
import { createHarness, type Harness } from "./harness.ts";

function spawnedUsage(costTotal: number): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: costTotal / 2, output: costTotal / 2, cacheRead: 0, cacheWrite: 0, total: costTotal },
	};
}

describe("AgentSession cost guard", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("projects against the session response reserve without imposing a hidden output cap", async () => {
		let requestMaxTokens: number | undefined;
		const harness = await createHarness({
			models: [
				{
					id: "frontier",
					contextWindow: 1_050_000,
					maxTokens: 128_000,
					cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				},
			],
			settings: {
				compaction: { reserveTokens: 16_384 },
				costGuard: { maxTurnUsd: 2.5, action: "warn" },
			},
		});
		harnesses.push(harness);

		harness.setResponses([
			(_context, options) => {
				requestMaxTokens = options?.maxTokens;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("short ordinary turn");

		const decision = harness.session.getLastCostGuardDecision();
		expect(decision).toBeDefined();
		expect(decision?.over).toBe(false);
		expect(decision?.estUsd).toBeLessThan(2.5);
		expect(requestMaxTokens).toBeUndefined();
	});

	it("includes the full system prompt and tool schemas in the foreground projection", async () => {
		let seenSystemPromptLength = 0;
		let seenToolDescriptionLength = 0;
		const harness = await createHarness({
			models: [
				{
					id: "frontier",
					contextWindow: 1_050_000,
					maxTokens: 128_000,
					cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				},
			],
			settings: {
				compaction: { reserveTokens: 16_384 },
				costGuard: { maxTurnUsd: 0.6, action: "warn" },
			},
		});
		harnesses.push(harness);
		const tools = harness.session.agent.state.tools;
		const firstTool = tools[0];
		if (!firstTool) throw new Error("Expected an active tool");
		harness.session.agent.state.systemPrompt = "S".repeat(200_000);
		harness.session.agent.state.tools = [{ ...firstTool, description: "T".repeat(200_000) }, ...tools.slice(1)];

		harness.setResponses([
			(context) => {
				seenSystemPromptLength = context.systemPrompt?.length ?? 0;
				seenToolDescriptionLength = context.tools?.[0]?.description.length ?? 0;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("short message behind a large static prefix");

		const decision = harness.session.getLastCostGuardDecision();
		expect(seenSystemPromptLength).toBeGreaterThan(0);
		expect(seenToolDescriptionLength).toBe(200_000);
		expect(decision?.over).toBe(true);
		expect(decision?.estUsd).toBeGreaterThan(0.6);
	});

	it("projects a GPT-5.6 Sol cache-miss prefix at the possible write rate", async () => {
		let projectedInputTokens = 0;
		const harness = await createHarness({
			models: [
				{
					id: "gpt-5.6-sol",
					contextWindow: 1_050_000,
					maxTokens: 128_000,
					cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				},
			],
			settings: {
				compaction: { reserveTokens: 0 },
				costGuard: { maxTurnUsd: 3.5, action: "warn" },
			},
		});
		harnesses.push(harness);
		const model = harness.session.model;
		if (!model) throw new Error("Expected model");
		model.longContextPricing = { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 };
		const tools = harness.session.agent.state.tools;
		const firstTool = tools[0];
		if (!firstTool) throw new Error("Expected an active tool");
		harness.session.agent.state.tools = [{ ...firstTool, description: "T".repeat(1_185_000) }, ...tools.slice(1)];

		harness.setResponses([
			(context) => {
				projectedInputTokens = estimateContextPromptTokens(context);
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("project this cache-miss turn");

		const decision = harness.session.getLastCostGuardDecision();
		expect(projectedInputTokens).toBeGreaterThan(299_000);
		expect(projectedInputTokens).toBeLessThan(305_000);
		expect(decision?.estUsd).toBeCloseTo((projectedInputTokens * 6.25 * 2) / 1_000_000, 9);
		expect(decision?.over).toBe(true);
	});

	it("does not treat ChatGPT subscription token accounting as USD spend", async () => {
		const harness = await createHarness({
			models: [
				{
					id: "gpt-5.6-sol",
					contextWindow: 372_000,
					maxTokens: 128_000,
					cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				},
			],
			settings: { costGuard: { maxTurnUsd: 0.01, action: "warn" } },
		});
		harnesses.push(harness);
		const model = harness.session.model;
		if (!model) throw new Error("Expected model");
		model.provider = "openai-codex";
		harness.authStorage.set("openai-codex", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("subscription turn");

		expect(harness.session.getLastCostGuardDecision()).toBeUndefined();
	});

	it("applies downgrade to the imminent request without mutating session thinking", async () => {
		let requestReasoning: string | undefined;
		const harness = await createHarness({
			models: [
				{
					id: "frontier",
					reasoning: true,
					contextWindow: 1_050_000,
					maxTokens: 128_000,
					cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				},
			],
			settings: { costGuard: { maxTurnUsd: 0.01, action: "downgrade" } },
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("high");
		harness.setResponses([
			(_context, options) => {
				requestReasoning = options?.reasoning;
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("expensive turn");

		expect(requestReasoning).toBe("medium");
		expect(harness.session.thinkingLevel).toBe("high");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("high");
	});

	it("skips GPT-5.6's unsupported minimal level when downgrading low to off", async () => {
		let requestReasoning: string | undefined = "not-called";
		const harness = await createHarness({
			models: [
				{
					id: "gpt-5.6-sol-style",
					reasoning: true,
					thinkingLevelMap: {
						off: "none",
						minimal: null,
						xhigh: "xhigh",
						max: "max",
						ultra: "max",
					},
					contextWindow: 1_050_000,
					maxTokens: 128_000,
					cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				},
			],
			settings: { costGuard: { maxTurnUsd: 0.01, action: "downgrade" } },
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("low");
		harness.setResponses([
			(_context, options) => {
				requestReasoning = options?.reasoning;
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("expensive low-reasoning turn");

		expect(requestReasoning).toBe("off");
		expect(harness.session.thinkingLevel).toBe("low");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("low");
	});

	it("skips GPT-5.6's equivalent max label when downgrading Ultra", async () => {
		let requestReasoning: string | undefined;
		const harness = await createHarness({
			models: [
				{
					id: "gpt-5.6-sol-style",
					reasoning: true,
					thinkingLevelMap: {
						off: "none",
						minimal: null,
						xhigh: "xhigh",
						max: "max",
						ultra: "max",
					},
					contextWindow: 1_050_000,
					maxTokens: 128_000,
					cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				},
			],
			settings: { costGuard: { maxTurnUsd: 0.01, action: "downgrade" } },
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("ultra");
		harness.setResponses([
			(_context, options) => {
				requestReasoning = options?.reasoning;
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("expensive Ultra turn");

		expect(requestReasoning).toBe("xhigh");
		expect(harness.session.thinkingLevel).toBe("ultra");
		expect(harness.settingsManager.getDefaultThinkingLevel()).toBe("ultra");
	});

	// Turn-cumulative ceiling — background/research/worker/reflection spend recorded via
	// addSpawnedUsage() SINCE THE CURRENT TURN BEGAN is folded into the SAME ceiling the next
	// foreground call is projected against. The window resets at the top of every new prompt(), so a
	// prior turn's background spend does not keep every later turn's guard stuck "over".
	describe("cumulative background spend", () => {
		const bgSpendParams = Type.Object({});

		/** A tool whose execution records background/spawned usage MID-TURN (between round trips). */
		function makeBgSpendTool(
			getHarness: () => Harness,
			costUsd: number,
			reportId: string,
		): AgentTool<typeof bgSpendParams> {
			return {
				name: "bg_spend",
				label: "bg_spend",
				description: "test-only: records background/spawned usage mid-turn",
				parameters: bgSpendParams,
				execute: async () => {
					getHarness().session.addSpawnedUsage(spawnedUsage(costUsd), { label: "mid-turn-lane", reportId });
					return { content: [{ type: "text", text: "ok" }], details: {} };
				},
			};
		}

		it("trips the guard when background spend lands mid-turn (a tool-call round trip)", async () => {
			let harness: Harness;
			const bgSpendTool = makeBgSpendTool(() => harness, 3.0, "mid-turn-lane-1");
			harness = await createHarness({
				models: [
					{
						id: "frontier",
						contextWindow: 1_050_000,
						maxTokens: 128_000,
						cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
					},
				],
				settings: {
					compaction: { reserveTokens: 16_384 },
					costGuard: { maxTurnUsd: 2.5, action: "warn" },
				},
				tools: [bgSpendTool],
			});
			harnesses.push(harness);

			// First round trip calls the tool (which records 3.0 of background spend); the SECOND round
			// trip's guard evaluation is what we assert on -- proving spend that lands mid-turn is
			// attributed to the turn it completes in, not silently dropped.
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bg_spend", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("turn done"),
			]);
			await harness.session.prompt("turn with mid-turn background spend");

			const decision = harness.session.getLastCostGuardDecision();
			expect(decision).toBeDefined();
			expect(decision?.backgroundUsd).toBeCloseTo(3.0, 10);
			expect(decision?.estUsd).toBeLessThan(2.5);
			expect(decision?.totalUsd).toBeGreaterThan(2.5);
			expect(decision?.over).toBe(true);
			// P2: still warn-only by default -- never silently escalated to downgrade.
			expect(decision?.action).toBe("warn");
		});

		it("does not keep the guard over on a later turn once the tripping spend is already baselined", async () => {
			let harness: Harness;
			const bgSpendTool = makeBgSpendTool(() => harness, 3.0, "prior-turn-lane-1");
			harness = await createHarness({
				models: [
					{
						id: "frontier",
						contextWindow: 1_050_000,
						maxTokens: 128_000,
						cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
					},
				],
				settings: {
					compaction: { reserveTokens: 16_384 },
					costGuard: { maxTurnUsd: 2.5, action: "warn" },
				},
				tools: [bgSpendTool],
			});
			harnesses.push(harness);

			// Turn 1: background spend lands mid-turn and trips the guard (mirrors the sibling test).
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bg_spend", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("turn one done"),
			]);
			await harness.session.prompt("turn one");
			expect(harness.session.getLastCostGuardDecision()?.over).toBe(true);

			// Turn 2: a fresh prompt with NO new background spend. Session-lifetime spawned cost is
			// still 3.0, but the guard's baseline resets at the top of this turn, so the attributed
			// delta is 0 -- the guard must NOT still be "over".
			harness.appendResponses([fauxAssistantMessage("turn two done")]);
			await harness.session.prompt("turn two");

			const decision = harness.session.getLastCostGuardDecision();
			expect(decision?.backgroundUsd).toBeCloseTo(0, 10);
			expect(decision?.over).toBe(false);
		});

		it("does not warn when foreground + this-turn background spend together stay under the ceiling", async () => {
			let harness: Harness;
			const bgSpendTool = makeBgSpendTool(() => harness, 0.1, "mid-turn-lane-2");
			harness = await createHarness({
				models: [
					{
						id: "frontier",
						contextWindow: 1_050_000,
						maxTokens: 128_000,
						cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
					},
				],
				settings: {
					compaction: { reserveTokens: 16_384 },
					costGuard: { maxTurnUsd: 2.5, action: "warn" },
				},
				tools: [bgSpendTool],
			});
			harnesses.push(harness);

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bg_spend", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("turn done"),
			]);
			await harness.session.prompt("turn with small mid-turn background spend");

			const decision = harness.session.getLastCostGuardDecision();
			expect(decision?.backgroundUsd).toBeCloseTo(0.1, 10);
			expect(decision?.over).toBe(false);
		});
	});
});
