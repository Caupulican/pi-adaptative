import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	ToolResultMessage,
} from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	type CompactionExecutionOptions,
	type CompactionPreparation,
	type CompactionSettings,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
} from "../../src/compaction/index.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "../../src/session/session-manager.ts";
import type { AgentMessage } from "../../src/types.ts";

const emptyUsage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(): Model<"openai-responses"> {
	return {
		id: "grok-4.6",
		name: "Grok 4.6",
		api: "openai-responses",
		provider: "xai",
		baseUrl: "https://cli-chat-proxy.grok.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500_000,
		maxTokens: 32_000,
		compat: { requestFormat: "xai-cli", supportsLongCacheRetention: false },
	};
}

function acceptedSummary(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text: `## Active Task
(none)

### Mandatory Rules
(none)

## Working Set
(none)

## Files
(none)

## Open Problems
(none)

## Done
(none)

## Key Decisions
(none)

## Constraints & Preferences
(none)

## Critical Context
Structured checkpoint`,
			},
		],
		api: "openai-responses",
		provider: "xai",
		model: "grok-4.6",
		usage: emptyUsage,
		stopReason: "stop",
		timestamp: 10,
	};
}

function assistant(id: string, text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "thinking",
				thinking: "preserved reasoning",
				thinkingSignature: JSON.stringify({
					type: "reasoning",
					id: `rs_${id}`,
					status: "completed",
					summary: [],
					encrypted_content: `encrypted-${id}`,
				}),
			},
			{ type: "text", text },
			{ type: "toolCall", id: `call_${id}|fc_${id}`, name: "inspect", arguments: { id } },
		],
		api: "openai-responses",
		provider: "xai",
		model: "grok-4.6",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp,
	};
}

function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	};
}

