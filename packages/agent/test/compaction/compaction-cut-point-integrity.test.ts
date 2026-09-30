import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { findCutPoint, prepareCompaction } from "../../src/compaction/compaction.ts";
import { convertToLlm } from "../../src/messages.ts";
import {
	buildSessionContext,
	type CustomMessageEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "../../src/session/session-manager.ts";

function history(interleaved: boolean): SessionEntry[] {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "first", name: "read", arguments: { path: "first.ts" } },
			{ type: "toolCall", id: "second", name: "read", arguments: { path: "second.ts" } },
		],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
	const inputs: (
		| Omit<SessionMessageEntry, "id" | "parentId" | "timestamp">
		| Omit<CustomMessageEntry, "id" | "parentId" | "timestamp">
	)[] = [
		{ type: "message", message: { role: "user", content: "work", timestamp: 0 } },
		{ type: "message", message: assistant },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "first",
				toolName: "read",
				content: [{ type: "text", text: "a".repeat(400) }],
				isError: false,
				timestamp: 2,
			},
		},
		...(interleaved
			? [{ type: "custom_message" as const, customType: "progress", content: "still working", display: false }]
			: []),
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "second",
				toolName: "read",
				content: [{ type: "text", text: "b".repeat(400) }],
				isError: false,
				timestamp: 3,
			},
		},
		{
			type: "message",
			message: { ...assistant, content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 4 },
		},
	];
	return inputs.map((entry, index) => ({
		...entry,
		id: `entry-${index}`,
		parentId: index > 0 ? `entry-${index - 1}` : null,
		timestamp: new Date(index).toISOString(),
	}));
}

function repeatedCallHistory(reuseToolCallId: boolean): SessionEntry[] {
	const secondCallId = reuseToolCallId ? "shared-call" : "second-call";
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "shared-call", name: "read", arguments: { path: "first.ts" } }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
	const finish = (text: string, timestamp: number): AssistantMessage => ({
		...assistant,
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp,
	});
	const inputs: Omit<SessionMessageEntry, "id" | "parentId" | "timestamp">[] = [
		{ type: "message", message: { role: "user", content: "older work", timestamp: 0 } },
		{ type: "message", message: assistant },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "shared-call",
				toolName: "read",
				content: [{ type: "text", text: "first result" }],
				isError: false,
				timestamp: 2,
			},
		},
		{ type: "message", message: finish("First task done.", 3) },
		{ type: "message", message: { role: "user", content: "new task ".repeat(100), timestamp: 4 } },
		{
			type: "message",
			message: {
				...assistant,
				content: [{ type: "toolCall", id: secondCallId, name: "read", arguments: { path: "second.ts" } }],
				timestamp: 5,
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: secondCallId,
				toolName: "read",
				content: [{ type: "text", text: "second result" }],
				isError: false,
				timestamp: 6,
			},
		},
		{ type: "message", message: finish("Second task done.", 7) },
	];
	return inputs.map((entry, index) => ({
		...entry,
		id: `reused-call-entry-${index}`,
		parentId: index > 0 ? `reused-call-entry-${index - 1}` : null,
		timestamp: new Date(index).toISOString(),
	}));
}

describe("compaction cut preserves completed tool exchanges", () => {
	it.each([false, true])("cuts at the new user turn with repeated tool call IDs=%s", (reuseToolCallId) => {
		const entries = repeatedCallHistory(reuseToolCallId);
		const cut = findCutPoint(entries, 0, entries.length, 40);
		expect(cut.firstKeptEntryIndex).toBe(4);
	});

	it.each([false, true])("keeps tool results paired when progress is interleaved=%s", (interleaved) => {
		const entries = history(interleaved);
		const preparation = prepareCompaction(entries, { enabled: true, reserveTokens: 1000, keepRecentTokens: 150 });
		expect(preparation).toBeDefined();
		const messages = convertToLlm(
			buildSessionContext([
				...entries,
				{
					type: "compaction",
					id: "checkpoint",
					parentId: entries.at(-1)!.id,
					timestamp: new Date(10).toISOString(),
					summary: "checkpoint",
					firstKeptEntryId: preparation!.firstKeptEntryId,
					tokensBefore: preparation!.tokensBefore,
				},
			]).messages,
		);
		const calls = new Set(
			messages.flatMap((message) =>
				message.role === "assistant"
					? message.content.filter((block) => block.type === "toolCall").map((call) => call.id)
					: [],
			),
		);
		for (const message of messages) {
			if (message.role === "toolResult") expect(calls.has(message.toolCallId)).toBe(true);
		}
	});

	it("does not pull a completed custom message back across the selected boundary", () => {
		const entries = history(false);
		entries.splice(entries.length - 1, 0, {
			type: "custom_message",
			id: "large-progress",
			parentId: entries.at(-2)!.id,
			timestamp: new Date(5).toISOString(),
			customType: "progress",
			content: "x".repeat(1000),
			display: false,
		});
		const point = findCutPoint(entries, 0, entries.length, 1);
		expect(entries[point.firstKeptEntryIndex].id).toBe(entries.at(-1)!.id);
	});

	it("preserves pairing across seeded host-message interleavings and repeated compaction", () => {
		let seed = 0x30_09_2026;
		for (let trial = 0; trial < 40; trial++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			const entries = history(false);
			for (let insertion = 0; insertion < 4; insertion++) {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				const index = 2 + (seed % 3);
				entries.splice(index, 0, {
					type: "custom_message",
					id: `host-${trial}-${insertion}`,
					parentId: entries[index - 1].id,
					timestamp: new Date(2).toISOString(),
					customType: "background-progress",
					content: "evidence ".repeat(seed % 150),
					display: false,
				});
			}
			for (let cycle = 0; cycle < 2; cycle++) {
				const preparation = prepareCompaction(
					entries,
					{
						enabled: true,
						reserveTokens: 1000,
						keepRecentTokens: 1 + (seed % 800),
					},
					{ allowTrailingCompactionAsPrevious: true },
				);
				expect(preparation).toBeDefined();
				entries.push({
					type: "compaction",
					id: `checkpoint-${trial}-${cycle}`,
					parentId: entries.at(-1)!.id,
					timestamp: new Date(10 + cycle).toISOString(),
					summary: "checkpoint",
					firstKeptEntryId: preparation!.firstKeptEntryId,
					tokensBefore: preparation!.tokensBefore,
				});
				const messages = convertToLlm(buildSessionContext(entries).messages);
				const calls = new Set<string>();
				for (const message of messages) {
					if (message.role === "assistant") {
						for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
					}
					if (message.role === "toolResult") expect(calls.has(message.toolCallId)).toBe(true);
				}
			}
		}
	});
});
