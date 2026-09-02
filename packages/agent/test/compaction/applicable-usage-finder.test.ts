import { describe, expect, it } from "vitest";
import {
	createApplicableAssistantUsageFinder,
	getApplicableAssistantUsageInfo,
} from "../../src/compaction/compaction.ts";
import type { AgentMessage } from "../../src/types.ts";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(timestamp: number): AgentMessage {
	return { role: "user", content: "hi", timestamp } as AgentMessage;
}

function assistant(timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp,
	} as AgentMessage;
}

describe("createApplicableAssistantUsageFinder", () => {
	it("matches the stateless walk across appends and after a compaction summary lands mid-history", () => {
		const find = createApplicableAssistantUsageFinder();
		const history: AgentMessage[] = [user(1), assistant(2)];
		expect(find(history)).toEqual(getApplicableAssistantUsageInfo(history));
		history.push(user(3), assistant(4));
		expect(find(history)).toEqual(getApplicableAssistantUsageInfo(history));
		expect(find(history)?.index).toBe(3);

		// A newer summary inserted before retained older messages: the older usage no longer anchors.
		const compacted: AgentMessage[] = [user(10), ...history.slice(1)];
		expect(find(compacted)).toEqual(getApplicableAssistantUsageInfo(compacted));
		expect(find(compacted)).toBeUndefined();
	});
});
