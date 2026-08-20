import { describe, expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

describe("model switch capability ordering", () => {
	it("keeps Grok reasoning independent from fast mode on a model switch", async () => {
		const harness = await createHarness({
			fauxProvider: { api: "openai-responses", provider: "xai" },
			models: [
				{ id: "grok-4.5", reasoning: true },
				{ id: "grok-4.6", reasoning: true },
			],
			settings: { fastMode: { xai: true } },
		});

		try {
			const thinkingLevel = harness.session.thinkingLevel;
			await harness.session.setModel(harness.getModel("grok-4.6")!);

			expect(harness.session.thinkingLevel).toBe(thinkingLevel);
		} finally {
			await harness.cleanup();
		}
	});

	it("model_select handlers observe the new model's tools and system prompt", async () => {
		let observedTools: string[] | undefined;
		let observedPrompt: string | undefined;
		const harness = await createHarness({
			models: [
				{ id: "big-model", contextWindow: 200_000 },
				{ id: "small-model", contextWindow: 8_192 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (_event, ctx) => {
						observedTools = pi.getActiveTools();
						observedPrompt = ctx.getSystemPrompt();
					});
				},
			],
		});

		try {
			await harness.session.setModel(harness.getModel("small-model")!);

			expect(observedTools).toEqual([
				"read",
				"skill",
				"bash",
				"python",
				"edit",
				"write",
				"create_goal",
				"get_goal",
				"update_goal",
				"ask_question",
				"run_toolkit_script",
				"artifact_retrieve",
			]);
			expect(observedPrompt).not.toContain("Delegate a bounded read-only analysis subtask");
		} finally {
			harness.cleanup();
		}
	});
});
