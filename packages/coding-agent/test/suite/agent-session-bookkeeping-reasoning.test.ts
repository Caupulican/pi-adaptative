import { fauxAssistantMessage, fauxToolCall, type ModelThinkingLevel } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * The request that answers only a `task_steps` or `goal` result is a bookkeeping continuation: the
 * model just recorded harness state and is about to carry on. It ran at the full session thinking
 * level; it now runs at `low` (clamped), and the request after the next real tool result is back at
 * the session level. These pin that the lowering reaches the real provider request.
 */
describe("AgentSession bookkeeping-continuation reasoning", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	async function run(settings?: Partial<Parameters<typeof createHarness>[0]>): Promise<{
		harness: Harness;
		reasoning: Array<ModelThinkingLevel | undefined>;
		toolNames: string[];
	}> {
		const harness = await createHarness({
			models: [{ id: "reasoner", reasoning: true }],
			settings: { autoLearn: { reflectionReview: false } },
			...settings,
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["task_steps", "read"]);
		harness.session.setThinkingLevel("high", { persistSettings: false });

		const reasoning: Array<ModelThinkingLevel | undefined> = [];
		harness.setResponses([
			(_context, options) => {
				reasoning.push(options?.reasoning);
				return fauxAssistantMessage(fauxToolCall("task_steps", { action: "list" }), { stopReason: "toolUse" });
			},
			(_context, options) => {
				reasoning.push(options?.reasoning);
				return fauxAssistantMessage(fauxToolCall("read", { path: "does-not-exist.txt" }), {
					stopReason: "toolUse",
				});
			},
			(_context, options) => {
				reasoning.push(options?.reasoning);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("record a step, then read a file");
		const toolNames = harness.session.messages.flatMap((message) =>
			message.role === "toolResult" ? [message.toolName] : [],
		);
		return { harness, reasoning, toolNames };
	}

	it("proposes low after a bookkeeping result, and cache custody keeps the warm lane at its sent level", async () => {
		const { harness, reasoning, toolNames } = await run();
		expect(toolNames).toEqual(["task_steps", "read"]);
		// The lane's cache is warm, so the lowering would cost a cache write: every request keeps "high".
		expect(reasoning).toEqual(["high", "high", "high"]);
		expect(harness.session.hostTurnReasoning.getLastDecision()).toMatchObject({
			kind: "bookkeeping",
			tools: ["task_steps"],
			resolvedLevel: "low",
			lowered: true,
			held: true,
		});
		expect(harness.session.hostTurnReasoning.getLoweredRequestCount()).toBe(0);
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("keeps every request at the session level when the operator asks the policy to inherit", async () => {
		const { reasoning } = await run({
			settings: { autoLearn: { reflectionReview: false }, reasoning: { bookkeepingThinking: "inherit" } },
		});
		expect(reasoning).toEqual(["high", "high", "high"]);
	});
});
