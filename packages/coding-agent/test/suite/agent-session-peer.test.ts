import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import type { JevAdapter } from "../../src/core/system-one/adapter.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { createHarness } from "./harness.ts";

describe("native peer host integration", () => {
	it("discovers native peer and sends one tool-free peer request at higher effort without switching the lead", async () => {
		const evaluate = vi.fn<JevAdapter["evaluate"]>(async () => ({
			model: "jev-1.13.0",
			latency_ms: 1,
			answers: { route_choice: { type: "choice", choice: "stronger", confidence: 0.99 } },
		}));
		const controller = new SystemOneController({
			store: new ExecutionStore({
				run_id: "peer-host",
				objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
				repo: { root: "/repo", baseline_revision: "r0" },
			}),
			adapter: { evaluate },
		});
		const harness = await createHarness({
			models: [
				{ id: "lead", reasoning: true },
				{ id: "peer", reasoning: true },
			],
			systemOneController: controller,
			settings: { modelRouter: { enabled: false } },
		});
		harness.session.setThinkingLevel("medium");
		expect(harness.session.getActiveToolNames()).toContain("peer");
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("peer");
		expect(harness.session.getToolDefinition("advisor")).toBeUndefined();
		const tool = harness.session.getToolDefinition("peer");
		expect(tool).toBeDefined();
		const context = {} as ExtensionContext;
		const options = await tool!.execute("options", { action: "options" }, undefined, undefined, context);
		const receipt = options.details as { peers: { ref: string; thinkingLevels: string[] }[] };
		const peer = receipt.peers.find((candidate) => candidate.ref.endsWith("/peer"));
		expect(peer?.thinkingLevels).toContain("high");
		harness.setResponses([
			(_context, requestOptions, _state, model) => {
				expect(model.id).toBe("peer");
				expect(requestOptions?.reasoning).toBe("high");
				expect(_context.tools).toEqual([]);
				return fauxAssistantMessage(
					JSON.stringify({
						verdict: "no_findings",
						summary: "No candidate in snapshot.",
						findings: [],
						limitations: ["No actual runtime trace supplied."],
					}),
				);
			},
		]);
		const result = await tool!.execute(
			"peer-review",
			{
				action: "review",
				review: {
					peer: peer!.ref,
					thinkingLevel: "high",
					stage: "plan",
					objective: "Fix resource release",
					artifact: "Release resources when cancelled",
					evidence: "owner.ts: release on cancellation",
				},
			},
			undefined,
			undefined,
			context,
		);
		expect(result).toMatchObject({ isError: false, details: { status: "reviewed", leadMustResolve: true } });
		expect(result.usage?.totalTokens).toBeGreaterThan(0);
		expect(harness.session.model?.id).toBe("lead");
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(controller.peekControlDirective()).toBeUndefined();
		harness.setResponses([
			fauxAssistantMessage(
				JSON.stringify({
					verdict: "findings",
					summary: "Reproduce cancellation ordering.",
					findings: [
						{
							summary: "Potential late release",
							evidence: "Release resources when cancelled",
							requiredCheck: "Cancel while held; assert release once before return.",
						},
					],
					limitations: [],
				}),
			),
		]);
		const findingResult = await tool!.execute(
			"candidate-review",
			{
				action: "review",
				review: {
					peer: peer!.ref,
					thinkingLevel: "high",
					stage: "plan",
					objective: "Fix resource release",
					artifact: "Release resources when cancelled",
					evidence: "owner.ts: release on cancellation",
				},
			},
			undefined,
			undefined,
			context,
		);
		expect(findingResult).toMatchObject({ details: { status: "reviewed" } });
		expect(controller.peekControlDirective()).toMatchObject({
			objectiveRoute: "deterministic_test",
			reasonCodes: expect.arrayContaining([
				"same_lane_verification_required",
				expect.stringContaining("Cancel while held"),
			]),
		});
		const pending = controller.peekControlDirective();
		harness.setResponses([
			fauxAssistantMessage(
				JSON.stringify({ verdict: "no_findings", summary: "No new candidate.", findings: [], limitations: [] }),
			),
		]);
		await tool!.execute(
			"later-review",
			{
				action: "review",
				review: {
					peer: peer!.ref,
					thinkingLevel: "high",
					stage: "delivery",
					objective: "Check revised release",
					artifact: "Release resources when cancelled",
					evidence: "owner.ts: released once",
				},
			},
			undefined,
			undefined,
			context,
		);
		expect(controller.peekControlDirective()).toBe(pending);
	});

	it("reports missing System One as unavailable and never consumes a peer response", async () => {
		const harness = await createHarness({
			models: [
				{ id: "lead", reasoning: true },
				{ id: "peer", reasoning: true },
			],
		});
		harness.session.setThinkingLevel("medium");
		harness.setResponses([fauxAssistantMessage("must never run")]);
		const result = await harness.session.getToolDefinition("peer")!.execute(
			"offline",
			{
				action: "review",
				review: {
					peer: `${harness.getModel().provider}/peer`,
					thinkingLevel: "high",
					stage: "delivery",
					objective: "Check cancellation",
					artifact: "Changed release ordering",
					evidence: "owner.ts: released once",
				},
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(result).toMatchObject({ isError: true, details: { status: "unavailable" } });
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
