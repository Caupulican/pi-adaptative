import { EventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, AssistantMessageEvent, Message, Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { startAgentProviderRequest } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: AssistantMessage) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
		queueMicrotask(() => this.push({ type: "done", reason: message.stopReason as "stop", message }));
	}
}

function model(): Model<"openai-completions"> {
	return {
		id: "text-only",
		name: "text-only",
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	};
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "text-only",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function toLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

describe("provider request planning", () => {
	it("replans before committing, then preflights and sends the same text-protocol materialization", async () => {
		const schema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof schema> = {
			name: "echo",
			label: "Echo",
			description: "Echo one value.",
			parameters: schema,
			execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} })),
		};
		const initial: AgentContext = {
			systemPrompt: "SYSTEM",
			messages: [user("uncompacted history")],
			tools: [tool],
		};
		const commits: number[] = [];
		const discarded: number[] = [];
		let admittedContext: Parameters<NonNullable<AgentLoopConfig["requestPreflight"]>>[0]["context"] | undefined;
		let preflightContext: typeof admittedContext;
		let transportedContext: typeof admittedContext;
		const config: AgentLoopConfig = {
			model: model(),
			textToolCallProtocol: true,
			convertToLlm: toLlm,
			planContext: async ({ messages, attempt }) => ({
				messages,
				transientMessages: [user(`mandatory transient ${attempt}`)],
				commit: () => {
					commits.push(attempt);
				},
				discard: () => discarded.push(attempt),
			}),
			admitProviderRequest: ({ context, sourceContext, attempt }) => {
				if (attempt === 0) {
					return {
						action: "replan",
						context: { ...sourceContext, messages: [user("compacted history")] },
					};
				}
				admittedContext = context;
				return { action: "send" };
			},
			requestPreflight: ({ context }) => {
				preflightContext = context;
				return { maxTokens: 64 };
			},
		};

		const response = await startAgentProviderRequest(initial, config, undefined, (_streamModel, context, options) => {
			transportedContext = context;
			expect(options?.textToolCallProtocol).toBe(true);
			return new MockAssistantStream(assistant('<pi:call name="echo">{"value":"hi"}</pi:call>'));
		});
		const result = await response.result();

		expect(discarded).toEqual([0]);
		expect(commits).toEqual([1]);
		expect(initial.messages).toEqual([user("compacted history")]);
		expect(preflightContext).toBe(admittedContext);
		expect(transportedContext).toBe(admittedContext);
		expect(transportedContext?.tools).toBeUndefined();
		expect(transportedContext?.systemPrompt).toContain("SYSTEM");
		expect(transportedContext?.systemPrompt).toContain('<pi:call name="TOOL">');
		expect(transportedContext?.systemPrompt?.match(/<pi:call name="TOOL">/gu)).toHaveLength(1);
		expect(JSON.stringify(transportedContext?.messages)).toContain("compacted history");
		expect(JSON.stringify(transportedContext?.messages)).toContain("mandatory transient 1");
		expect(JSON.stringify(transportedContext?.messages)).not.toContain("uncompacted history");
		expect(result.content).toMatchObject([
			{ type: "toolCall", name: "echo", arguments: { value: "hi" }, source: "text-protocol" },
		]);
	});

	it("replans a stale preview without committing it and fails closed after the bounded retry limit", async () => {
		let planCount = 0;
		let transportCount = 0;
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: toLlm,
			planContext: async ({ messages }) => {
				planCount++;
				return {
					messages,
					isCurrent: () => false,
					commit: vi.fn(),
				};
			},
		};

		await expect(
			startAgentProviderRequest(
				{ systemPrompt: "SYSTEM", messages: [user("work")], tools: [] },
				config,
				undefined,
				() => {
					transportCount++;
					return new MockAssistantStream(assistant("must not send"));
				},
			),
		).rejects.toThrow("Provider request plan stayed stale after 3 attempts");
		expect(planCount).toBe(3);
		expect(transportCount).toBe(0);
	});

	it("converts compactable history and mandatory transients once as separate domains", async () => {
		const durable = user("durable history");
		const transient = user("mandatory transient");
		const conversionCounts = new Map<AgentMessage, number>();
		let nonCompactableMessages: Message[] | undefined;
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: (messages) => {
				for (const message of messages) {
					conversionCounts.set(message, (conversionCounts.get(message) ?? 0) + 1);
				}
				return toLlm(messages);
			},
			planContext: async ({ messages }) => ({ messages, transientMessages: [transient] }),
			admitProviderRequest: ({ nonCompactableContext }) => {
				nonCompactableMessages = nonCompactableContext.messages;
				return { action: "send" };
			},
		};

		const response = await startAgentProviderRequest(
			{ systemPrompt: "SYSTEM", messages: [durable], tools: [] },
			config,
			undefined,
			() => new MockAssistantStream(assistant("sent")),
		);
		await response.result();

		expect(conversionCounts.get(durable)).toBe(1);
		expect(conversionCounts.get(transient)).toBe(1);
		expect(JSON.stringify(nonCompactableMessages)).toContain("mandatory transient");
		expect(JSON.stringify(nonCompactableMessages)).not.toContain("durable history");
	});

	it("rejects admission replans that try to replace the system or tool surface", async () => {
		let transportCount = 0;
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: toLlm,
			admitProviderRequest: ({ sourceContext }) => ({
				action: "replan",
				context: { ...sourceContext, systemPrompt: "REPLACED" },
			}),
		};

		await expect(
			startAgentProviderRequest(
				{ systemPrompt: "SYSTEM", messages: [user("work")], tools: [] },
				config,
				undefined,
				() => {
					transportCount++;
					return new MockAssistantStream(assistant("must not send"));
				},
			),
		).rejects.toThrow("may replan durable messages only");
		expect(transportCount).toBe(0);
	});

	it("does not commit a request plan if cancellation wins during authentication", async () => {
		const abortController = new AbortController();
		const commit = vi.fn();
		let transportCount = 0;
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: toLlm,
			planContext: async ({ messages }) => ({ messages, commit }),
			getApiKey: async () => {
				abortController.abort(new Error("cancelled before commit"));
				return "key";
			},
		};

		await expect(
			startAgentProviderRequest(
				{ systemPrompt: "SYSTEM", messages: [user("work")], tools: [] },
				config,
				abortController.signal,
				() => {
					transportCount++;
					return new MockAssistantStream(assistant("must not send"));
				},
			),
		).rejects.toThrow("cancelled before commit");
		expect(commit).not.toHaveBeenCalled();
		expect(transportCount).toBe(0);
	});

	it("does not spend the compaction replan ladder on a stale context preview", async () => {
		const initial: AgentContext = { systemPrompt: "SYSTEM", messages: [user("old history")], tools: [] };
		const planAttempts: number[] = [];
		const admissionAttempts: number[] = [];
		let planCalls = 0;
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: toLlm,
			planContext: async ({ messages, attempt }) => {
				planAttempts.push(attempt);
				planCalls++;
				return { messages, isCurrent: () => planCalls !== 1 };
			},
			admitProviderRequest: ({ sourceContext, attempt }) => {
				admissionAttempts.push(attempt);
				return attempt === 0
					? { action: "replan", context: { ...sourceContext, messages: [user("compacted history")] } }
					: { action: "send" };
			},
		};

		const response = await startAgentProviderRequest(
			initial,
			config,
			undefined,
			() => new MockAssistantStream(assistant("sent")),
		);
		await response.result();

		expect(planAttempts).toEqual([0, 0, 1]);
		expect(admissionAttempts).toEqual([0, 1]);
		expect(initial.messages).toEqual([user("compacted history")]);
	});
});
