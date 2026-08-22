import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { DELEGATION_DECISION_RULE } from "../src/core/provider-prompt-contracts.ts";
import { createHarness } from "./suite/harness.ts";

const DELEGATION_POLICY_HEADING = "PI DELEGATION";

describe("AgentSession provider-neutral delegation orchestration", () => {
	it("advertises delegation whenever the tool is active, independent of reasoning level", async () => {
		const harness = await createHarness({ models: [{ id: "sol", reasoning: true, contextWindow: 372_000 }] });
		try {
			const model = harness.session.model;
			if (!model) throw new Error("Expected harness model");
			model.thinkingLevelMap = { max: "max", ultra: "max" };

			harness.session.setThinkingLevel("max");
			expect(harness.session.systemPrompt).toContain(DELEGATION_POLICY_HEADING);
			expect(harness.session.systemPrompt).toContain(
				"Delegate useful independent research, implementation, tests, or specialist review early",
			);
			expect(harness.session.systemPrompt).toContain(
				"ceilings come only from host settings or an owner-authored profileId",
			);

			harness.session.setThinkingLevel("ultra");
			expect(harness.session.systemPrompt).toContain(DELEGATION_POLICY_HEADING);
		} finally {
			harness.cleanup();
		}
	});

	it("does not advertise delegation when the user or active tool profile disables it", async () => {
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
				expect(harness.session.systemPrompt).not.toContain(DELEGATION_POLICY_HEADING);
				expect(harness.session.systemPrompt).not.toContain(DELEGATION_DECISION_RULE);
				expect(harness.session.systemPrompt).not.toContain("Parent owns integration, verification");
				expect(harness.session.systemPrompt).not.toContain("Delegate independent work within host bounds");
			}
		} finally {
			disabledHarness.cleanup();
			filteredHarness.cleanup();
		}
	});

	it("keeps delegation policy for a routed provider/model turn", async () => {
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
			expect(routedPrompt).toContain(DELEGATION_POLICY_HEADING);
			expect(harness.session.thinkingLevel).toBe("ultra");
			expect(harness.session.systemPrompt).toContain(DELEGATION_POLICY_HEADING);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps delegation policy across a same-model thinking override", async () => {
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
			expect(routedPrompt).toContain(DELEGATION_POLICY_HEADING);
			expect(harness.session.thinkingLevel).toBe("ultra");
			expect(harness.session.systemPrompt).toContain(DELEGATION_POLICY_HEADING);
		} finally {
			harness.cleanup();
		}
	});
});
