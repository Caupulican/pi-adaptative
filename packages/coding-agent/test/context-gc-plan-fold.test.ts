import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { applyContextGc } from "../src/core/context-gc.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function readCall(index: number, path: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path } }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: index * 2,
	};
}

function readResult(index: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${index}`,
		toolName: "read",
		content: [{ type: "text", text: `content ${index}\n${"0123456789abcdef".repeat(80)}` }],
		isError: false,
		timestamp: index * 2 + 1,
	};
}

const settings = {
	cwd: "/repo",
	preserveRecentMessages: 0,
	minToolResultChars: 10,
	tools: ["read"],
	writePayloads: false,
	semanticMemory: { preserveRecentPages: 0, minChars: Number.MAX_SAFE_INTEGER },
	frozenBelow: 0,
};

function reasons(messages: AgentMessage[]): string[] {
	return applyContextGc(messages, settings).report.records.map((record) => `${record.messageIndex}:${record.reason}`);
}

describe("context-gc plan fold", () => {
	it("plans an appended history from the remembered prefix exactly as a fresh scan would", () => {
		const history: AgentMessage[] = [readCall(1, "a.ts"), readResult(1), readCall(2, "b.ts"), readResult(2)];
		const first = reasons(history);
		// A second read of a.ts supersedes the first; the plan must see it through the resumed fold.
		history.push(readCall(3, "a.ts"), readResult(3));
		const resumed = reasons(history);
		const fresh = reasons(structuredClone(history));
		expect(resumed).toEqual(fresh);
		expect(resumed).toContain("1:superseded-read");
		expect(first).not.toContain("1:superseded-read");
	});

	it("starts a new plan when the history no longer extends the remembered one", () => {
		const history: AgentMessage[] = [readCall(1, "a.ts"), readResult(1), readCall(2, "a.ts"), readResult(2)];
		expect(reasons(history)).toContain("1:superseded-read");
		// The older read is gone (a compaction): nothing supersedes the remaining one.
		const trimmed = history.slice(2);
		expect(reasons(trimmed)).toEqual(reasons(structuredClone(trimmed)));
		expect(reasons(trimmed).some((entry) => entry.endsWith("superseded-read"))).toBe(false);
	});
});
