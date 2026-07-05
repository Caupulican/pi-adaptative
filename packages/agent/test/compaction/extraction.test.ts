import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { extractCompactionFacts, renderFactsBlock } from "../../src/compaction/extraction.ts";
import type { SessionMessageEntry } from "../../src/session/session-manager.ts";

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter(): void {
	entryCounter = 0;
	lastId = null;
}

function nextEntryId(): string {
	return `test-id-${entryCounter++}`;
}

function createMessageEntry(message: Message): SessionMessageEntry {
	const id = nextEntryId();
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message: {
			...message,
			timestamp: message.timestamp ?? Date.now(),
		},
	};
	lastId = id;
	return entry;
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(
	content: Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	>,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-4",
		timestamp: Date.now(),
	};
}

function createToolResult(
	toolCallId: string,
	toolName: string,
	text: string,
	details?: Record<string, unknown>,
): ToolResultMessage<Record<string, unknown>> {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

describe("extractCompactionFacts", () => {
	it("deduplicates file facts by path and keeps higher kind", () => {
		resetEntryCounter();

		const userStart = createMessageEntry(createUserMessage("start"));
		const assistantRead = createMessageEntry(
			createAssistantMessage([
				{ type: "text", text: "read file" },
				{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "src/read-only.ts" } },
			]),
		);
		const readResult = createMessageEntry(createToolResult("tc-1", "read", "ok"));
		const assistantWriteCreated = createMessageEntry(
			createAssistantMessage([{ type: "toolCall", id: "tc-2", name: "write", arguments: { path: "src/file.ts" } }]),
		);
		const writeCreatedResult = createMessageEntry(createToolResult("tc-2", "write", "created file src/file.ts"));
		const assistantEdit = createMessageEntry(
			createAssistantMessage([{ type: "toolCall", id: "tc-3", name: "edit", arguments: { path: "src/file.ts" } }]),
		);
		const editResult = createMessageEntry(createToolResult("tc-3", "edit", "replaced section"));
		const assistantGrep = createMessageEntry(
			createAssistantMessage([
				{ type: "toolCall", id: "tc-4", name: "grep", arguments: { path: "src/search.ts", pattern: "foo" } },
			]),
		);
		const grepResult = createMessageEntry(createToolResult("tc-4", "grep", "found 1"));

		const facts = extractCompactionFacts(
			[
				userStart,
				assistantRead,
				readResult,
				assistantWriteCreated,
				writeCreatedResult,
				assistantEdit,
				editResult,
				assistantGrep,
				grepResult,
			],
			0,
			8,
		);

		expect(facts.files).toHaveLength(3);
		expect(facts.files.find((f) => f.path === "src/read-only.ts")?.kind).toBe("read");
		expect(facts.files.find((f) => f.path === "src/search.ts")?.kind).toBe("read");
		expect(facts.files.find((f) => f.path === "src/file.ts")?.kind).toBe("modified");
	});

	it("generates one action line per tool call and truncates outcome at 80 chars", () => {
		resetEntryCounter();

		const longOutcome = "x".repeat(120);
		const assistant = createMessageEntry(
			createAssistantMessage([{ type: "toolCall", id: "tc-1", name: "edit", arguments: { path: "src/long.ts" } }]),
		);
		const result = createMessageEntry(createToolResult("tc-1", "edit", longOutcome));
		const facts = extractCompactionFacts([assistant, result], 0, 2);

		expect(facts.actions).toHaveLength(1);
		const action = facts.actions[0];
		expect(action.startsWith("EDIT src/long.ts — ")).toBe(true);
		expect(action).toBe(`EDIT src/long.ts — ${"x".repeat(80)}`);
	});

	it("extracts prohibitions from user messages and dedups with sentence split", () => {
		resetEntryCounter();

		const user = createMessageEntry(
			createUserMessage(
				"Do not delete this file. Don't touch tests ever? no more experiments. do not delete this file!",
			),
		);
		const facts = extractCompactionFacts([user], 0, 1);

		expect(facts.prohibitions).toEqual(["Do not delete this file", "Don't touch tests ever", "no more experiments"]);
	});

	it("collects cancelled text for spans since previous user message", () => {
		resetEntryCounter();

		const u1 = createMessageEntry(createUserMessage("start"));
		const a1 = createMessageEntry(createAssistantMessage([{ type: "text", text: "first assistant text" }]));
		const t1 = createMessageEntry(createToolResult("tc-1", "bash", "bash output"));
		const u2 = createMessageEntry(createUserMessage("continue"));
		const a2 = createMessageEntry(
			createAssistantMessage([
				{ type: "text", text: "second assistant text" },
				{ type: "toolCall", id: "tc-2", name: "bash", arguments: { command: "echo hi" } },
			]),
		);
		const t2 = createMessageEntry(createToolResult("tc-2", "bash", "second tool output"));
		const u3 = createMessageEntry(createUserMessage("Never mind, scrap that"));
		const u4 = createMessageEntry(createUserMessage("Resume"));

		const entries = [u1, a1, t1, u2, a2, t2, u3, u4];
		const facts = extractCompactionFacts(entries, 0, entries.length);

		expect(facts.cancelledText).toContain("second assistant text");
		expect(facts.cancelledText).toContain("second tool output");
		expect(facts.cancelledText).not.toContain("first assistant text");
		expect(facts.cancelledText).not.toContain("bash output");
		expect(facts.activeTaskSource).toBe("Resume");
	});

	it("picks activeTaskSource as last user message", () => {
		resetEntryCounter();

		const u1 = createMessageEntry(createUserMessage("first"));
		const u2 = createMessageEntry(createUserMessage("second"));
		const facts = extractCompactionFacts([u1, u2], 0, 2);
		expect(facts.activeTaskSource).toBe("second");
	});

	it("returns empty facts for empty input", () => {
		resetEntryCounter();
		const facts = extractCompactionFacts([], 0, 0);

		expect(facts.files).toEqual([]);
		expect(facts.actions).toEqual([]);
		expect(facts.prohibitions).toEqual([]);
		expect(facts.cancelledText).toBe("");
		expect(facts.activeTaskSource).toBe("");
	});

	it("renders stable facts block shape", () => {
		const block = renderFactsBlock({
			files: [
				{ path: "src/a.ts", kind: "read", note: "read file" },
				{ path: "src/b.ts", kind: "modified", note: "edited" },
			],
			actions: ["EDIT src/b.ts — done"],
			prohibitions: ["Do not delete"],
			cancelledText: "",
			activeTaskSource: "Keep going",
		});

		expect(block).toBe(
			"files:\n" +
				"read: src/a.ts — read file\n" +
				"modified: src/b.ts — edited\n" +
				"actions:\n" +
				"EDIT src/b.ts — done\n" +
				"prohibitions:\n" +
				"Do not delete",
		);
	});
});
