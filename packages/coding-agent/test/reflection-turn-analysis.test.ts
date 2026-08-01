import type { AgentMessage } from "@caupulican/pi-agent-core";
import { describe, expect, it } from "vitest";
import { analyzeReflectionTurn } from "../src/core/learning/reflection-turn-analysis.ts";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistant(text: string, toolName?: string): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...(toolName ? [{ type: "toolCall" as const, id: "call-1", name: toolName, arguments: {} }] : []),
		],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

describe("reflection turn analysis", () => {
	it("recognizes explicit durable guidance without treating ordinary chat as learning", () => {
		const explicit = analyzeReflectionTurn([user("From now on, remember that I prefer concise reports.")], 12);
		expect(explicit.trigger).toBe("corrective");
		expect(explicit.explicitUserMemoryInstruction).toBe(true);
		expect(analyzeReflectionTurn([user("hello"), assistant("Hello.")], 12).trigger).toBe("none");
	});

	it("does not grant explicit-memory authority to a mixed queued run", () => {
		const mixed = analyzeReflectionTurn(
			[
				user("Remember that I prefer concise reports."),
				assistant("Understood."),
				user("Now diagnose the unrelated runtime failure."),
				assistant("The runtime path needs investigation."),
			],
			12,
		);

		expect(mixed.trigger).toBe("durable");
		expect(mixed.explicitUserMemoryInstruction).toBe(false);
	});

	it("keeps a bounded semantic digest and excludes raw tool-result payloads", () => {
		const garbageMarker = "RAW_TOOL_GARBAGE_SHOULD_NOT_REACH_REFLECTION";
		const secretMarker = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
		const messages: AgentMessage[] = [
			user(`Investigate the Windows failure. Accidental token: ${secretMarker}`),
			assistant("The confirmed root cause is repeated shell discovery.", "bash"),
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "bash",
				content: [{ type: "text", text: `${garbageMarker}${"x".repeat(50_000)}` }],
				isError: false,
				timestamp: 3,
			},
		];

		const analysis = analyzeReflectionTurn(messages, 12);

		expect(analysis.trigger).toBe("durable");
		expect(analysis.toolCallCount).toBe(1);
		expect(analysis.recentTurnText).toContain("confirmed root cause");
		expect(analysis.recentTurnText).toContain("tools: bash");
		expect(analysis.recentTurnText).not.toContain(garbageMarker);
		expect(analysis.recentTurnText).not.toContain(secretMarker);
		expect(analysis.recentTurnText).toContain("[redacted]");
		expect(analysis.recentTurnText.length).toBeLessThanOrEqual(12_000);
		expect(analyzeReflectionTurn(messages, 12).digest).toBe(analysis.digest);
	});
});
