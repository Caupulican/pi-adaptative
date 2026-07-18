import type { AgentTool } from "@caupulican/pi-agent-core";
import { convertToLlm } from "@caupulican/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTurnCostUsd } from "../../../src/core/cost-guard.ts";
import { estimateContextPromptTokens } from "../../../src/core/models/perf-profile.ts";
import { createHarness, type Harness } from "../harness.ts";

const bigOutputParams = Type.Object({});

/**
 * Test-only tool: returns a huge tool result so a later round trip's context-GC pass has
 * something meaningful to pack down before the next LLM request is priced.
 */
function makeBigOutputTool(blob: string): AgentTool<typeof bigOutputParams> {
	return {
		name: "big_output",
		label: "big_output",
		description: "test-only: returns a large blob to exercise context GC packing",
		parameters: bigOutputParams,
		execute: async () => ({ content: [{ type: "text", text: blob }], details: {} }),
	};
}

// Pins the pipeline-order invariant that agent-loop.ts's streamAssistantResponse applies
// `transformContext` (compaction/GC/enforcement/memory block) to the outgoing messages BEFORE
// building the llmContext that `resolveRequestReasoning` (the cost guard's estimator, wired in
// agent-session.ts) is evaluated against. Currently correct by construction; this test fails if
// that order is ever inverted.
describe("pipeline order: transformContext completes before the cost-guard estimate", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("prices the request against the GC-packed context, not the raw pre-transform context", async () => {
		const BLOB_MARKER = "RAW-BIG-OUTPUT-MARKER";
		const hugeBlob = `${BLOB_MARKER}\n${"x".repeat(2_000_000)}`;

		let capturedContext: Context | undefined;
		const harness = await createHarness({
			models: [
				{
					id: "frontier",
					contextWindow: 5_000_000,
					maxTokens: 128_000,
					cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
				},
			],
			settings: {
				// Disabled so the scenario isolates context-GC packing from auto-compaction; reserveTokens
				// still feeds the cost guard's output-token projection (see getCompactionReserveTokens()).
				compaction: { enabled: false, reserveTokens: 256 },
				// preserveRecentMessages: 0 makes every completed tool result immediately GC-eligible, so
				// the SAME round trip that produced the huge tool result already sees it packed on the
				// very next transform pass -- no padding messages needed to push it out of the window.
				contextGc: { preserveRecentMessages: 0, tools: ["big_output"] },
				costGuard: { maxTurnUsd: 2.5, action: "warn" },
			},
			tools: [makeBigOutputTool(hugeBlob)],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("big_output", {})], { stopReason: "toolUse" }),
			(context) => {
				capturedContext = context;
				return fauxAssistantMessage("turn done");
			},
		]);
		await harness.session.prompt("call the big tool");

		const decision = harness.session.getLastCostGuardDecision();
		expect(decision).toBeDefined();
		if (!decision || !capturedContext) throw new Error("expected a cost-guard decision and a captured context");

		// Sanity: the request actually sent to the provider -- and, by the same llmContext object
		// reference, what the cost guard estimated against (agent-loop.ts builds llmContext once and
		// passes it to both resolveRequestReasoning and the stream function) -- carries the packed
		// stub, not the raw blob.
		const capturedSerialized = JSON.stringify(capturedContext.messages);
		expect(capturedSerialized).not.toContain(BLOB_MARKER);
		expect(capturedSerialized).toContain("Context GC packed stale tool result");

		// Reconstruct the RAW pre-transform messages for that same round trip. GC's output is
		// ephemeral (never written back to agent.state.messages), so the untouched huge tool result
		// is still sitting in session state after the turn. The final assistant reply is the only
		// message appended after the round trip under inspection.
		const postTurnMessages = harness.session.agent.state.messages;
		const rawMessages = postTurnMessages.slice(0, postTurnMessages.length - 1);
		expect(JSON.stringify(rawMessages)).toContain(BLOB_MARKER);

		const model = harness.getModel();
		const maxOutputTokens = harness.settingsManager.getCompactionReserveTokens();
		const rawContext: Context = {
			systemPrompt: capturedContext.systemPrompt,
			messages: convertToLlm(rawMessages),
			tools: capturedContext.tools,
		};
		const rawEstUsd = estimateTurnCostUsd({
			inputTokens: estimateContextPromptTokens(rawContext),
			maxOutputTokens,
			cost: model.cost,
			longContextPricing: model.longContextPricing,
		});
		const postEstUsd = estimateTurnCostUsd({
			inputTokens: estimateContextPromptTokens(capturedContext),
			maxOutputTokens,
			cost: model.cost,
			longContextPricing: model.longContextPricing,
		});

		// The guard's own decision matches recomputing the estimate from the POST-transform context.
		expect(decision.estUsd).toBeCloseTo(postEstUsd, 9);
		expect(decision.over).toBe(false);

		// THE DISCRIMINATING ASSERTION: had the cost guard been evaluated before transformContext ran
		// -- the inverted pipeline order -- it would have priced the RAW pre-GC context instead, which
		// is more than 20x costlier here. It didn't: the actual decision matches the packed,
		// post-transform size. This fails if streamAssistantResponse is ever reordered to resolve
		// reasoning before applying transformContext.
		expect(rawEstUsd).toBeGreaterThan(decision.estUsd * 20);
	});
});
