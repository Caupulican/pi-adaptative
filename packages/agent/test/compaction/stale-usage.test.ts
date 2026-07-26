import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage, Usage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { estimateContextTokens, getApplicableAssistantUsageInfo } from "../../src/compaction/compaction.ts";

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: usage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

describe("compaction usage anchors", () => {
	it("ignores usage produced before a newer inserted summary", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "summary", timestamp: 200 },
			assistant(100, 9_500),
			{ role: "user", content: "tail", timestamp: 300 },
		];

		expect(getApplicableAssistantUsageInfo(messages)).toBeUndefined();
		expect(estimateContextTokens(messages)).toMatchObject({ usageTokens: 0, lastUsageIndex: null });
	});

	it("uses the first assistant response produced after the inserted summary", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "summary", timestamp: 200 },
			assistant(100, 9_500),
			{ role: "user", content: "new prompt", timestamp: 300 },
			assistant(400, 2_000),
			{ role: "user", content: "tail", timestamp: 500 },
		];

		expect(getApplicableAssistantUsageInfo(messages)?.index).toBe(3);
		expect(estimateContextTokens(messages)).toMatchObject({ usageTokens: 2_000, lastUsageIndex: 3 });
	});
});