describe("session-replacement compaction", () => {
	it("summarizes a temporary structured clone on the live subscription affinity", async () => {
		const historicalAssistant = assistant("history", "I will inspect it.", 2);
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call_history|fc_history",
			toolName: "inspect",
			content: [{ type: "text", text: "inspection complete" }],
			isError: false,
			timestamp: 3,
		};
		const sourceMessages: Message[] = [
			{ role: "user", content: "Keep the original task exact.", timestamp: 1 },
			historicalAssistant,
			toolResult,
		];
		const sourceContext: Context = {
			systemPrompt: "live system instructions",
			messages: sourceMessages,
			tools: [{ name: "inspect", description: "Inspect an item", parameters: { type: "object" } }],
		};
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "user-1",
			messagesToSummarize: sourceMessages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 400_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: {
				...DEFAULT_COMPACTION_SETTINGS,
				strategy: "session-replacement",
			},
		};
		let capturedContext: Context | undefined;
		let capturedOptions: SimpleStreamOptions | undefined;
		const completion = vi.fn(async (_model: Model<Api>, context: Context, options: SimpleStreamOptions) => {
			capturedContext = context;
			capturedOptions = options;
			return acceptedSummary();
		});
		const executionOptions = {
			chunked: false,
			completion,
			structuredRequest: {
				context: sourceContext,
				sessionId: "live-session-affinity",
				cacheRetention: "short",
			},
		} satisfies CompactionExecutionOptions;

		await compact(
			preparation,
			model(),
			"oauth-token",
			undefined,
			undefined,
			undefined,
			"low",
			undefined,
			undefined,
			executionOptions,
		);

		expect(completion).toHaveBeenCalledOnce();
		expect(capturedContext?.systemPrompt).toBe("live system instructions");
		expect(capturedContext?.tools).toEqual(sourceContext.tools);
		expect(capturedContext?.messages.slice(0, -1)).toEqual(sourceMessages);
		expect(capturedContext?.messages.at(-1)).toMatchObject({ role: "user" });
		expect(capturedContext?.messages.at(-1)).not.toBe(sourceMessages.at(-1));
		expect(capturedOptions).toMatchObject({
			cacheRetention: "short",
			sessionId: "live-session-affinity",
		});
		expect(sourceContext.messages).toHaveLength(3);
	});

	it("prepares the complete live context and records sparse original-user retention", () => {
		const firstUser = entry("u1", null, {
			role: "user",
			content: `Original task ${"a".repeat(800)}`,
			timestamp: 1,
		});
		const firstAssistant = entry("a1", "u1", assistant("first", "first result", 2));
		const secondUser = entry("u2", "a1", {
			role: "user",
			content: `Follow-up ${"b".repeat(800)}`,
			timestamp: 3,
		});
		const secondAssistant = entry("a2", "u2", assistant("second", "second result", 4));
		const entries: SessionEntry[] = [firstUser, firstAssistant, secondUser, secondAssistant];
		const settings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 100,
			strategy: "session-replacement",
		} satisfies CompactionSettings;

		const preparation = prepareCompaction(entries, settings);

		expect(preparation?.messagesToSummarize).toEqual(buildSessionContext(entries).messages);
		expect(preparation?.firstKeptEntryId).toBe("u1");
		expect(preparation?.retention).toEqual({
			mode: "original-user",
			userEntryId: "u1",
		});
		expect(preparation?.isSplitTurn).toBe(false);
	});

	it("rebuilds only the original request, checkpoint, and post-compaction turns", () => {
		const firstUser = entry("u1", null, { role: "user", content: "Original task", timestamp: 1 });
		const oldAssistant = entry("a1", "u1", assistant("old", "obsolete detail", 2));
		const oldFollowUp = entry("u2", "a1", { role: "user", content: "Old follow-up", timestamp: 3 });
		const oldAnswer = entry("a2", "u2", assistant("answer", "old answer", 4));
		const compaction = {
			type: "compaction",
			id: "c1",
			parentId: "a2",
			timestamp: new Date(5).toISOString(),
			summary: "Authoritative checkpoint",
			firstKeptEntryId: "u1",
			tokensBefore: 400_000,
			retention: { mode: "original-user", userEntryId: "u1" },
		} satisfies CompactionEntry;
		const laterUser = entry("u3", "c1", { role: "user", content: "Continue now", timestamp: 6 });

		const context = buildSessionContext([
			firstUser,
			oldAssistant,
			oldFollowUp,
			oldAnswer,
			compaction,
			laterUser,
		] as SessionEntry[]);

		expect(context.messages.map((message) => message.role)).toEqual(["user", "compactionSummary", "user"]);
		expect(context.messages[0]).toMatchObject({ content: "Original task" });
		expect(context.messages[1]).toMatchObject({ summary: "Authoritative checkpoint" });
		expect(context.messages[2]).toMatchObject({ content: "Continue now" });
	});

	it("replaces an earlier checkpoint without rescanning or restoring discarded dialogue", () => {
		const firstUser = entry("u1", null, { role: "user", content: "Original task", timestamp: 1 });
		const discarded = entry("a1", "u1", assistant("discarded", "discarded detail", 2));
		const firstCompaction = {
			type: "compaction",
			id: "c1",
			parentId: "a1",
			timestamp: new Date(3).toISOString(),
			summary: "First checkpoint",
			firstKeptEntryId: "u1",
			tokensBefore: 400_000,
			retention: { mode: "original-user", userEntryId: "u1" },
		} satisfies CompactionEntry;
		const laterUser = entry("u2", "c1", { role: "user", content: "New work", timestamp: 4 });
		const laterAssistant = entry("a2", "u2", assistant("later", "new result", 5));
		const entries = [firstUser, discarded, firstCompaction, laterUser, laterAssistant] as SessionEntry[];
		const settings = {
			...DEFAULT_COMPACTION_SETTINGS,
			strategy: "session-replacement",
		} satisfies CompactionSettings;

		const preparation = prepareCompaction(entries, settings);

		expect(preparation?.messagesToSummarize).toEqual(buildSessionContext(entries).messages);
		expect(preparation?.messagesToSummarize).toHaveLength(4);
		expect(preparation?.messagesToSummarize).not.toContain(discarded.message);
		expect(preparation?.previousSummary).toBeUndefined();
		expect(preparation?.retention).toEqual({
			mode: "original-user",
			userEntryId: "u1",
		});

		const secondCompaction = {
			type: "compaction",
			id: "c2",
			parentId: "a2",
			timestamp: new Date(6).toISOString(),
			summary: "Second checkpoint",
			firstKeptEntryId: "u1",
			tokensBefore: 400_000,
			retention: { mode: "original-user", userEntryId: "u1" },
		} satisfies CompactionEntry;
		const replaced = buildSessionContext([...entries, secondCompaction] as SessionEntry[]);
		expect(replaced.messages.map((message) => message.role)).toEqual(["user", "compactionSummary"]);
		expect(replaced.messages[1]).toMatchObject({ summary: "Second checkpoint" });
	});

	it("fails closed on a malformed sparse-retention anchor", () => {
		const firstUser = entry("u1", null, { role: "user", content: "Original task", timestamp: 1 });
		const discarded = entry("a1", "u1", assistant("discarded", "must stay discarded", 2));
		const malformedCompaction = {
			type: "compaction",
			id: "c1",
			parentId: "a1",
			timestamp: new Date(3).toISOString(),
			summary: "Safe checkpoint",
			firstKeptEntryId: "u1",
			tokensBefore: 400_000,
			retention: { mode: "original-user", userEntryId: "missing-user" },
		} satisfies CompactionEntry;

		const context = buildSessionContext([firstUser, discarded, malformedCompaction] as SessionEntry[]);

		expect(context.messages.map((message) => message.role)).toEqual(["compactionSummary"]);
		expect(JSON.stringify(context.messages)).not.toContain("must stay discarded");
	});

	it("rejects summarizer responses that hallucinate tool calls (F5 guard)", async () => {
		const historicalAssistant = assistant("history", "I will inspect it.", 2);
		const sourceMessages: Message[] = [
			{ role: "user", content: "Keep the original task exact.", timestamp: 1 },
			historicalAssistant,
		];
		const sourceContext: Context = {
			systemPrompt: "live system instructions",
			messages: sourceMessages,
			tools: [{ name: "inspect", description: "Inspect an item", parameters: { type: "object" } }],
		};
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "user-1",
			messagesToSummarize: sourceMessages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 400_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: {
				...DEFAULT_COMPACTION_SETTINGS,
				strategy: "session-replacement",
			},
		};
		const completion = vi.fn(async () => {
			return {
				...acceptedSummary(),
				content: [{ type: "toolCall", id: "hallucinated-call", name: "inspect", arguments: {} } as any],
			};
		});
		const executionOptions = {
			chunked: false,
			completion,
			structuredRequest: {
				context: sourceContext,
				sessionId: "live-session-affinity",
				cacheRetention: "short",
			},
		} satisfies CompactionExecutionOptions;

		await expect(
			compact(
				preparation,
				model(),
				"oauth-token",
				undefined,
				undefined,
				undefined,
				"low",
				undefined,
				undefined,
				executionOptions,
			),
		).rejects.toThrow("summary-tool-call");
	});

	it("standalone compaction requests do not expose tools or force toolChoice (F5 negative control)", async () => {
		const sourceMessages: Message[] = [{ role: "user", content: "Standalone summarization message", timestamp: 1 }];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "user-1",
			messagesToSummarize: sourceMessages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 400_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: {
				...DEFAULT_COMPACTION_SETTINGS,
				strategy: "session-replacement",
			},
		};
		let capturedContext: Context | undefined;
		let capturedOptions: SimpleStreamOptions | undefined;
		const completion = vi.fn(async (_model: Model<Api>, context: Context, options: SimpleStreamOptions) => {
			capturedContext = context;
			capturedOptions = options;
			return acceptedSummary();
		});

		await compact(preparation, model(), "oauth-token", undefined, undefined, undefined, "low", undefined, undefined, {
			chunked: false,
			completion,
		});

		expect(capturedContext?.tools).toBeUndefined();
		expect((capturedOptions as any)?.toolChoice).toBeUndefined();
	});
});
