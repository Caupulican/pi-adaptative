import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type SimpleStreamOptions,
} from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

/**
 * A worker's summarizer extends the worker lane's own last request, so it must reach the provider
 * exactly as built (the sent prefix plus one instruction), on the lane's retention, after the lane's
 * budget preflight. And a worker reuses root's reasoning policy on its own conversation state.
 */
function reply(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

describe("isolated request context", () => {
	it("sends a structured request exactly as given, after the lane's preflight, on its retention", async () => {
		const harness = await createHarness();
		try {
			const sent: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
			harness.session.agent.streamFn = (_model, context, options) => {
				sent.push({ context, options });
				return reply(fauxAssistantMessage("checkpoint"));
			};
			const requestContext: Context = {
				systemPrompt: "worker lane prompt",
				messages: [
					{ role: "user", content: "the task", timestamp: 1 },
					{ role: "user", content: "Create a replacement checkpoint.", timestamp: 2 },
				],
				tools: [
					{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } as never },
				],
			};
			const preflights: number[] = [];
			const result = await harness.session.runIsolatedCompletion({
				systemPrompt: "worker lane prompt",
				messages: [],
				requestContext,
				maxTokens: 400,
				requestPreflight: () => {
					preflights.push(1);
					return { maxTokens: 300 };
				},
				cacheRetention: "short",
				laneKind: "worker",
			});
			expect(result.text).toBe("checkpoint");
			expect(preflights).toEqual([1]);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.context).toBe(requestContext);
			expect(sent[0]?.options).toMatchObject({ cacheRetention: "short", maxTokens: 300 });
		} finally {
			harness.cleanup();
		}
	});

	it("pins a worker conversation's reasoning on its own state, apart from the foreground's", async () => {
		const harness = await createHarness({ models: [{ id: "reasoner", reasoning: true }] });
		try {
			const resolve = harness.session.agent.resolveRequestReasoning!;
			const model = harness.session.model!;
			const request = (sessionId?: string) => ({
				model,
				context: { systemPrompt: "", messages: [] },
				sourceMessages: [],
				...(sessionId ? { sessionId } : {}),
			});
			// The foreground lane sends "high" first; a worker conversation on the same model sends "low" first.
			expect(resolve("high", request())).toBe("high");
			expect(resolve("low", request("session/worker:a"))).toBe("low");
			// Each keeps its own level: the worker's first level is not a change of the foreground's.
			expect(resolve("high", request())).toBe("high");
			expect(resolve("low", request("session/worker:a"))).toBe("low");
		} finally {
			harness.cleanup();
		}
	});
});
