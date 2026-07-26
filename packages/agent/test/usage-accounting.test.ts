import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type Usage,
} from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { generateSummaryWithUsage } from "../src/compaction/compaction.ts";
import { SessionManager } from "../src/session/session-manager.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "../src/types.ts";

function usage(value: number): Usage {
	return {
		input: value,
		output: value + 1,
		cacheRead: value + 2,
		cacheWrite: value + 3,
		totalTokens: value * 4 + 6,
		cost: {
			input: value / 10,
			output: value / 10,
			cacheRead: value / 10,
			cacheWrite: value / 10,
			total: (value * 4) / 10,
		},
	};
}

function model(): Model<"openai-responses"> {
	return {
		id: "usage-model",
		name: "Usage model",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	billed = usage(0),
) {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "usage-model",
		usage: billed,
		stopReason,
		timestamp: Date.now(),
	} satisfies AssistantMessage;
}

function streamMessage(message: AssistantMessage): EventStream<AssistantMessageEvent, AssistantMessage> {
	const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
		(event) => event.type === "done" || event.type === "error",
		(event) => {
			if (event.type === "done") return event.message;
			if (event.type === "error") return event.error;
			throw new Error("Unexpected stream event");
		},
	);
	if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") {
		throw new Error(`Expected a successful assistant message, received ${message.stopReason}`);
	}
	const reason = message.stopReason;
	queueMicrotask(() => stream.push({ type: "done", reason, message }));
	return stream;
}

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

describe("durable usage accounting", () => {
	it("preserves model-backed tool usage through afterToolCall and the tool-result message", async () => {
		const schema = Type.Object({ value: Type.String() });
		const executedUsage = usage(2);
		const patchedUsage = usage(7);
		const tool: AgentTool<typeof schema, { value: string }> = {
			name: "model_tool",
			label: "Model tool",
			description: "Uses another model",
			parameters: schema,
			async execute(_toolCallId, params) {
				return {
					content: [{ type: "text", text: params.value }],
					details: { value: params.value },
					usage: executedUsage,
				};
			},
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm,
			afterToolCall: async () => ({ usage: patchedUsage, terminate: true }),
		};
		const request = assistant(
			[{ type: "toolCall", id: "tool-1", name: "model_tool", arguments: { value: "ok" } }],
			"toolUse",
		);
		const stream = agentLoop(
			[{ role: "user", content: "run", timestamp: Date.now() }],
			context,
			config,
			undefined,
			() => streamMessage(request),
		);
		const messages = await stream.result();
		const result = messages.find((message) => message.role === "toolResult");

		expect(result?.role).toBe("toolResult");
		if (result?.role !== "toolResult") throw new Error("Missing tool result");
		expect(result.usage).toEqual(patchedUsage);
	});

	it("returns provider usage with generated summaries and isolates their cache identity", async () => {
		const billed = usage(11);
		let options: SimpleStreamOptions | undefined;
		const streamFn: StreamFn = (_model, _context: Context, requestOptions) => {
			options = requestOptions;
			return streamMessage(assistant([{ type: "text", text: "compact summary" }], "stop", billed));
		};

		const result = await generateSummaryWithUsage(
			[{ role: "user", content: "history", timestamp: Date.now() }],
			model(),
			1024,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(result).toEqual({ text: "compact summary", usage: billed });
		expect(options?.cacheRetention).toBe("none");
		expect(options?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("persists compaction and branch-summary usage across resume", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-summary-usage-"));
		try {
			const sessions = join(root, "sessions");
			const session = SessionManager.create(root, root, sessions);
			const userId = session.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
			session.appendMessage(assistant([{ type: "text", text: "done" }], "stop", usage(1)));
			const compactionUsage = usage(3);
			const branchUsage = usage(5);
			const compactionId = session.appendCompaction("checkpoint", userId, 1000, undefined, false, compactionUsage);
			const branchId = session.branchWithSummary(compactionId, "abandoned branch", undefined, false, branchUsage);
			const file = session.getSessionFile();
			if (!file) throw new Error("Expected persisted session file");

			const reopened = SessionManager.open(file, root);
			expect(reopened.getEntry(compactionId)).toMatchObject({ type: "compaction", usage: compactionUsage });
			expect(reopened.getEntry(branchId)).toMatchObject({ type: "branch_summary", usage: branchUsage });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
