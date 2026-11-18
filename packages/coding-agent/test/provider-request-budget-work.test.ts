import {
	type Api,
	AssistantMessageEventStream,
	type Context,
	createEmptyUsage,
	type ImageContent,
	type Model,
	type ToolResultMessage,
	type UserMessage,
} from "@caupulican/pi-ai";
import { observeHistoryWork, providerMessagePrefix } from "@caupulican/pi-ai/history-work";
import { expect, it } from "vitest";
import { applyContextGc } from "../src/core/context-gc.ts";
import type { AgentContext, AgentLoopConfig } from "../src/kernel/loop-config.ts";
import {
	advanceMessageContentRevision,
	createVersionedMessageHistory,
	immutableHistoryMessage,
} from "../src/kernel/message-revision.ts";
import { convertToLlm, createCustomMessage } from "../src/kernel/messages.ts";
import { estimateProviderRequestTokens } from "../src/kernel/provider-request-estimator.ts";
import {
	applyProviderRequestImageBudget,
	TOOL_IMAGE_BUDGET_NOTE,
	USER_IMAGE_BUDGET_PLACEHOLDER,
} from "../src/kernel/provider-request-image-budget.ts";

import { startPlannedAgentProviderRequestWithId } from "../src/kernel/provider-request-planner.ts";
import { createToolFailureContextMemory } from "../src/kernel/tool-failure-memory.ts";

const visionModel: Model<Api> = {
	id: "vision",
	name: "Vision fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 32000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

it("recomputes admission for an in-place edit even when the wire array and message retain their identity", () => {
	const message: UserMessage = { role: "user", content: "short", timestamp: 0 };
	const context = { messages: [message] };
	const before = estimateProviderRequestTokens(context);
	message.content = "longer".repeat(200);
	advanceMessageContentRevision(message);
	const after = estimateProviderRequestTokens(context);
	expect(after).toBeGreaterThan(before);
	expect(after).toBe(estimateProviderRequestTokens({ messages: [{ ...message }] }));
});

it.each([true, false])("evicts in block order with an existing tool note = %s", (existingNote) => {
	const image: ImageContent = { type: "image", data: "A".repeat(2048), mimeType: "image/png" };
	const text = { type: "text" as const, text: "unchanged" };
	const note = { type: "text" as const, text: TOOL_IMAGE_BUDGET_NOTE };
	const user: UserMessage = { role: "user", content: [image, text], timestamp: 1 };
	const tool: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		timestamp: 2,
		isError: false,
		content: [image, ...(existingNote ? [note] : []), text, image, image],
	};
	const untouched: UserMessage = { role: "user", content: [text, image], timestamp: 3 };
	const context: Context = { messages: [user, tool, untouched] };
	const expected = {
		messages: [
			{ ...user, content: [{ type: "text", text: USER_IMAGE_BUDGET_PLACEHOLDER }, text] },
			{ ...tool, content: existingNote ? [note, text, image] : [text, image, note] },
			untouched,
		],
	};
	const bytes = Buffer.byteLength(JSON.stringify(context));
	const target = Buffer.byteLength(JSON.stringify(expected));
	const result = applyProviderRequestImageBudget(context, visionModel, {
		triggerBytes: bytes,
		hardLimitBytes: bytes + 1,
		reclaimTargetBytes: target,
	});
	expect(result.context).toEqual(expected);
	expect(result.context.messages[2]).toBe(untouched);
	expect(result.outcome).toMatchObject({ evicted: 3, inlineImages: 5, bodyBytes: bytes, bodyBytesAfter: target });
	expect(tool.content.filter((block) => block.type === "image")).toHaveLength(3);
});

