import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it } from "vitest";
import { DELEGATION_DECISION_RULE } from "../src/core/provider-prompt-contracts.ts";
import { createHarness } from "./suite/harness.ts";

const DELEGATION_POLICY_HEADING = "PI DELEGATION";
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

describe("AgentSession provider-neutral delegation orchestration", () => {
	it("advertises delegation whenever the tool is active, independent of reasoning level", async () => {
		const harness = await createHarness({ models: [{ id: "sol", reasoning: true, contextWindow: 372_000 }] });
		try {
			const model = harness.session.model;
			if (!model) throw new Error("Expected harness model");
			model.thinkingLevelMap = { xhigh: "xhigh", max: "max", ultra: "max" };

			const initialPrompt = harness.session.systemPrompt;
			for (const level of REASONING_LEVELS) {
				harness.session.setThinkingLevel(level);
				expect(harness.session.thinkingLevel).toBe(level);
				expect(harness.session.systemPrompt).toBe(initialPrompt);
				expect(harness.session.systemPrompt).toContain("You must delegate bounded independent work");
				expect(harness.session.systemPrompt).toContain("regardless of provider or reasoning level");
			}
			expect(harness.session.systemPrompt).toContain(DELEGATION_POLICY_HEADING);
			expect(harness.session.systemPrompt).toContain(DELEGATION_DECISION_RULE);
			expect(harness.session.systemPrompt).toContain(
				"ceilings come only from host settings or an owner-authored profileId",
			);

			harness.session.setThinkingLevel("ultra");
			expect(harness.session.systemPrompt).toContain(DELEGATION_POLICY_HEADING);
		} finally {
			harness.cleanup();
		}
	});

	// The faux model chooses dispatch explicitly: this proves delivery and host execution,
	// not that a real model will always recognize when delegation is useful.
	it.each(REASONING_LEVELS)("executes an admitted worker and publishes its terminal at %s", async (level) => {
		const harness = await createHarness({
			models: [{ id: "reasoner", reasoning: true, contextWindow: 372_000 }],
		});
		const terminal = Promise.withResolvers<void>();
		const unsubscribe = harness.session.subscribe((event) => {
			if (
				event.type === "delegate_workers" &&
				event.terminalSinceFlush.some((record) => record.status === "succeeded")
			) {
				terminal.resolve();
			}
		});
		let workerRequests = 0;
		try {
			harness.getModel().thinkingLevelMap = { xhigh: "xhigh", max: "max", ultra: "max" };
			harness.session.setThinkingLevel(level);
			expect(harness.session.thinkingLevel).toBe(level);
			const reply: FauxResponseFactory = (context) => {
				if (context.systemPrompt?.includes("Autonomous leaf worker")) {
					workerRequests++;
					expect(context.systemPrompt).not.toContain(DELEGATION_POLICY_HEADING);
					return fauxAssistantMessage(
						'{"summary":"Independent review complete","status":"completed","findings":[]}',
					);
				}
				expect(context.systemPrompt).toContain(DELEGATION_DECISION_RULE);
				return fauxAssistantMessage("Parent work continues.");
			};
			harness.setResponses([
				(context) => {
					expect(context.systemPrompt).toContain(DELEGATION_DECISION_RULE);
					return fauxAssistantMessage(
						[fauxToolCall("delegate", { instructions: "Independently review the supplied contract." })],
						{ stopReason: "toolUse" },
					);
				},
				reply,
				reply,
				reply,
			]);
			await harness.session.prompt("Review the contract while I address the independent implementation.", {
				autoContinueGoal: false,
			});
			await terminal.promise;
			expect(workerRequests).toBe(1);
			expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(1);
		} finally {
			unsubscribe();
			await harness.cleanup();
		}
	});

	it("does not force a worker or an extra provider turn for a solo response", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([
				(context) => {
					expect(context.systemPrompt).toContain(DELEGATION_DECISION_RULE);
					return fauxAssistantMessage("Two.");
				},
			]);
			await harness.session.prompt("What is 1 + 1?", { autoContinueGoal: false });
			expect(harness.session.getWorkerClaimSnapshots()).toHaveLength(0);
			expect(harness.session.getLaneRecords().filter((record) => record.type === "worker")).toHaveLength(0);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			await harness.cleanup();
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
				model.thinkingLevelMap = { xhigh: "xhigh", max: "max", ultra: "max" };
				for (const level of REASONING_LEVELS) {
					harness.session.setThinkingLevel(level);
					expect(harness.session.thinkingLevel).toBe(level);
					expect(harness.session.systemPrompt).not.toContain(DELEGATION_POLICY_HEADING);
					expect(harness.session.systemPrompt).not.toContain(DELEGATION_DECISION_RULE);
					expect(harness.session.systemPrompt).not.toContain("Parent owns integration, verification");
				}
			}
			expect(
				await disabledHarness.session.runWorkerDelegationOnce({ instructions: "Try despite disabled delegation" }),
			).toMatchObject({ started: false, skipReason: "worker_delegation_disabled" });
			expect(disabledHarness.session.getLaneRecords().filter((record) => record.type === "worker")).toHaveLength(0);
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
			expect(routedPrompt).toContain(DELEGATION_DECISION_RULE);
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
