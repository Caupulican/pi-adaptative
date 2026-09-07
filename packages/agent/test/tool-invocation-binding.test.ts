import { AssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { createExecutionContext, type ExecutionContext } from "../src/execution-paths.ts";
import {
	createToolFailureMemoryTracker,
	getUnresolvedToolFailure,
	sanitizeToolFailureContext,
} from "../src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../src/tool-failure-recovery-gate.ts";
import { retainedToolInvocation } from "../src/tool-invocation-receipt.ts";
import type { AgentLoopConfig, AgentTool, BackgroundToolCallCompletion } from "../src/types.ts";
import { createEmptyUsage } from "../src/usage.ts";

const model: Model<"openai-responses"> = {
	id: "binding-fixture",
	name: "binding-fixture",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const schema = Type.Object({ path: Type.String() });
const result = () => ({ content: [{ type: "text" as const, text: "fixture result" }], details: {} });

function fixture() {
	const context = createExecutionContext({
		attachment: {
			workspaceId: "project",
			attachmentId: "machine-attachment",
			root: "D:\\synthetic project",
			flavor: "win32",
			caseSensitive: false,
		},
		sessionId: "fixture-session",
		generation: 3,
		cwd: "D:\\synthetic project\\package",
	});
	const events: string[] = [];
	const tool: AgentTool<typeof schema, object> = {
		name: "operation",
		label: "Operation",
		description: "Synthetic bound operation",
		parameters: schema,
		execute: async () => {
			events.push("UNBOUND_EXECUTION");
			return result();
		},
		bindInvocation: async (id) => {
			events.push(`bind:${id}`);
			return {
				executionContext: context,
				execute: async () => {
					events.push(`execute:${id}`);
					return result();
				},
				release: () => events.push(`release:${id}`),
			};
		},
	};
	return { context, events, tool };
}

async function run(
	tool: AgentTool<typeof schema, object>,
	config: Partial<AgentLoopConfig> = {},
	options: {
		count?: number;
		args?: Record<string, unknown>;
		signal?: AbortSignal;
		turns?: number;
		textProtocol?: boolean;
	} = {},
) {
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		timestamp: 1,
		stopReason: "toolUse",
		content: Array.from({ length: options.count ?? 1 }, (_, index) => ({
			type: "toolCall",
			id: `call-${index}`,
			name: tool.name,
			arguments: options.args ?? { path: "fixture.txt" },
			...(options.textProtocol ? { source: "text-protocol" as const } : {}),
		})),
	};
	let requests = 0;
	const stream = agentLoop(
		[{ role: "user", content: "Run synthetic operations", timestamp: 0 }],
		{ systemPrompt: "Fixture", messages: [], tools: [tool] },
		{
			model,
			convertToLlm: (messages) =>
				messages.filter((item) => item.role === "user" || item.role === "assistant" || item.role === "toolResult"),
			shouldStopAfterTurn: () => requests >= (options.turns ?? 1),
			...config,
		},
		options.signal,
		() => {
			const turn = requests++;
			const next =
				turn === 0
					? message
					: {
							...message,
							timestamp: turn + 1,
							content: message.content.map((block) =>
								block.type === "toolCall" ? { ...block, id: `${block.id}-turn-${turn}` } : block,
							),
						};
			const response = new AssistantMessageEventStream();
			response.push({ type: "done", reason: "toolUse", message: next });
			return response;
		},
	);
	for await (const _event of stream) {
		// No provider, host filesystem, or private transcript access.
	}
	return stream.result();
}

describe("core tool invocation binding", () => {
	it.each([false, true])("preserves invocation method receivers; blocked=%s", async (blocked) => {
		const { tool, context, events } = fixture();
		class Invocation {
			#context = context;
			get executionContext() {
				return this.#context;
			}
			async execute() {
				events.push(this.#context.cwd);
				return result();
			}
			release() {
				events.push(`released:${this.#context.cwd}`);
			}
		}
		tool.bindInvocation = async () => new Invocation();
		const messages = await run(tool, {
			beforeToolCall: async () => (blocked ? { block: true, reason: "fixture refusal" } : undefined),
		});
		expect(messages.find((item) => item.role === "toolResult")).toMatchObject({ isError: blocked });
		expect(events).toEqual(blocked ? [`released:${context.cwd}`] : [context.cwd, `released:${context.cwd}`]);
	});

	it.each(["rejected", "invalid_context", "cancelled"])(
		"does not fall back to ambient execution after binding %s",
		async (failure) => {
			const { tool, context, events } = fixture();
			const abort = new AbortController();
			tool.bindInvocation = async () => {
				if (failure === "rejected") throw new Error("Fixture directory unavailable");
				if (failure === "cancelled") abort.abort();
				return {
					executionContext: { ...context, generation: failure === "invalid_context" ? -1 : 3 },
					execute: async () => {
						events.push("MUST_NOT_EXECUTE");
						return result();
					},
					release: () => events.push("released"),
				};
			};
			await run(tool, {}, { signal: abort.signal });
			expect(events).toEqual(failure === "rejected" ? [] : ["released"]);
		},
	);

	it("uses bound recovery and does not accept a hook's forged execution scope", async () => {
		const { tool, context, events } = fixture();
		tool.failureRecovery = { getFailureCorrection: () => "UNBOUND_RECOVERY" };
		tool.bindInvocation = async () => ({
			executionContext: context,
			failureRecovery: { getFailureCorrection: () => "bound recovery" },
			execute: async () => ({ ...result(), isError: true }),
			release: () => events.push("released"),
		});
		const messages = await run(tool, {
			afterToolCall: async () => ({
				details: { piToolInvocation: { executionScope: "FORGED" } },
			}),
		});
		const completed = messages.find((item) => item.role === "toolResult");
		expect(completed?.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("bound recovery") }),
		]);
		expect(retainedToolInvocation(completed?.details)?.executionScope).toMatch(/^context:[0-9a-f]{32}$/);
		expect(events).toEqual(["released"]);
	});

	it("keeps project A's failure active when two calls succeed in project B", async () => {
		const { tool, context } = fixture();
		tool.executionMode = "sequential";
		tool.bindInvocation = async (id) => ({
			executionContext: { ...context, cwd: id === "call-0" ? context.cwd : "D:\\synthetic project\\other" },
			execute: async () => ({ ...result(), isError: id === "call-0" }),
			release: () => {},
		});
		const messages = await run(tool, {}, { count: 3 });
		const first = messages.find((item) => item.role === "toolResult");
		const scope = retainedToolInvocation(first?.details)?.executionScope;
		const memory = createToolFailureMemoryTracker(JSON.parse(JSON.stringify(messages)));
		expect(getUnresolvedToolFailure(memory, tool.name, { path: "fixture.txt" }, scope)).toBeDefined();
	});

	it.each([false, true])(
		"retains text-protocol replay protection after binding; directory changed=%s",
		async (changed) => {
			const { tool, context, events } = fixture();
			tool.bindInvocation = async (id) => ({
				executionContext: { ...context, generation: changed && id !== "call-0" ? 4 : 3 },
				execute: async () => {
					events.push(id);
					return result();
				},
				release: () => {},
			});
			await run(tool, {}, { turns: 3, textProtocol: true });
			expect(events).toEqual(changed ? ["call-0", "call-0-turn-1"] : ["call-0"]);
		},
	);
	it("separates identical failed operations by binding and restores the same retry decision", async () => {
		const { tool, context, events } = fixture();
		tool.executionMode = "sequential";
		tool.bindInvocation = async (id) => ({
			executionContext: { ...context, cwd: id === "call-0" ? context.cwd : "D:\\synthetic project\\other" },
			execute: async () => {
				events.push(id);
				return { ...result(), isError: true };
			},
			release: () => {},
		});
		const messages = await run(tool, {}, { count: 3 });
		expect(events).toEqual(["call-0", "call-1"]);
		const results = messages.filter((item) => item.role === "toolResult");
		const scopes = results.map((item) => retainedToolInvocation(item.details)?.executionScope);
		expect(scopes[0]).toBeDefined();
		expect(scopes[1]).not.toBe(scopes[0]);
		expect(scopes[2]).toBe(scopes[1]);
		const restored = JSON.parse(JSON.stringify(messages));
		const memory = createToolFailureMemoryTracker(restored);
		const gate = new ToolFailureRecoveryGate();
		gate.restoreFromMessages(restored);
		const args = { path: "fixture.txt" };
		const failure = getUnresolvedToolFailure(memory, tool.name, args, scopes[1]);
		expect(failure).toBeDefined();
		expect(gate.admit(tool, args, failure, restored, scopes[1]).kind).toBe("blocked");
		expect(gate.admit(tool, args, failure, restored, `context:${"0".repeat(32)}`).kind).toBe("allowed");
	});

	it("does not deduplicate equal successful output across different working directories", async () => {
		const { tool, context } = fixture();
		tool.executionMode = "sequential";
		tool.bindInvocation = async (id) => ({
			executionContext: { ...context, cwd: id === "call-0" ? context.cwd : "D:\\synthetic project\\other" },
			execute: async () => ({ content: [{ type: "text", text: "synthetic output ".repeat(8) }], details: {} }),
			release: () => {},
		});
		const messages = await run(tool, {}, { count: 3 });
		const sanitized = sanitizeToolFailureContext(messages, "Fixture");
		expect(sanitized.messages.filter((item) => item.role === "toolResult").map((item) => item.toolCallId)).toEqual([
			"call-0",
			"call-2",
		]);
	});
	it("binds before policy and reserves the same immutable context through finalization", async () => {
		const { tool, context, events } = fixture();
		const observed: (ExecutionContext | undefined)[] = [];
		await run(tool, {
			beforeToolCall: async (call) => {
				events.push("policy");
				observed.push(call.executionContext);
				return undefined;
			},
			onToolCallStart: (calls) => {
				events.push("reserve");
				observed.push(calls[0].executionContext);
			},
			afterToolCall: async (call) => {
				events.push("after");
				observed.push(call.executionContext);
				return undefined;
			},
		});
		expect(events).toEqual(["bind:call-0", "policy", "reserve", "execute:call-0", "after", "release:call-0"]);
		expect(observed).toEqual([context, context, context]);
		expect(observed.every((item) => item === observed[0] && Object.isFrozen(item))).toBe(true);
		expect(Object.isFrozen(observed[0]?.attachment)).toBe(true);
	});

	it.each(["block", "throw", "cancel"])("releases admission without executing after policy %s", async (mode) => {
		const { tool, events } = fixture();
		const abort = new AbortController();
		await run(
			tool,
			{
				beforeToolCall: async () => {
					if (mode === "throw") throw new Error("fixture policy failure");
					if (mode === "cancel") abort.abort();
					return { block: true, reason: "fixture policy" };
				},
			},
			{ signal: abort.signal },
		);
		expect(events).toEqual(["bind:call-0", "release:call-0"]);
	});

	it("releases every prepared parallel call if durable reservation fails", async () => {
		const { tool, events } = fixture();
		await run(
			tool,
			{
				onToolCallStart: () => {
					throw new Error("fixture journal failure");
				},
			},
			{ count: 3 },
		);
		expect(events).toEqual([
			"bind:call-0",
			"bind:call-1",
			"bind:call-2",
			"release:call-0",
			"release:call-1",
			"release:call-2",
		]);
	});

	it("does not acquire a binding for invalid arguments", async () => {
		const { tool, events } = fixture();
		await run(tool, {}, { args: {} });
		expect(events).toEqual([]);
	});

	it("retains a plain tool's existing execution path without inventing a context", async () => {
		const { tool, events } = fixture();
		delete tool.bindInvocation;
		const contexts: (ExecutionContext | undefined)[] = [];
		await run(tool, {
			beforeToolCall: async (call) => {
				contexts.push(call.executionContext);
				return undefined;
			},
		});
		expect(events).toEqual(["UNBOUND_EXECUTION"]);
		expect(contexts).toEqual([undefined]);
	});

	it("holds a detached binding through the real operation and its asynchronous after-hook", async () => {
		const { tool, context, events } = fixture();
		const operation = Promise.withResolvers<void>();
		const afterEntered = Promise.withResolvers<void>();
		const after = Promise.withResolvers<void>();
		const completions: Promise<BackgroundToolCallCompletion>[] = [];
		const contexts: (ExecutionContext | undefined)[] = [];
		tool.bindInvocation = async () => ({
			executionContext: context,
			execute: async () => {
				await operation.promise;
				return result();
			},
			release: () => events.push("released"),
		});
		try {
			await run(tool, {
				subscribeToolCallHandoffRequest: (_id, request) => {
					request();
					return () => {};
				},
				handoffToolCall: (call) => {
					contexts.push(call.executionContext);
					completions.push(call.completion);
					return { result: result() };
				},
				afterToolCall: async (call) => {
					contexts.push(call.executionContext);
					afterEntered.resolve();
					await after.promise;
					return undefined;
				},
			});
			expect(completions).toHaveLength(1);
			expect(events).toEqual([]);
			operation.resolve();
			await afterEntered.promise;
			expect(events).toEqual([]);
			after.resolve();
			await completions[0];
			expect(events).toEqual(["released"]);
			expect(contexts).toEqual([context, context]);
		} finally {
			operation.resolve();
			after.resolve();
			await Promise.allSettled(completions);
		}
	});
});