function providerProjectionFixture(rows: number) {
	const messages = createVersionedMessageHistory(
		Array.from(
			{ length: rows },
			(_, index) =>
				immutableHistoryMessage(
					createCustomMessage(
						"history-work",
						`History row ${index}.`,
						false,
						undefined,
						new Date(index).toISOString(),
					),
				)!,
		),
	);
	const source: AgentContext = { systemPrompt: "Follow the owner.", messages, tools: [] };
	let accept = true;
	let compressionPolicy = "normal";
	const config: AgentLoopConfig = {
		model: visionModel,
		providerAccountKey: "fixture-account",
		providerMessageProjectionOwner: {},
		providerRequestPrefixState: {
			sentPrefixCount: 0,
			sanitizerSentPrefixCount: 0,
			sanitizerMemory: createToolFailureContextMemory(),
		},
		convertToLlm,
		admitProviderRequest: ({ context, model }) => {
			estimateProviderRequestTokens(context, model);
			return { action: "send" };
		},
		planContext: async ({ messages }) => ({ messages, compressionPolicy, isDispatchCurrent: () => accept }),
	};
	const send = async () => {
		const work = observeHistoryWork(messages);
		let dispatched: Context | undefined;
		const started = await startPlannedAgentProviderRequestWithId(source, config, undefined, (model, context) => {
			dispatched = context;
			const stream = new AssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [],
					usage: createEmptyUsage(),
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
			return stream;
		});
		await started.stream.result();
		return { work, dispatched };
	};
	return {
		config,
		source,
		messages,
		send,
		userRow: (text: string) => immutableHistoryMessage({ role: "user", content: text, timestamp: 1 })!,
		setAccept: (value: boolean) => {
			accept = value;
		},
		setPolicy: (policy: string) => {
			compressionPolicy = policy;
		},
	};
}

it.each([100, 1_000, 10_000])("projects only the new suffix over %s accepted rows", async (rows) => {
	const fixture = providerProjectionFixture(rows);
	const cold = await fixture.send();
	expect(cold.work.providerRowsConverted).toBe(rows);
	expect(providerMessagePrefix(cold.dispatched!.messages)).toEqual({ previous: undefined, count: 0 });

	fixture.messages.push(fixture.userRow("New input."));
	const warm = await fixture.send();
	expect(warm.work).toMatchObject({
		oldRowsRead: 0,
		coldPayloadLoads: 0,
		oldBytesRecompressed: 0,
		projectedRows: 1,
		providerRowsConverted: 1,
		// The wire contract still exposes one ordinary message array to the provider and hooks.
		copiedRows: rows,
	});
	expect(providerMessagePrefix(warm.dispatched!.messages)).toEqual({
		previous: cold.dispatched!.messages,
		count: rows,
	});
	expect(warm.dispatched!.messages[rows - 1]).toBe(cold.dispatched!.messages[rows - 1]);

	fixture.messages[rows - 2] = fixture.userRow("Edited input.");
	const edited = await fixture.send();
	expect(edited.work.providerRowsConverted).toBe(3);
	expect(providerMessagePrefix(edited.dispatched!.messages)?.count).toBe(rows - 2);
	expect(edited.dispatched!.messages[rows - 2]?.content).toBe("Edited input.");
});

it("does not retain the suffix of a refused dispatch and invalidates on projection policy changes", async () => {
	const fixture = providerProjectionFixture(100);
	const cold = await fixture.send();
	fixture.messages.push(fixture.userRow("Undispatched."));
	fixture.setAccept(false);
	const rejected = await fixture.send();
	expect(rejected.dispatched).toBeUndefined();

	fixture.messages.push(fixture.userRow("Next input."));
	fixture.setAccept(true);
	const retry = await fixture.send();
	expect(retry.work.providerRowsConverted).toBe(2);
	expect(providerMessagePrefix(retry.dispatched!.messages)?.previous).toBe(cold.dispatched!.messages);

	fixture.setPolicy("new compression policy");
	const changed = await fixture.send();
	expect(changed.work.providerRowsConverted).toBe(102);
	expect(providerMessagePrefix(changed.dispatched!.messages)?.count).toBe(0);
});

