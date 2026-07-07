import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { type CompactionPreparation, createDeterministicCompaction } from "../../src/compaction/compaction.ts";
import { extractCompactionFacts, renderFactsBlock } from "../../src/compaction/extraction.ts";
import { verifySummary } from "../../src/compaction/verification.ts";
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
	isError = false,
): ToolResultMessage<Record<string, unknown>> {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details,
		isError,
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

	it("generates bounded action lines from verb and path only", () => {
		resetEntryCounter();

		const entries: SessionMessageEntry[] = [];
		for (let i = 0; i < 18; i++) {
			entries.push(
				createMessageEntry(
					createAssistantMessage([
						{ type: "toolCall", id: `tc-${i}`, name: "edit", arguments: { path: `src/file-${i}.ts` } },
					]),
				),
			);
			entries.push(createMessageEntry(createToolResult(`tc-${i}`, "edit", `noisy outcome ${i} ${"x".repeat(120)}`)));
		}

		const facts = extractCompactionFacts(entries, 0, entries.length);

		expect(facts.actions).toHaveLength(15);
		expect(facts.actions[0]).toBe("EDIT src/file-3.ts");
		expect(facts.actions[14]).toBe("EDIT src/file-17.ts");
		expect(facts.actions.join("\n")).not.toContain("noisy outcome");
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

	it("does not harvest subordinate prohibition fragments as standalone rules", () => {
		resetEntryCounter();
		const text =
			"v0.81.4-v0.81.6 are done and released/committed — do not touch them beyond what these two plans specify.";
		const facts = extractCompactionFacts([createMessageEntry(createUserMessage(text))], 0, 1);

		expect(facts.prohibitions).toEqual([
			"v0.81.4-v0.81.6 are done and released/committed — do not touch them beyond what these two plans specify",
		]);
		expect(facts.prohibitions).not.toContain(
			"are done and released/committed — do not touch them beyond what these two plans specify",
		);
	});

	it("does not harvest prohibitions from pasted documents and caps the rule set", () => {
		resetEntryCounter();
		// A pasted instruction document (field incident: 13 fragment rules extracted from one
		// paste, making the mandatory-rules gate demand the checkpoint reproduce the document).
		const pastedDoc = `Execute the plan.\n${Array.from({ length: 13 }, (_, i) => `Rule ${i}: never do thing number ${i} under any circumstances, and do not forget it.`).join("\n")}\n${"filler ".repeat(300)}`;
		expect(pastedDoc.length).toBeGreaterThan(1500);
		const u1 = createMessageEntry(createUserMessage(pastedDoc));
		const fromDoc = extractCompactionFacts([u1], 0, 1);
		expect(fromDoc.prohibitions).toEqual([]);
		expect(fromDoc.activeTaskSource).toBe(pastedDoc.slice(0, 4000));

		resetEntryCounter();
		// Spoken prohibitions still harvest, bounded to the most recent 8.
		const entries = Array.from({ length: 12 }, (_, i) =>
			createMessageEntry(createUserMessage(`do not touch module-${i}`)),
		);
		const spoken = extractCompactionFacts(entries, 0, entries.length);
		expect(spoken.prohibitions).toHaveLength(8);
		expect(spoken.prohibitions[0]).toBe("do not touch module-4");
		expect(spoken.prohibitions[7]).toBe("do not touch module-11");
	});

	it("does not treat everyday 'stop the server' phrasing as a reversal of prior work", () => {
		resetEntryCounter();

		const u1 = createMessageEntry(createUserMessage("start"));
		const a1 = createMessageEntry(createAssistantMessage([{ type: "text", text: "edited the wedge handler" }]));
		const u2 = createMessageEntry(createUserMessage("stop the server and rerun the tests"));

		const facts = extractCompactionFacts([u1, a1, u2], 0, 3);
		expect(facts.cancelledText).toBe("");

		resetEntryCounter();
		const v1 = createMessageEntry(createUserMessage("start"));
		const v2 = createMessageEntry(createAssistantMessage([{ type: "text", text: "edited the wedge handler" }]));
		const v3 = createMessageEntry(createUserMessage("revert that, wrong direction"));

		const reversed = extractCompactionFacts([v1, v2, v3], 0, 3);
		expect(reversed.cancelledText).toContain("edited the wedge handler");
	});

	it("picks activeTaskSource as last user message", () => {
		resetEntryCounter();

		const u1 = createMessageEntry(createUserMessage("first"));
		const u2 = createMessageEntry(createUserMessage("second"));
		const facts = extractCompactionFacts([u1, u2], 0, 2);
		expect(facts.activeTaskSource).toBe("second");
	});

	it("dedupes actions before applying the 15-action cap, keeping the most recent occurrence", () => {
		resetEntryCounter();
		const entries: SessionMessageEntry[] = [];
		for (let i = 0; i < 15; i++) {
			entries.push(
				createMessageEntry(
					createAssistantMessage([
						{
							type: "toolCall",
							id: `tc-distinct-${i}`,
							name: "edit",
							arguments: { path: `src/distinct-${i}.ts` },
						},
					]),
				),
			);
		}
		for (let i = 0; i < 6; i++) {
			entries.push(
				createMessageEntry(
					createAssistantMessage([
						{ type: "toolCall", id: `tc-foo-${i}`, name: "edit", arguments: { path: "foo.ts" } },
					]),
				),
			);
		}

		const facts = extractCompactionFacts(entries, 0, entries.length);

		expect(facts.actions).toHaveLength(15);
		expect(facts.actions.filter((action) => action === "EDIT foo.ts")).toHaveLength(1);
		for (let i = 1; i < 15; i++) {
			expect(facts.actions).toContain(`EDIT src/distinct-${i}.ts`);
		}
		expect(facts.actions).not.toContain("EDIT src/distinct-0.ts");
	});

	it("excludes harness plumbing paths from file and action facts", () => {
		resetEntryCounter();

		const contextGcRead = createMessageEntry(
			createAssistantMessage([
				{
					type: "toolCall",
					id: "tc-context-gc",
					name: "read",
					arguments: { path: "/home/user/.pi/agent/context-gc/session/blob.txt" },
				},
			]),
		);
		const bashLog = createMessageEntry(
			createAssistantMessage([
				{
					type: "toolCall",
					id: "tc-bash",
					name: "bash",
					arguments: { command: "tail -n 20 /tmp/pi-bash-abc123.log" },
				},
			]),
		);
		const realRead = createMessageEntry(
			createAssistantMessage([
				{ type: "toolCall", id: "tc-real", name: "read", arguments: { path: "src/real.ts" } },
			]),
		);

		const facts = extractCompactionFacts([contextGcRead, bashLog, realRead], 0, 3);

		expect(facts.files.map((file) => file.path)).toEqual(["src/real.ts"]);
		expect(facts.actions).toEqual(["READ src/real.ts"]);
	});

	it("keeps only unresolved error facts by operation", () => {
		resetEntryCounter();
		const failedRead = createMessageEntry(
			createAssistantMessage([
				{ type: "toolCall", id: "tc-read-fail", name: "read", arguments: { path: "src/a.ts" } },
			]),
		);
		const failedReadResult = createMessageEntry(
			createToolResult("tc-read-fail", "read", "Error: file missing\nstack trace", undefined, true),
		);
		const successfulRead = createMessageEntry(
			createAssistantMessage([
				{ type: "toolCall", id: "tc-read-ok", name: "read", arguments: { path: "src/a.ts" } },
			]),
		);
		const successfulReadResult = createMessageEntry(createToolResult("tc-read-ok", "read", "ok"));
		const failedEdit = createMessageEntry(
			createAssistantMessage([
				{ type: "toolCall", id: "tc-edit-fail", name: "edit", arguments: { path: "src/a.ts" } },
			]),
		);
		const failedEditResult = createMessageEntry(
			createToolResult("tc-edit-fail", "edit", "Exit code 1: patch failed", undefined, true),
		);

		const facts = extractCompactionFacts(
			[failedRead, failedReadResult, successfulRead, successfulReadResult, failedEdit, failedEditResult],
			0,
			6,
		);

		expect(facts.errorFacts).toEqual([{ operation: "EDIT src/a.ts", error: "Exit code 1: patch failed" }]);
	});

	it("orders the working set by last touch and caps it to recent files", () => {
		resetEntryCounter();
		const entries: SessionMessageEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(
				createMessageEntry(
					createAssistantMessage([
						{ type: "toolCall", id: `tc-${i}`, name: "read", arguments: { path: `src/file-${i}.ts` } },
					]),
				),
			);
		}

		const facts = extractCompactionFacts(entries, 0, entries.length);

		expect(facts.files.map((file) => file.path).slice(0, 3)).toEqual([
			"src/file-9.ts",
			"src/file-8.ts",
			"src/file-7.ts",
		]);
		expect(facts.workingSet.map((file) => file.path)).toEqual([
			"src/file-9.ts",
			"src/file-8.ts",
			"src/file-7.ts",
			"src/file-6.ts",
			"src/file-5.ts",
			"src/file-4.ts",
			"src/file-3.ts",
			"src/file-2.ts",
		]);
	});

	it("renders extraction facts in deterministic fallback checkpoints", () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 123,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
			facts: {
				files: [{ path: "src/open.ts", kind: "modified", note: "EDIT" }],
				workingSet: [{ path: "src/open.ts", kind: "modified", note: "EDIT" }],
				actions: ["EDIT src/open.ts"],
				errorFacts: [{ operation: "TEST npm test", error: "1 failed: open.test.ts" }],
				prohibitions: [],
				cancelledText: "",
				activeTaskSource: "Fix open test failure",
			},
		};

		const result = createDeterministicCompaction(preparation);

		expect(result.summary).toContain("## Working Set\n- src/open.ts — EDIT");
		expect(result.summary).toContain("## Files\n- src/open.ts");
		expect(result.summary).toContain("## Open Problems\n- TEST npm test: 1 failed: open.test.ts");
		expect(result.summary).toContain("## Critical Context");
		expect(result.summary).toContain("working set:\nsrc/open.ts — EDIT");
		expect(result.summary).toContain("open errors:\nTEST npm test: 1 failed: open.test.ts");
		expect(verifySummary(result.summary, preparation.facts!)).toEqual({ ok: true, failures: [] });
	});

	it("returns empty facts for empty input", () => {
		resetEntryCounter();
		const facts = extractCompactionFacts([], 0, 0);

		expect(facts.files).toEqual([]);
		expect(facts.workingSet).toEqual([]);
		expect(facts.actions).toEqual([]);
		expect(facts.errorFacts).toEqual([]);
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
			workingSet: [{ path: "src/b.ts", kind: "modified", note: "edited" }],
			actions: ["EDIT src/b.ts"],
			errorFacts: [{ operation: "TEST npm test", error: "2 failed: fetcher.test.ts" }],
			prohibitions: ["Do not delete"],
			cancelledText: "",
			activeTaskSource: "Keep going",
		});

		expect(block).toBe(
			"files:\n" +
				"read: src/a.ts — read file\n" +
				"modified: src/b.ts — edited\n" +
				"working set:\n" +
				"src/b.ts — edited\n" +
				"actions:\n" +
				"EDIT src/b.ts\n" +
				"open errors:\n" +
				"TEST npm test: 2 failed: fetcher.test.ts\n" +
				"prohibitions:\n" +
				"Do not delete\n" +
				"active task:\n" +
				"Keep going",
		);
	});

	it("facts block carries the active task text (bounded) so the gate's demand always reaches the prompt", () => {
		const longTask = `fix the wedge ${"y".repeat(5000)}`;
		const block = renderFactsBlock({
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: longTask,
		});

		expect(block).toContain("active task:\nfix the wedge");
		const taskLine = block.split("active task:\n")[1];
		expect(taskLine.length).toBeLessThanOrEqual(4000);

		const emptyBlock = renderFactsBlock({
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
		});
		expect(emptyBlock.endsWith("active task:")).toBe(true);
	});
});
