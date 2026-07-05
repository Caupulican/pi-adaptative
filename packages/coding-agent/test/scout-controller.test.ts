import type { AgentTool } from "@caupulican/pi-agent-core";
import type { Model } from "@caupulican/pi-ai";
import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { parseScoutAnswer, ScoutController, type ScoutControllerDeps } from "../src/core/scout-controller.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("unexpected event");
			},
		);
	}
}

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "fastcontext-test",
		name: "FastContext Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fastcontext-test",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function tool(name: string): AgentTool<any> {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

function makeController(texts: string[], overrides: Partial<ScoutControllerDeps> = {}) {
	let call = 0;
	return new ScoutController({
		resolveScoutModel: async () => ({ model: createModel(), apiKey: "test-key" }),
		getCwd: () => "/repo",
		buildReadOnlyTools: () => [tool("read"), tool("grep"), tool("find"), tool("bash")],
		fileExists: (path) => path !== "missing.ts",
		countLines: (path) => (path === "short.ts" ? 5 : 100),
		streamFn: () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const text = texts[Math.min(call, texts.length - 1)] ?? "";
				call += 1;
				stream.push({ type: "done", reason: "stop", message: assistantMessage(text) });
			});
			return stream;
		},
		...overrides,
	});
}

describe("ScoutController", () => {
	it("parses final_answer citations and validates paths", async () => {
		const controller = makeController([
			`<final_answer>
Found router and test code.
src/router.ts:10-20
src/router.test.ts:8
missing.ts:1-3
</final_answer>`,
		]);

		const result = await controller.run("Find router code", 8);

		expect(result.summary).toBe("Found router and test code.");
		expect(result.citations).toEqual([
			{ path: "src/router.ts", start: 10, end: 20, valid: true },
			{ path: "src/router.test.ts", start: 8, end: 8, valid: true },
			{ path: "missing.ts", start: 1, end: 3, valid: false },
		]);
		expect(result.droppedCitations).toBe(1);
		expect(result.unreliable).toBe(false);
		expect(result.truncated).toBe(false);
		expect(result.turnsUsed).toBe(1);
	});

	it(">50 percent invalid citations marks the run unreliable", () => {
		const result = parseScoutAnswer(
			`<final_answer>
Summary.
missing.ts:1-2
short.ts:1-99
src/ok.ts:1-2
</final_answer>`,
			(path) => path !== "missing.ts",
			(path) => (path === "short.ts" ? 5 : 100),
		);

		expect(result.droppedCitations).toBe(2);
		expect(result.unreliable).toBe(true);
	});

	it("returns a failure result when model resolution fails", async () => {
		const controller = makeController([], {
			resolveScoutModel: async () => ({ failure: "scout unavailable: no model" }),
		});

		await expect(controller.run("Find code", 8)).resolves.toMatchObject({
			failure: "scout unavailable: no model",
			turnsUsed: 0,
		});
	});

	it("marks a run truncated when the final answer is absent at the turn cap", async () => {
		const controller = makeController(["partial evidence without final block"]);

		const result = await controller.run("Find code", 1);

		expect(result.summary).toBe("partial evidence without final block");
		expect(result.truncated).toBe(true);
		expect(result.turnsUsed).toBe(1);
	});

	it("clamps maxTurns to 12 in the system prompt", async () => {
		let capturedSystemPrompt = "";
		const controller = makeController(["partial"], {
			streamFn: (_model, context) => {
				capturedSystemPrompt = context.systemPrompt ?? "";
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("partial") });
				});
				return stream;
			},
		});

		await controller.run("Find code", 100);

		expect(capturedSystemPrompt).toContain("Turn budget: 12 turns");
	});

	it("propagates abort as a clean partial result", async () => {
		const controller = new AbortController();
		const scout = makeController(["partial"], {
			signal: controller.signal,
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					controller.abort();
					stream.push({ type: "done", reason: "stop", message: assistantMessage("partial") });
				});
				return stream;
			},
		});

		const result = await scout.run("Find code", 8);

		expect(result.failure).toBe("aborted");
		expect(result.truncated).toBe(true);
	});
});
