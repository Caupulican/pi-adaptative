import { EventStream } from "@caupulican/pi-ai/event-stream";
import type { AssistantMessage, AssistantMessageEvent, Message, Model } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { startAgentProviderRequest } from "../src/agent-loop.ts";
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	SentPrefixDisturbanceInfo,
} from "../src/types.ts";

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
	it("runs the accepted request lifecycle in validation, commit, snapshot, transport order", async () => {
		const order: string[] = [];
		const initial: AgentContext = { systemPrompt: "SYSTEM", messages: [user("old")], tools: [] };
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: toLlm,
			planContext: async ({ messages, attempt }) => ({
				messages,
				...(attempt === 0
					? {}
					: {
							prepareCommit: () => {
								order.push("final-validation");
								return true;
							},
							commit: () => order.push("commit"),
						}),
			}),
			onProviderRequestSnapshot: ({ requestId, sourceContext }) => {
				order.push("snapshot");
				expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
				expect(sourceContext.messages).toEqual([user("accepted")]);
				expect(initial.messages).toEqual([user("accepted")]);
			},
		};
		let admissionCount = 0;
		config.admitProviderRequest = ({ sourceContext, attempt }) => {
			admissionCount++;
			if (attempt === 0) {
				return { action: "replan", context: { ...sourceContext, messages: [user("accepted")] } };
			}
			return { action: "send" };
		};

		const response = await startAgentProviderRequest(initial, config, undefined, () => {
			order.push("transport");
			return new MockAssistantStream(assistant("sent"));
		});
		await response.result();

		expect(admissionCount).toBe(2);
		expect(order).toEqual(["final-validation", "commit", "snapshot", "transport"]);
	});

	it("offers only an accepted plan to the snapshot hook and fails closed before transport", async () => {
		let planCount = 0;
		let snapshotCount = 0;
		let transportCount = 0;
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: toLlm,
			planContext: async ({ messages }) => {
				planCount++;
				if (planCount === 1) return { messages, isCurrent: () => false, commit: vi.fn() };
				return { messages };
			},
			onProviderRequestSnapshot: async () => {
				snapshotCount++;
				throw new Error("snapshot persistence failed");
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
		).rejects.toThrow("snapshot persistence failed");
		expect(planCount).toBe(2);
		expect(snapshotCount).toBe(1);
		expect(transportCount).toBe(0);
	});

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

	it("projects host-owned transient instructions through the system channel", async () => {
		let admittedMessages: Message[] | undefined;
		let admittedSystemPrompt: string | undefined;
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: toLlm,
			planContext: async ({ messages }) => ({
				messages,
				transientSystemPrompt: "ACTIVE SKILL test-skill\nFollow the active skill.",
			}),
			admitProviderRequest: ({ context, nonCompactableContext }) => {
				admittedMessages = context.messages;
				admittedSystemPrompt = nonCompactableContext.systemPrompt;
				return { action: "send" };
			},
		};

		const response = await startAgentProviderRequest(
			{ systemPrompt: "BASE SYSTEM", messages: [user("actual user request")], tools: [] },
			config,
			undefined,
			() => new MockAssistantStream(assistant("sent")),
		);
		await response.result();

		expect(admittedSystemPrompt).toBe("BASE SYSTEM\n\nACTIVE SKILL test-skill\nFollow the active skill.");
		expect(admittedMessages).toEqual([user("actual user request")]);
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

	describe("onSentPrefixDisturbance", () => {
		it("reports a disturbance when transformContext rewrites an already-sent message", async () => {
			const captured: SentPrefixDisturbanceInfo[] = [];
			let call = 0;
			const config: AgentLoopConfig = {
				model: model(),
				convertToLlm: toLlm,
				// The fallback (no planContext) branch - the exact gap the worker-attempt-executor /
				// reflection-controller transformContext callers left uncovered.
				transformContext: async (messages) => {
					call++;
					if (call === 1) return messages;
					// Second call: rewrite message 0, which by then is already sent (see below).
					return [{ ...messages[0], content: [{ type: "text", text: "REWRITTEN" }] }, ...messages.slice(1)];
				},
				onSentPrefixDisturbance: (info) => captured.push(info),
			};

			const first: AgentContext = { systemPrompt: "SYSTEM", messages: [user("first")], tools: [] };
			const firstResponse = await startAgentProviderRequest(first, config, undefined, () => {
				return new MockAssistantStream(assistant("ok-1"));
			});
			await firstResponse.result();
			// After the first accepted request, the mark is 1 (only `user("first")` had been sent).
			expect(captured).toHaveLength(0);

			const second: AgentContext = {
				systemPrompt: "SYSTEM",
				messages: [...first.messages, assistant("ok-1"), user("second")],
				tools: [],
			};
			const secondResponse = await startAgentProviderRequest(second, config, undefined, () => {
				return new MockAssistantStream(assistant("ok-2"));
			});
			await secondResponse.result();

			expect(captured).toHaveLength(1);
			expect(captured[0]).toEqual({ disturbedCount: 1, firstDisturbedIndex: 0, sentPrefixCount: 1 });
		});

		// NOTE ON WHAT "LEGITIMATE COMPACTION" ACTUALLY LOOKS LIKE: compaction summarizes the OLDEST
		// messages, which sit AT OR BELOW `sentPrefixCount` (everything already sent starts from the
		// beginning of the conversation) - it does not touch messages above the mark, which is what
		// the test below does. The test below is therefore NOT a stand-in for real compaction; it only
		// demonstrates that this hook's scan is bounded to `[0, sentPrefixCount)` and structurally
		// cannot see anything at or past it, regardless of what a `planContext` does out there. The
		// test after it exercises the mechanism that actually makes real compaction safe: it never
		// runs inside `planContext`/`transformContext` at all (see `onSentPrefixDisturbance`'s doc
		// comment in types.ts for the full explanation).
		it("does not report a disturbance when planContext only touches history past the scanned boundary", async () => {
			const captured: SentPrefixDisturbanceInfo[] = [];
			const config: AgentLoopConfig = {
				model: model(),
				convertToLlm: toLlm,
				// Rewrites everything AFTER sentPrefixCount into one message, returning index 0 (and
				// everything below sentPrefixCount) BY REFERENCE, unchanged. Deliberately NOT modeled on
				// real compaction - see the note above.
				planContext: async ({ messages, sentPrefixCount }) => {
					if (messages.length <= sentPrefixCount + 1) return { messages };
					const sent = messages.slice(0, sentPrefixCount);
					const summarized = user("stand-in for whatever a host does past the scanned boundary");
					const rest = messages.slice(messages.length - 1);
					return { messages: [...sent, summarized, ...rest] };
				},
				onSentPrefixDisturbance: (info) => captured.push(info),
			};

			const first: AgentContext = { systemPrompt: "SYSTEM", messages: [user("first")], tools: [] };
			const firstResponse = await startAgentProviderRequest(first, config, undefined, () => {
				return new MockAssistantStream(assistant("ok-1"));
			});
			await firstResponse.result();

			const second: AgentContext = {
				systemPrompt: "SYSTEM",
				messages: [...first.messages, assistant("ok-1"), user("second"), user("third")],
				tools: [],
			};
			const secondResponse = await startAgentProviderRequest(second, config, undefined, () => {
				return new MockAssistantStream(assistant("ok-2"));
			});
			await secondResponse.result();

			expect(captured).toHaveLength(0);
		});

		it("does not report a disturbance across a real compaction replan, even though it rewrites an already-sent message", async () => {
			// This is what actually makes real compaction safe (see the doc comment on
			// AgentLoopConfig.onSentPrefixDisturbance in types.ts): compaction runs through
			// admitProviderRequest's `{action: "replan"}`, entirely outside planContext/transformContext
			// - the two functions this hook observes. It happens BETWEEN admission attempts, not within
			// the one attempt this hook compares. So even though the replan below collapses the
			// ALREADY-SENT `user("first")` into a summary, the hook never sees a "before" that still has
			// the original message: by the time detection runs again on the next attempt, the mark has
			// already been re-clamped against the new, shorter sourceContext, and both "before" and
			// "after" for that attempt already reflect the post-compaction array.
			const captured: SentPrefixDisturbanceInfo[] = [];
			const config: AgentLoopConfig = {
				model: model(),
				convertToLlm: toLlm,
				admitProviderRequest: ({ sourceContext, attempt }) => {
					if (attempt === 0 && sourceContext.messages.length > 2) {
						return {
							action: "replan",
							context: {
								...sourceContext,
								messages: [
									user("summary of the oldest turns"),
									sourceContext.messages[sourceContext.messages.length - 1],
								],
							},
						};
					}
					return { action: "send" };
				},
				onSentPrefixDisturbance: (info) => captured.push(info),
			};

			const first: AgentContext = { systemPrompt: "SYSTEM", messages: [user("first")], tools: [] };
			const firstResponse = await startAgentProviderRequest(first, config, undefined, () => {
				return new MockAssistantStream(assistant("ok-1"));
			});
			await firstResponse.result();
			// Mark is now 1: only `user("first")` had gone out on the first accepted request.

			const second: AgentContext = {
				systemPrompt: "SYSTEM",
				messages: [...first.messages, assistant("ok-1"), user("second"), user("third")],
				tools: [],
			};
			const secondResponse = await startAgentProviderRequest(second, config, undefined, () => {
				return new MockAssistantStream(assistant("ok-2"));
			});
			await secondResponse.result();

			// The already-sent `user("first")` is gone from the accepted context - replaced by a
			// summary - yet the hook never fired.
			expect(JSON.stringify(second.messages)).not.toContain("first");
			expect(JSON.stringify(second.messages)).toContain("summary of the oldest turns");
			expect(captured).toHaveLength(0);
		});

		it("does not report a disturbance when a host reconstructs an equivalent already-sent message", async () => {
			// Not one of the two required scenarios, but exercises the specific behavior the escalation
			// step exists for: a NEW reference at an already-sent index whose CONTENT is unchanged (e.g.
			// a host that round-trips messages through its own normalization layer) must not be reported
			// - nothing the provider would see actually changed. Neither test above exercises this: the
			// rewrite test's replacement has different content, and the untouched-region test above keeps
			// the same reference throughout.
			const captured: SentPrefixDisturbanceInfo[] = [];
			let call = 0;
			const config: AgentLoopConfig = {
				model: model(),
				convertToLlm: toLlm,
				transformContext: async (messages) => {
					call++;
					if (call === 1) return messages;
					return [{ ...messages[0] }, ...messages.slice(1)];
				},
				onSentPrefixDisturbance: (info) => captured.push(info),
			};

			const first: AgentContext = { systemPrompt: "SYSTEM", messages: [user("first")], tools: [] };
			const firstResponse = await startAgentProviderRequest(first, config, undefined, () => {
				return new MockAssistantStream(assistant("ok-1"));
			});
			await firstResponse.result();

			const second: AgentContext = {
				systemPrompt: "SYSTEM",
				messages: [...first.messages, assistant("ok-1"), user("second")],
				tools: [],
			};
			const secondResponse = await startAgentProviderRequest(second, config, undefined, () => {
				return new MockAssistantStream(assistant("ok-2"));
			});
			await secondResponse.result();

			expect(captured).toHaveLength(0);
		});
	});
});