it.each(["account", "model", "prompt", "tools"] as const)(
	"starts a new provider projection on a %s change",
	async (scope) => {
		const fixture = providerProjectionFixture(100);
		await fixture.send();
		if (scope === "account") fixture.config.providerAccountKey = "another-account";
		if (scope === "model") fixture.config.model = { ...visionModel, id: "another-model" };
		if (scope === "prompt") fixture.source.systemPrompt = "A different system prompt.";
		if (scope === "tools")
			fixture.source.tools = [
				{
					name: "lookup",
					label: "Lookup",
					description: "Look up a fixture.",
					parameters: {},
					execute: async () => ({ content: [], details: undefined }),
				},
			];
		const changed = await fixture.send();
		expect(changed.work.providerRowsConverted).toBe(100);
		expect(providerMessagePrefix(changed.dispatched!.messages)?.count).toBe(0);
	},
);

it("does not retain evidence from mutable caller rows", async () => {
	const fixture = providerProjectionFixture(100);
	const mutable: UserMessage = { role: "user", content: "Before.", timestamp: 0 };
	fixture.messages[0] = mutable;
	const first = await fixture.send();
	expect(providerMessagePrefix(first.dispatched!.messages)).toBeUndefined();

	mutable.content = "After.";
	const second = await fixture.send();
	expect(second.work.providerRowsConverted).toBe(100);
	expect(second.dispatched!.messages[0]?.content).toBe("After.");
	expect(providerMessagePrefix(second.dispatched!.messages)).toBeUndefined();
});

it("does not certify the pre-image-budget array when the provider receives a projection", async () => {
	const fixture = providerProjectionFixture(100);
	fixture.config.model = { ...visionModel, input: ["text"] };
	fixture.messages.push(
		immutableHistoryMessage({
			role: "user",
			timestamp: 1,
			content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
		})!,
	);
	const first = await fixture.send();
	expect(first.dispatched!.messages[100]?.content).toEqual([
		{ type: "text", text: "(image omitted: model does not support images)" },
	]);
	expect(providerMessagePrefix(first.dispatched!.messages)).toBeUndefined();

	fixture.messages.push(fixture.userRow("Follow-up."));
	const next = await fixture.send();
	expect(next.dispatched!.messages[100]?.content).toEqual(first.dispatched!.messages[100]?.content);
	expect(providerMessagePrefix(next.dispatched!.messages)).toBeUndefined();
});

it("extends an accepted packed tool result without replaying the old tool body", async () => {
	const rows = 1_000;
	const fixture = providerProjectionFixture(rows);
	const original = "original tool output line\n".repeat(2_048);
	fixture.messages[1] = immutableHistoryMessage({
		role: "toolResult",
		toolCallId: "large-bash-result",
		toolName: "bash",
		isError: false,
		content: [{ type: "text", text: original }],
		timestamp: 1,
	})!;
	fixture.config.planContext = async ({ messages, sentPrefixCount }) => {
		const gc = applyContextGc(messages, {
			enabled: true,
			preserveRecentMessages: 1,
			packStrideMessages: 1,
			minToolResultChars: 100,
			tools: ["bash"],
			writePayloads: false,
			deferProviderAcceptance: true,
			frozenBelow: sentPrefixCount,
		});
		return {
			messages: gc.messages,
			compressionPolicy: gc.compressionPolicy,
			prepareCommit: gc.isCurrent,
			commit: gc.commit,
			acceptProviderHistory: gc.acceptProviderHistory,
		};
	};
	const cold = await fixture.send();
	const packed = cold.dispatched!.messages[1]!;
	expect(packed.role).toBe("toolResult");
	expect(JSON.stringify(packed.content)).toContain("Never treat summary as original.");
	expect(JSON.stringify(packed.content).length).toBeLessThan(original.length / 10);

	fixture.messages.push(fixture.userRow("Follow-up."));
	const warm = await fixture.send();
	expect(warm.dispatched!.messages[1]).toBe(packed);
	expect(providerMessagePrefix(warm.dispatched!.messages)).toEqual({
		previous: cold.dispatched!.messages,
		count: rows,
	});
	expect(warm.work).toMatchObject({
		oldRowsRead: 0,
		oldBytesRecompressed: 0,
		coldPayloadLoads: 0,
		providerRowsConverted: 1,
	});
});
