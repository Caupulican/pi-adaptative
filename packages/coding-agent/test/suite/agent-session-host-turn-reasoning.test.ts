import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ModelThinkingLevel } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/**
 * A turn the host starts for itself - a background tool or a delegated worker reporting in - is
 * bookkeeping: read the delivered result, cite it, continue. It used to be requested at the full
 * session thinking level, the effort the operator chose for their own questions. These pin that the
 * lowering reaches the real provider request, and that an ordinary prompt is untouched by it.
 */
describe("AgentSession host-turn reasoning", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	async function runBackgroundToolCompletionTurn(settings?: Partial<Parameters<typeof createHarness>[0]>): Promise<{
		harness: Harness;
		reasoning: Array<ModelThinkingLevel | undefined>;
	}> {
		let releaseTool: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		let markStarted: (() => void) | undefined;
		const toolStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				markStarted?.();
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			models: [{ id: "reasoner", reasoning: true }],
			settings: { autoLearn: { reflectionReview: false } },
			tools: [waitTool],
			...settings,
		});
		harnesses.push(harness);
		harness.session.setActiveToolsByName(["wait", "tool_task"]);
		harness.session.setThinkingLevel("high", { persistSettings: false });

		const reasoning: Array<ModelThinkingLevel | undefined> = [];
		const reply = (text: string) => (_context: unknown, options: { reasoning?: ModelThinkingLevel } | undefined) => {
			reasoning.push(options?.reasoning);
			return fauxAssistantMessage(text);
		};
		harness.setResponses([
			(_context, options) => {
				reasoning.push(options?.reasoning);
				return fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" });
			},
			reply("foreground continued"),
			reply("background completion acknowledged"),
		]);

		const promptPromise = harness.session.prompt("start");
		await toolStarted;
		expect(harness.session.backgroundRunningToolCalls()).toBe(1);
		await promptPromise;

		let markAcknowledged!: () => void;
		const acknowledged = new Promise<void>((resolve) => {
			markAcknowledged = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "agent_end" && !event.willRetry && harness.getPendingResponseCount() === 0) {
				markAcknowledged();
			}
		});
		releaseTool?.();
		await acknowledged;
		unsubscribe();
		return { harness, reasoning };
	}

	it("requests the host's own completion turn one level below the session, leaving ordinary turns alone", async () => {
		const { harness, reasoning } = await runBackgroundToolCompletionTurn();

		const completionDelivered = harness.session.messages.some(
			(message) => message.role === "custom" && message.customType === "background-tool-completion",
		);
		expect(completionDelivered).toBe(true);
		// The operator's own prompt and the model's continuation keep the session level; only the
		// request that answers the host-delivered completion is lowered.
		expect(reasoning.slice(0, 2)).toEqual(["high", "high"]);
		expect(reasoning.at(-1)).toBe("medium");

		const decision = harness.session.hostTurnReasoning.getLastDecision();
		expect(decision).toMatchObject({
			customType: "background-tool-completion",
			sessionLevel: "high",
			resolvedLevel: "medium",
			lowered: true,
		});
		expect(harness.session.hostTurnReasoning.getLoweredRequestCount()).toBe(1);
		// The policy is request-local: the session's own level never moves.
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("leaves the host turn at the session level when the operator asks it to inherit", async () => {
		const { harness, reasoning } = await runBackgroundToolCompletionTurn({
			settings: { autoLearn: { reflectionReview: false }, reasoning: { hostTurnThinking: "inherit" } },
		});

		expect(reasoning.every((level) => level === "high")).toBe(true);
		expect(harness.session.hostTurnReasoning.getLoweredRequestCount()).toBe(0);
		expect(harness.session.hostTurnReasoning.getLastDecision()).toMatchObject({ lowered: false });
	});

	it("honours an explicit host-turn level", async () => {
		const { harness, reasoning } = await runBackgroundToolCompletionTurn({
			settings: { autoLearn: { reflectionReview: false }, reasoning: { hostTurnThinking: "minimal" } },
		});

		expect(reasoning.slice(0, 2)).toEqual(["high", "high"]);
		expect(reasoning.at(-1)).toBe("minimal");
		expect(harness.session.hostTurnReasoning.getLoweredRequestCount()).toBe(1);
	});
});
