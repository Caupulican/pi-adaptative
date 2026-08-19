import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/session/session-manager.ts";
import {
	createToolFailureResult,
	rememberToolFailure,
	sanitizeToolFailureContext,
} from "../src/tool-failure-memory.ts";
import type { AgentMessage, AgentToolCall } from "../src/types.ts";

function createTurn(
	id: string,
	name: string,
	args: Record<string, unknown>,
	resultText: string,
	isError: boolean,
	timestamp: number,
): AgentMessage[] {
	const call: AgentToolCall = { type: "toolCall", id, name, arguments: args };
	const assistantMsg: AgentMessage = {
		role: "assistant",
		content: [call],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
	const resultMsg: ToolResultMessage = {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: resultText }],
		isError,
		timestamp: timestamp + 1,
	};
	return [assistantMsg, resultMsg];
}

describe("Cooperative Systems & Tool Call Optimization Harmony Suite", () => {
	it("proves tool failure memory and payload deduplication operate cooperatively without dangling toolCall references", () => {
		const heavyData = "CRITICAL_PAYLOAD_DATA_LINE_".repeat(20);
		const messages: AgentMessage[] = [
			// Turn 1: Failure 1 on bash
			...createTurn("call_err_1", "bash", { command: "make build" }, "Error: target not found", true, 1),
			// Turn 2: Success 1 on read_file (payload A)
			...createTurn("call_read_1", "read_file", { path: "Makefile" }, heavyData, false, 5),
			// Turn 3: Failure 2 on bash
			...createTurn("call_err_2", "bash", { command: "make build" }, "Error: target not found", true, 10),
			// Turn 4: Success 2 on view_file (same payload A - duplicate payload)
			...createTurn("call_view_1", "view_file", { path: "./Makefile" }, heavyData, false, 15),
		];

		const sanitized = sanitizeToolFailureContext(messages, "Base prompt");

		// 1. Failure turns are summarized into harness context, and stay in the trajectory: the agent's
		// record of what it actually ran is never erased.
		expect(sanitized.systemPrompt).toContain("ACTIVE TOOL FAILURES mistakes=bash:2");
		expect(sanitized.systemPrompt).toContain('"kind_mistakes":2');
		expect(sanitized.messages.filter((message) => message.role === "toolResult")).toHaveLength(3);

		// 2. Earlier duplicate payload (call_read_1) must be superseded by call_view_1
		expect(sanitized.messages).toHaveLength(6);
		expect(
			sanitized.messages.some((message) => message.role === "toolResult" && message.toolCallId === "call_read_1"),
		).toBe(false);
		expect(sanitized.messages.at(-2)).toMatchObject({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_view_1" }],
		});
		expect(sanitized.messages.at(-1)).toMatchObject({
			role: "toolResult",
			toolCallId: "call_view_1",
		});

		// 3. HARD HARMONY GATE: Verify every toolResult in sanitized messages has a matching toolCall in the preceding assistant message
		const assistantToolCallIds = new Set<string>();
		for (const msg of sanitized.messages) {
			if (msg.role === "assistant") {
				for (const block of msg.content) {
					if (block.type === "toolCall") assistantToolCallIds.add(block.id);
				}
			}
			if (msg.role === "toolResult") {
				expect(assistantToolCallIds.has(msg.toolCallId)).toBe(true);
			}
		}
	});

	it("ensures kind-specific mistake tracking and failure directives clear gracefully upon matching tool success", () => {
		const tracker = new Map();
		const failRec = rememberToolFailure(tracker, "bash", { command: "npm test" }, "failed", "exit_1", "Fix test");

		const failRes = createToolFailureResult(failRec);
		const initialMessages = createTurn(
			"c_fail",
			"bash",
			{ command: "npm test" },
			failRes.content[0].type === "text" ? failRes.content[0].text : "",
			true,
			1,
		);

		const initialSanitized = sanitizeToolFailureContext(initialMessages, "base");
		expect(initialSanitized.systemPrompt).toContain("ACTIVE TOOL FAILURES mistakes=bash:1");

		// Follow up with matching successful attempt on bash
		const resolvedMessages: AgentMessage[] = [
			...initialMessages,
			...createTurn("c_succ", "bash", { command: "npm test" }, "Tests 10 passed", false, 10),
		];

		const resolvedSanitized = sanitizeToolFailureContext(resolvedMessages, "base");

		// HARD HARMONY GATE: Success must clear failure memory and restore base system prompt
		expect(resolvedSanitized.systemPrompt).toBe("base");
		expect(resolvedSanitized.systemPrompt).not.toContain("ACTIVE TOOL FAILURES");
	});

	it("retrieves the full history chain with complete un-truncated payloads cross-platform", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-history-test-"));
		const sessionManager = SessionManager.inMemory(tempDir);

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Investigate failure" }],
			timestamp: Date.now(),
		});
		const assistantId = sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "data.txt" } }],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		});

		const fullChain = sessionManager.getFullHistoryChainWithPayloads();
		expect(fullChain.length).toBeGreaterThan(0);
		expect(fullChain[fullChain.length - 1].id).toBe(assistantId);

		rmSync(tempDir, { recursive: true, force: true });
	});
});
