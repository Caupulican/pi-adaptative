import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { ContextPipeline, type ContextPipelineDeps } from "../src/core/context-pipeline.ts";

function createAssistantMessage(timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function createPipeline(branch: SessionEntry[]): ContextPipeline {
	const sessionManager = { getBranch: () => branch } as unknown as ReturnType<
		ContextPipelineDeps["getSessionManager"]
	>;
	return new ContextPipeline({
		getTurnIndex: () => 0,
		getSessionManager: () => sessionManager,
		getSettingsManager: () => ({}) as ReturnType<ContextPipelineDeps["getSettingsManager"]>,
		getCwd: () => process.cwd(),
		getAgentDir: () => process.cwd(),
		getModelRegistry: () => ({}) as ReturnType<ContextPipelineDeps["getModelRegistry"]>,
		getModel: () => undefined,
		getMemoryManager: () => ({}) as ReturnType<ContextPipelineDeps["getMemoryManager"]>,
		getActiveToolNames: () => [],
		isDisposed: () => false,
		addSpawnedUsage: () => undefined,
		runIsolatedCompletion: async () => {
			throw new Error("not used");
		},
	});
}

describe("ContextPipeline token budget", () => {
	it("estimates identical post-compaction messages idempotently", () => {
		const branch: SessionEntry[] = [
			{
				type: "compaction",
				id: "compaction-1",
				parentId: null,
				timestamp: new Date(1_000).toISOString(),
				summary: "summary",
				firstKeptEntryId: "message-1",
				tokensBefore: 5_000,
			},
		];
		const assistantMessage = createAssistantMessage(2_000);
		const messages: AgentMessage[] = [
			{ role: "user", content: "repeatable input", timestamp: 1_500 },
			assistantMessage,
			{ role: "user", content: "unchanged trailing input", timestamp: 2_500 },
		];
		const pipeline = createPipeline(branch);
		pipeline.observeProviderUsage(messages.slice(0, 2), assistantMessage);

		const first = pipeline.estimateCurrentContextTokens(messages);
		const second = pipeline.estimateCurrentContextTokens(messages);

		expect(second).toBe(first);
	});
});
