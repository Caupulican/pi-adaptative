import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

const ULTRA_POLICY_HEADING = "Pi Ultra orchestration policy";

describe("AgentSession Ultra orchestration", () => {
	it("reinforces delegation only while Ultra is selected", async () => {
		const harness = await createHarness({ models: [{ id: "sol", reasoning: true, contextWindow: 372_000 }] });
		try {
			const model = harness.session.model;
			if (!model) throw new Error("Expected harness model");
			model.thinkingLevelMap = { max: "max", ultra: "max" };

			harness.session.setThinkingLevel("ultra");
			expect(harness.session.systemPrompt).toContain(ULTRA_POLICY_HEADING);
			expect(harness.session.systemPrompt).toContain("Proactively use the delegate tool");

			harness.session.setThinkingLevel("max");
			expect(harness.session.systemPrompt).not.toContain(ULTRA_POLICY_HEADING);
		} finally {
			harness.cleanup();
		}
	});

	it("does not advertise reinforced delegation when the user or active tool profile disables it", async () => {
		const disabledHarness = await createHarness({
			models: [{ id: "sol", reasoning: true, contextWindow: 372_000 }],
			settings: { workerDelegation: { enabled: false } },
		});
		const filteredHarness = await createHarness({
			models: [{ id: "sol", reasoning: true, contextWindow: 372_000 }],
			excludedToolNames: ["delegate"],
		});
		try {
			for (const harness of [disabledHarness, filteredHarness]) {
				const model = harness.session.model;
				if (!model) throw new Error("Expected harness model");
				model.thinkingLevelMap = { max: "max", ultra: "max" };
				harness.session.setThinkingLevel("ultra");
				expect(harness.session.systemPrompt).not.toContain(ULTRA_POLICY_HEADING);
			}
		} finally {
			disabledHarness.cleanup();
			filteredHarness.cleanup();
		}
	});

	it("removes Ultra policy for a routed Luna/max turn and restores it afterward", async () => {
		const harness = await createHarness({
			models: [
				{ id: "sol", reasoning: true, contextWindow: 372_000 },
				{ id: "luna", reasoning: true, contextWindow: 372_000 },
			],
			settings: {
				modelRouter: { enabled: true, judgeEnabled: false, cheapModel: "faux/luna", cheapThinking: "max" },
			},
		});
		try {
			const sol = harness.session.model;
			const luna = harness.session.modelRegistry.find("faux", "luna");
			if (!sol || !luna) throw new Error("Expected routed models");
			sol.thinkingLevelMap = { max: "max", ultra: "max" };
			luna.thinkingLevelMap = { max: "max" };
			harness.session.setThinkingLevel("ultra");

			let routedPrompt = "";
			let routedReasoning: string | undefined;
			harness.setResponses([
				(context, options) => {
					routedPrompt = context.systemPrompt ?? "";
					routedReasoning = options?.reasoning;
					return fauxAssistantMessage("Routed.");
				},
			]);

			await harness.session.prompt("Explain this code block", { autoContinueGoal: false });

			expect(routedReasoning).toBe("max");
			expect(routedPrompt).not.toContain(ULTRA_POLICY_HEADING);
			expect(harness.session.thinkingLevel).toBe("ultra");
			expect(harness.session.systemPrompt).toContain(ULTRA_POLICY_HEADING);
		} finally {
			harness.cleanup();
		}
	});

	it("applies a same-model tier thinking override without leaking the Ultra policy", async () => {
		const harness = await createHarness({
			models: [{ id: "sol", reasoning: true, contextWindow: 372_000 }],
			settings: {
				modelRouter: { enabled: true, judgeEnabled: false, cheapModel: "faux/sol", cheapThinking: "max" },
			},
		});
		try {
			const sessionModel = harness.session.model;
			const registryModel = harness.session.modelRegistry.find("faux", "sol");
			if (!sessionModel || !registryModel) throw new Error("Expected same routed model");
			sessionModel.thinkingLevelMap = { max: "max", ultra: "max" };
			registryModel.thinkingLevelMap = { max: "max", ultra: "max" };
			harness.session.setThinkingLevel("ultra");

			let routedPrompt = "";
			let routedReasoning: string | undefined;
			harness.setResponses([
				(context, options) => {
					routedPrompt = context.systemPrompt ?? "";
					routedReasoning = options?.reasoning;
					return fauxAssistantMessage("Same model routed.");
				},
			]);

			await harness.session.prompt("Explain this code block", { autoContinueGoal: false });

			expect(routedReasoning).toBe("max");
			expect(routedPrompt).not.toContain(ULTRA_POLICY_HEADING);
			expect(harness.session.thinkingLevel).toBe("ultra");
			expect(harness.session.systemPrompt).toContain(ULTRA_POLICY_HEADING);
		} finally {
			harness.cleanup();
		}
	});
});
