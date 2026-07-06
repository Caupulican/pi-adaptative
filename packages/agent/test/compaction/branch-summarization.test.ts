import {
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { generateBranchSummary } from "../../src/compaction/branch-summarization.ts";
import type { SessionMessageEntry } from "../../src/session/session-manager.ts";
import type { StreamFn } from "../../src/types.ts";

function createModel(): Model<any> {
	return {
		id: "model",
		name: "model",
		provider: "test",
		api: "test",
		baseUrl: "https://example.test",
		input: ["text"],
		reasoning: false,
		contextWindow: 100_000,
		maxTokens: 2048,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function entry(content: string): SessionMessageEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

function streamWith(event: AssistantMessageEvent): ReturnType<StreamFn> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push(event));
	return stream;
}

describe("generateBranchSummary reliability", () => {
	it("uses the injected stream function instead of bypassing through completeSimple", async () => {
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls++;
			return streamWith({
				type: "done",
				reason: "stop",
				message: fauxAssistantMessage("## Goal\nused injected stream"),
			});
		};

		const result = await generateBranchSummary([entry("summarize me")], {
			model: createModel(),
			apiKey: "key",
			signal: new AbortController().signal,
			streamFn,
		});

		expect(calls).toBe(1);
		expect(result.summary).toContain("used injected stream");
	});

	it("classifies and retries stalled stream errors instead of hanging", async () => {
		let calls = 0;
		const streamFn: StreamFn = () => {
			calls++;
			return streamWith({
				type: "error",
				reason: "error",
				error: fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "stream stalled: no events for 30000ms (active phase)",
				}),
			});
		};

		const result = await generateBranchSummary([entry("summarize me")], {
			model: createModel(),
			apiKey: "key",
			signal: new AbortController().signal,
			streamFn,
		});

		expect(calls).toBe(3);
		expect(result.error).toContain("stream stalled");
	});
});
