import { describe, expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

describe("model switch capability ordering", () => {
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

			expect(observedTools).toEqual(["read", "bash", "edit", "write", "run_toolkit_script", "artifact_retrieve"]);
			expect(observedPrompt).not.toContain("Delegate a bounded read-only analysis subtask");
		} finally {
			harness.cleanup();
		}
	});
});
