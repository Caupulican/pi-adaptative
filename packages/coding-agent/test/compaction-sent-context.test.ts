import { type Api, AssistantMessageEventStream, createEmptyUsage, type Model } from "@caupulican/pi-ai";
import { expect, it } from "vitest";
import { type LastSentRequest, sessionLaneSummarizerRequest } from "../src/core/compaction-support.ts";
import { Agent } from "../src/kernel/agent.ts";
import {
	advanceMessageContentRevision,
	capturePublishedMessagePrefix,
	immutableHistoryMessage,
	withMessageSource,
} from "../src/kernel/message-revision.ts";
import type { AgentMessage } from "../src/kernel/types.ts";

const model: Model<Api> = {
	id: "compaction-sent-prefix",
	name: "Compaction fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 32_000,
	maxTokens: 1_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const prepare = (lastSent: LastSentRequest, liveMessages: AgentMessage[]) =>
	sessionLaneSummarizerRequest({
		compactionModel: model,
		sessionModel: model,
		systemPrompt: "Summarize.",
		tools: undefined,
		messagesToSummarize: liveMessages,
		liveMessages,
		lastSent,
		textToolCallProtocol: undefined,
		sessionId: "foreground",
	})?.sentContext;

it("extends the accepted prefix through its immediate immutable source only while the branch and revision match", () => {
	const raw = { role: "user", content: "Original.", timestamp: 1 } as const;
	const next = { role: "user", content: "New.", timestamp: 2 } as const;
	const acceptedLast = immutableHistoryMessage(raw)!;
	let sameBranch = true;
	const sent: LastSentRequest = {
		model,
		context: { messages: [raw] },
		sourceBoundary: { count: 1, last: acceptedLast },
		assertSourceBranch: () => {
			if (!sameBranch) throw new Error("The branch changed.");
		},
	};
	expect(prepare(sent, [raw, next])?.messages).toEqual([raw, next]);
	expect(prepare(sent, [{ ...raw }, next])).toBeUndefined();
	const rewritten = immutableHistoryMessage(withMessageSource(raw, { ...raw, content: "Rewritten." }))!;
	expect(prepare({ ...sent, sourceBoundary: { count: 1, last: rewritten } }, [raw, next])).toBeUndefined();
	sameBranch = false;
	expect(prepare(sent, [raw, next])).toBeUndefined();
	sameBranch = true;
	advanceMessageContentRevision(raw);
	expect(prepare(sent, [raw, next])).toBeUndefined();
});

it("drops compaction reuse for an earlier published edit with the same last row", () => {
	const first = { role: "user", content: "Original first row.", timestamp: 1 } as const;
	const last = { role: "user", content: "Same last row.", timestamp: 2 } as const;
	const later = { role: "user", content: "Ordinary append.", timestamp: 3 } as const;
	const agent = new Agent({ initialState: { model, messages: [first, last] } });
	const firstSnapshot = immutableHistoryMessage(first)!;
	const lastSnapshot = immutableHistoryMessage(last)!;
	const isCurrent = capturePublishedMessagePrefix(() => agent.state.messages, 2);
	const sent: LastSentRequest = {
		model,
		context: { messages: [{ ...first }, { ...last }] },
		sourceBoundary: { count: 2, last: lastSnapshot },
		assertSourceBranch: () => {
			if (!isCurrent()) throw new Error("The accepted provider request prefix changed.");
		},
	};
	agent.appendMessage(later);
	expect(prepare(sent, agent.state.messages)?.messages).toEqual([firstSnapshot, lastSnapshot, later]);
	agent.replaceMessageContents(first, { ...first, content: "Published earlier edit." });
	expect(agent.state.messages[1]).toBe(last);
	expect(prepare(sent, agent.state.messages)).toBeUndefined();

	const rewritten = capturePublishedMessagePrefix(() => agent.state.messages, 2);
	agent.state.messages[0] = later;
	expect(agent.state.messages[1]).toBe(last);
	expect(rewritten()).toBe(false);
	expect(capturePublishedMessagePrefix(() => [first, last], 2)()).toBe(false);
});

it("borrows the source only for the snapshot callback the session installed", async () => {
	let planningSource: AgentMessage[] | undefined;
	let customSnapshot: AgentMessage[] | undefined;
	const agent = new Agent({
		initialState: { model },
		planContext: async ({ messages }) => {
			planningSource = messages;
			return { messages };
		},
		onProviderRequestSnapshot: ({ sourceContext, sourceBoundary }) => {
			expect(sourceContext.messages).toBe(planningSource);
			expect(sourceBoundary?.count).toBe(1);
			expect(sourceBoundary?.last).toBe(sourceContext.messages[0]);
		},
		streamFn: () => {
			const stream = new AssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [{ type: "text", text: "Done." }],
					usage: createEmptyUsage(),
					stopReason: "stop",
					timestamp: 2,
				},
			});
			return stream;
		},
	});
	agent.allowBorrowedProviderSnapshotSource();
	await agent.prompt("First.");
	agent.onProviderRequestSnapshot = ({ sourceContext }) => {
		customSnapshot = sourceContext.messages;
		expect(customSnapshot).not.toBe(planningSource);
	};
	await agent.prompt("Second.");
	expect(customSnapshot).toHaveLength(3);
	expect(agent.state.messages).toHaveLength(4);
});
