import type {
	AgentMessage,
	BashExecutionMessage,
	BranchSummaryMessage,
	CompactionSummaryMessage,
	CustomMessage,
} from "@caupulican/pi-agent-core";
import type { AssistantMessage, StopReason, ToolResultMessage, Usage, UserMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	parseSanitizedContextForkMode,
	SANITIZED_CONTEXT_FORK_COMPACTION_PREFIX,
	SANITIZED_CONTEXT_FORK_COMPACTION_SUFFIX,
	selectSanitizedContextFork,
} from "../src/core/delegation/sanitized-context-fork.ts";
import {
	MAX_WORKER_CONTEXT_FORK_BYTES,
	MAX_WORKER_CONTEXT_FORK_MESSAGES,
	MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS,
} from "../src/core/orchestration/worker-context-fork-reference.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(content: UserMessage["content"], timestamp: number): UserMessage {
	return { role: "user", content, timestamp };
}

function assistant(
	content: AssistantMessage["content"],
	timestamp: number,
	stopReason: StopReason = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: structuredClone(ZERO_USAGE),
		stopReason,
		timestamp,
	};
}

function textOf(message: UserMessage | AssistantMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

describe("sanitized context fork", () => {
	it("parses none, all, and positive last-N modes while rejecting ambiguous bounds", () => {
		expect(parseSanitizedContextForkMode(" none ")).toEqual({ kind: "none" });
		expect(parseSanitizedContextForkMode("ALL")).toEqual({ kind: "all" });
		expect(parseSanitizedContextForkMode("03")).toEqual({ kind: "last_user_turns", count: 3 });

		for (const invalid of ["", "0", "-1", "1.5", "NaN", "9007199254740992"]) {
			expect(() => parseSanitizedContextForkMode(invalid)).toThrow("none, all, or a positive safe-integer string");
		}
	});

	it("returns no inherited context for none", () => {
		const messages: AgentMessage[] = [
			user("private parent request", 1),
			assistant([{ type: "text", text: "done" }], 2),
		];

		expect(selectSanitizedContextFork(messages, { kind: "none" })).toEqual([]);
	});

	it("retains a safe compaction checkpoint plus complete native user and final assistant text", () => {
		const transientSecret: CustomMessage = {
			role: "custom",
			customType: "developer-secret",
			content: "TRANSIENT_DEVELOPER_SECRET",
			display: false,
			timestamp: 1,
		};
		const shell: BashExecutionMessage = {
			role: "bashExecution",
			command: "printenv",
			output: "TRANSIENT_SHELL_SECRET",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 2,
		};
		const branch: BranchSummaryMessage = {
			role: "branchSummary",
			summary: "TRANSIENT_BRANCH_SUMMARY",
			fromId: "branch-1",
			timestamp: 3,
		};
		const compaction: CompactionSummaryMessage = {
			role: "compactionSummary",
			summary: "durable recalled facts",
			tokensBefore: 987_654_321,
			timestamp: 4,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text", text: "TRANSIENT_TOOL_RESULT" }],
			isError: false,
			timestamp: 7,
		};
		const commentarySignature = JSON.stringify({ v: 1, id: "commentary", phase: "commentary" });
		const finalSignature = JSON.stringify({ v: 1, id: "final", phase: "final_answer" });
		const messages: AgentMessage[] = [
			assistant([{ type: "text", text: "orphan assistant" }], 0),
			transientSecret,
			shell,
			branch,
			compaction,
			user(
				[
					{ type: "image", data: "TRANSIENT_IMAGE", mimeType: "image/png" },
					{ type: "text", text: "safe user text", textSignature: "user-provider-id" },
				],
				5,
			),
			assistant(
				[
					{ type: "thinking", thinking: "TRANSIENT_REASONING" },
					{ type: "text", text: "TRANSIENT_COMMENTARY", textSignature: commentarySignature },
					{ type: "text", text: "safe final text", textSignature: finalSignature },
					{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/secret" } },
				],
				6,
			),
			toolResult,
			user("[Worker control worker-message-deadbeef from=worker-1]\nTRANSIENT_MAILBOX", 8),
			user(
				[
					{ type: "text", text: "[Worker control worker-" },
					{ type: "text", text: "message-split]\nTRANSIENT_SPLIT_MAILBOX" },
				],
				9,
			),
			user("second safe user", 10),
			assistant([{ type: "text", text: "partial output" }], 11, "length"),
			assistant([{ type: "text", text: "failed output" }], 12, "error"),
			assistant([{ type: "text", text: "aborted output" }], 13, "aborted"),
			assistant(
				[
					{ type: "text", text: "tool preamble" },
					{ type: "toolCall", id: "tool-2", name: "read", arguments: {} },
				],
				14,
				"toolUse",
			),
			assistant([{ type: "text", text: "second safe final" }], 15),
		];

		const selected = selectSanitizedContextFork(messages, { kind: "all" });

		expect(selected.map((message) => [message.role, textOf(message)])).toEqual([
			[
				"user",
				`${SANITIZED_CONTEXT_FORK_COMPACTION_PREFIX}durable recalled facts${SANITIZED_CONTEXT_FORK_COMPACTION_SUFFIX}safe user text`,
			],
			["assistant", "safe final text"],
			["user", "second safe user"],
			["assistant", "second safe final"],
		]);
		expect(JSON.stringify(selected)).not.toMatch(
			/TRANSIENT|toolCall|toolResult|thinking|textSignature|responseId|diagnostics/,
		);
		expect(JSON.stringify(selected)).not.toContain("987654321");
		expect(messages[5]).toEqual(
			user(
				[
					{ type: "image", data: "TRANSIENT_IMAGE", mimeType: "image/png" },
					{ type: "text", text: "safe user text", textSignature: "user-provider-id" },
				],
				5,
			),
		);
	});

	it("binds each bounded compaction checkpoint to its following real user turn", () => {
		const compaction: CompactionSummaryMessage = {
			role: "compactionSummary",
			summary: "recalled parent state",
			tokensBefore: 200,
			timestamp: 1,
		};
		const messages: AgentMessage[] = [
			compaction,
			{ role: "custom", customType: "hidden", content: "drop me", display: false, timestamp: 2 },
			user("first real turn", 3),
			assistant([{ type: "text", text: "first answer" }], 4),
			user("second real turn", 5),
			assistant([{ type: "text", text: "second answer" }], 6),
		];

		const all = selectSanitizedContextFork(messages, { kind: "all" });
		expect(all.map((message) => textOf(message))).toEqual([
			`${SANITIZED_CONTEXT_FORK_COMPACTION_PREFIX}recalled parent state${SANITIZED_CONTEXT_FORK_COMPACTION_SUFFIX}first real turn`,
			"first answer",
			"second real turn",
			"second answer",
		]);
		expect(selectSanitizedContextFork(messages, { kind: "last_user_turns", count: 1 }).map(textOf)).toEqual([
			"second real turn",
			"second answer",
		]);
	});

	it("selects the last N real user turns after sanitization", () => {
		const messages: AgentMessage[] = [
			user("turn one", 1),
			assistant([{ type: "text", text: "answer one" }], 2),
			user("[Worker control worker-message-control]\nignore", 3),
			user("turn two", 4),
			assistant([{ type: "text", text: "answer two" }], 5),
			user("turn three", 6),
			assistant([{ type: "text", text: "answer three" }], 7),
		];

		const selected = selectSanitizedContextFork(messages, { kind: "last_user_turns", count: 2 });

		expect(selected.map((message) => textOf(message))).toEqual([
			"turn two",
			"answer two",
			"turn three",
			"answer three",
		]);
	});

	it("never migrates assistant output across dropped worker-control or image-only user boundaries", () => {
		const messages: AgentMessage[] = [
			user("first real turn", 1),
			assistant([{ type: "text", text: "first answer" }], 2),
			user("[Worker control worker-message-boundary]\nqueued evidence", 3),
			assistant([{ type: "text", text: "answer to worker control" }], 4),
			user([{ type: "image", data: "image-only", mimeType: "image/png" }], 5),
			assistant([{ type: "text", text: "answer to unsupported image" }], 6),
			user("latest real turn", 7),
			assistant([{ type: "text", text: "latest answer" }], 8),
		];

		expect(selectSanitizedContextFork(messages, { kind: "all" }).map(textOf)).toEqual([
			"first real turn",
			"first answer",
			"latest real turn",
			"latest answer",
		]);
	});

	it("recognizes bounded worker-control headers independently of large payload blocks", () => {
		const payload = "x".repeat(8_192);
		const messages: AgentMessage[] = [
			user(`[Worker control worker-message-long-string]\n${payload}`, 1),
			user([{ type: "text", text: `[Worker control worker-message-large-block]\n${payload}` }], 2),
			user(
				[
					{ type: "text", text: "[Worker control worker-message-" },
					{ type: "text", text: `split-large]\n${payload}` },
				],
				3,
			),
			user(`[Worker control worker-message-not-protocol] ${payload}`, 4),
		];

		expect(selectSanitizedContextFork(messages, { kind: "all" }).map(textOf)).toEqual([
			`[Worker control worker-message-not-protocol] ${payload}`,
		]);
	});

	it("drops an oversized block-array turn without projecting or crossing it", () => {
		const oversizedBlocks = Array.from({ length: 1025 }, () => ({ type: "text" as const, text: "x" }));
		const messages: AgentMessage[] = [
			user("older turn", 1),
			assistant([{ type: "text", text: "older answer" }], 2),
			user(oversizedBlocks, 3),
			assistant([{ type: "text", text: "must not migrate" }], 4),
		];

		expect(selectSanitizedContextFork(messages, { kind: "all" })).toEqual([]);
	});

	it("keeps the newest whole-turn suffix within one aggregate text-block ceiling", () => {
		const blocksPerTurn = MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS / 2 + 1;
		const messages: AgentMessage[] = [
			user(
				Array.from({ length: blocksPerTurn }, (_, index) => ({ type: "text" as const, text: `older-${index}` })),
				1,
			),
			user(
				Array.from({ length: blocksPerTurn }, (_, index) => ({ type: "text" as const, text: `newer-${index}` })),
				2,
			),
		];

		const selected = selectSanitizedContextFork(messages, { kind: "all" });

		expect(selected).toHaveLength(1);
		expect(selected[0]?.role).toBe("user");
		expect(selected[0]?.content).toHaveLength(blocksPerTurn);
		expect(textOf(selected[0]!)).toContain("newer-0");
		expect(textOf(selected[0]!)).not.toContain("older-0");
	});

	it("keeps a newest whole-turn suffix within the established count and byte ceilings", () => {
		const manyTurns: AgentMessage[] = Array.from({ length: 70 }, (_, index) => user(`turn ${index}`, index));
		const countBounded = selectSanitizedContextFork(manyTurns, { kind: "all" });

		expect(countBounded).toHaveLength(MAX_WORKER_CONTEXT_FORK_MESSAGES);
		expect(textOf(countBounded[0] as UserMessage)).toBe("turn 6");
		expect(textOf(countBounded.at(-1) as UserMessage)).toBe("turn 69");

		const payload = "x".repeat(Math.floor(MAX_WORKER_CONTEXT_FORK_BYTES / 3));
		const byteTurns: AgentMessage[] = [
			user(`turn one ${payload}`, 1),
			user(`turn two ${payload}`, 2),
			user(`turn three ${payload}`, 3),
		];
		const byteBounded = selectSanitizedContextFork(byteTurns, { kind: "all" });

		expect(byteBounded.map((message) => textOf(message))).toEqual([`turn two ${payload}`, `turn three ${payload}`]);
		expect(Buffer.byteLength(JSON.stringify(byteBounded), "utf-8")).toBeLessThanOrEqual(
			MAX_WORKER_CONTEXT_FORK_BYTES,
		);
	});

	it("fails closed when the newest user turn cannot fit without truncation", () => {
		const oversized = user("🙂".repeat(MAX_WORKER_CONTEXT_FORK_BYTES), 1);

		expect(selectSanitizedContextFork([oversized], { kind: "all" })).toEqual([]);
	});

	it("never detaches a user turn from an oversized compaction checkpoint", () => {
		const oversizedCheckpoint: CompactionSummaryMessage = {
			role: "compactionSummary",
			summary: "x".repeat(MAX_WORKER_CONTEXT_FORK_BYTES),
			tokensBefore: 10,
			timestamp: 1,
		};

		expect(selectSanitizedContextFork([oversizedCheckpoint, user("following turn", 2)], { kind: "all" })).toEqual([]);
	});
});
