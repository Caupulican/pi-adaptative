import { describe, expect, it } from "vitest";
import {
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	bashExecutionToText,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	convertToLlm,
	isCoreConversationMessageRole,
	isWireNativeAgentMessageRole,
} from "../../src/messages.ts";
import {
	type BranchSummaryEntry,
	buildSessionContext,
	type CompactionEntry,
	type ModelChangeEntry,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "../../src/session/session-manager.ts";
import { reconcileTransientRecords } from "../../src/transient-records.ts";
import type { AgentMessage } from "../../src/types.ts";

function msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: "2025-01-01T00:00:00Z" };
	if (role === "user") {
		return { ...base, message: { role, content: text, timestamp: 1 } };
	}
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function compaction(id: string, parentId: string | null, summary: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 1000,
	};
}

function branchSummary(id: string, parentId: string | null, summary: string, fromId: string): BranchSummaryEntry {
	return { type: "branch_summary", id, parentId, timestamp: "2025-01-01T00:00:00Z", summary, fromId };
}

function thinkingLevel(id: string, parentId: string | null, level: string): ThinkingLevelChangeEntry {
	return { type: "thinking_level_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", thinkingLevel: level };
}

function modelChange(id: string, parentId: string | null, provider: string, modelId: string): ModelChangeEntry {
	return { type: "model_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", provider, modelId };
}

describe("buildSessionContext", () => {
	describe("trivial cases", () => {
		it("empty entries returns empty context", () => {
			const ctx = buildSessionContext([]);
			expect(ctx.messages).toEqual([]);
			expect(ctx.thinkingLevel).toBe("off");
			expect(ctx.model).toBeNull();
		});

		it("single user message", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello")];
			const ctx = buildSessionContext(entries);
			expect(ctx.messages).toHaveLength(1);
			expect(ctx.messages[0].role).toBe("user");
		});

		it("simple conversation", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				msg("2", "1", "assistant", "hi there"),
				msg("3", "2", "user", "how are you"),
				msg("4", "3", "assistant", "great"),
			];
			const ctx = buildSessionContext(entries);
			expect(ctx.messages).toHaveLength(4);
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		});

		it("tracks thinking level changes", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				thinkingLevel("2", "1", "high"),
				msg("3", "2", "assistant", "thinking hard"),
			];
			const ctx = buildSessionContext(entries);
			expect(ctx.thinkingLevel).toBe("high");
			expect(ctx.messages).toHaveLength(2);
		});

		it("tracks model from assistant message", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello"), msg("2", "1", "assistant", "hi")];
			const ctx = buildSessionContext(entries);
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-test" });
		});

		it("tracks model from model change entry", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				modelChange("2", "1", "openai", "gpt-4"),
				msg("3", "2", "assistant", "hi"),
			];
			const ctx = buildSessionContext(entries);
			// Assistant message overwrites model change
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-test" });
		});
	});

	describe("with compaction", () => {
		it("includes summary before kept messages", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "response1"),
				msg("3", "2", "user", "second"),
				msg("4", "3", "assistant", "response2"),
				compaction("5", "4", "Summary of first two turns", "3"),
				msg("6", "5", "user", "third"),
				msg("7", "6", "assistant", "response3"),
			];
			const ctx = buildSessionContext(entries);

			// Should have: summary + kept (3,4) + after (6,7) = 5 messages
			expect(ctx.messages).toHaveLength(5);
			expect((ctx.messages[0] as any).summary).toContain("Summary of first two turns");
			expect((ctx.messages[1] as any).content).toBe("second");
			expect((ctx.messages[2] as any).content[0].text).toBe("response2");
			expect((ctx.messages[3] as any).content).toBe("third");
			expect((ctx.messages[4] as any).content[0].text).toBe("response3");
		});

		it("handles compaction keeping from first message", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "response"),
				compaction("3", "2", "Empty summary", "1"),
				msg("4", "3", "user", "second"),
			];
			const ctx = buildSessionContext(entries);

			// Summary + all messages (1,2,4)
			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[0] as any).summary).toContain("Empty summary");
		});

		it("carries the current transient record of each kind across the compaction cut", () => {
			const record = (kind: string, content: string) => {
				const message = reconcileTransientRecords([], [{ kind, content }])[0];
				if (message.role !== "custom" || typeof message.content !== "string") throw new Error("record");
				return message.content;
			};
			const custom = (
				id: string,
				parentId: string,
				customType: string,
				content: string,
				details?: Record<string, unknown>,
			): SessionEntry => ({
				type: "custom_message",
				id,
				parentId,
				timestamp: "2025-01-01T00:00:00Z",
				customType,
				content,
				display: false,
				...(details ? { details } : {}),
			});
			const entries: SessionEntry[] = [
				msg("u1", null, "user", "start"),
				custom("s1", "u1", "active_skill_context", record("active_skill_context", "skill A")),
				custom("l1", "s1", "path_alias_legend", "p/1=src/a.ts", { cumulative: true }),
				custom("p1", "l1", "pi_tool_failure_protocol", "pointer", { pointer: true }),
				msg("a1", "p1", "assistant", "working"),
				custom("s2", "a1", "active_skill_context", record("active_skill_context", "skill B")),
				custom("l2", "s2", "path_alias_legend", "p/2=src/b.ts", { cumulative: true }),
				custom("n1", "l2", "plain_note", "not a transient record"),
				msg("u2", "n1", "user", "continue"),
				msg("a2", "u2", "assistant", "done"),
				compaction("c1", "a2", "Summary", "u2"),
			];
			const context = buildSessionContext(entries, "c1");
			const shape = context.messages.map((message) =>
				message.role === "custom"
					? `${message.customType}:${typeof message.content === "string" ? message.content.split("\n")[0] : "?"}`
					: message.role,
			);
			// Summary, then the current skill record (skill A superseded), every legend delta, then the tail.
			expect(shape).toEqual([
				shape[0],
				"path_alias_legend:p/1=src/a.ts",
				"active_skill_context:skill B",
				"path_alias_legend:p/2=src/b.ts",
				"user",
				"assistant",
			]);
			expect(shape[0]).toMatch(/^compactionSummary/u);
		});

		it("carries nothing for a kind that already has a record in the kept tail", () => {
			const record = (kind: string, content: string) => {
				const message = reconcileTransientRecords([], [{ kind, content }])[0];
				if (message.role !== "custom" || typeof message.content !== "string") throw new Error("record");
				return message.content;
			};
			const goal = (id: string, parentId: string, content: string): SessionEntry => ({
				type: "custom_message",
				id,
				parentId,
				timestamp: "2025-01-01T00:00:00Z",
				customType: "goal_context",
				content: record("goal_context", content),
				display: false,
			});
			const entries: SessionEntry[] = [
				msg("u1", null, "user", "start"),
				goal("g1", "u1", "goal v1"),
				msg("a1", "g1", "assistant", "working"),
				msg("u2", "a1", "user", "continue"),
				goal("g2", "u2", "goal v2"),
				msg("a2", "g2", "assistant", "done"),
				compaction("c1", "a2", "Summary", "u2"),
			];
			const context = buildSessionContext(entries, "c1");
			const goals = context.messages.filter(
				(message): message is Extract<AgentMessage, { role: "custom" }> =>
					message.role === "custom" && message.customType === "goal_context",
			);
			expect(goals).toHaveLength(1);
			expect(typeof goals[0].content === "string" && goals[0].content.startsWith("goal v2")).toBe(true);
		});

		it("multiple compactions uses latest", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "a"),
				msg("2", "1", "assistant", "b"),
				compaction("3", "2", "First summary", "1"),
				msg("4", "3", "user", "c"),
				msg("5", "4", "assistant", "d"),
				compaction("6", "5", "Second summary", "4"),
				msg("7", "6", "user", "e"),
			];
			const ctx = buildSessionContext(entries);

			// Should use second summary, keep from 4
			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[0] as any).summary).toContain("Second summary");
		});
	});

	describe("with branches", () => {
		it("follows path to specified leaf", () => {
			// Tree:
			//   1 -> 2 -> 3 (branch A)
			//         \-> 4 (branch B)
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "response"),
				msg("3", "2", "user", "branch A"),
				msg("4", "2", "user", "branch B"),
			];

			const ctxA = buildSessionContext(entries, "3");
			expect(ctxA.messages).toHaveLength(3);
			expect((ctxA.messages[2] as any).content).toBe("branch A");

			const ctxB = buildSessionContext(entries, "4");
			expect(ctxB.messages).toHaveLength(3);
			expect((ctxB.messages[2] as any).content).toBe("branch B");
		});

		it("includes branch summary in path", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "response"),
				msg("3", "2", "user", "abandoned path"),
				branchSummary("4", "2", "Summary of abandoned work", "3"),
				msg("5", "4", "user", "new direction"),
			];
			const ctx = buildSessionContext(entries, "5");

			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[2] as any).summary).toContain("Summary of abandoned work");
			expect((ctx.messages[3] as any).content).toBe("new direction");
		});

		it("complex tree with multiple branches and compaction", () => {
			// Tree:
			//   1 -> 2 -> 3 -> 4 -> compaction(5) -> 6 -> 7 (main path)
			//              \-> 8 -> 9 (abandoned branch)
			//                    \-> branchSummary(10) -> 11 (resumed from 3)
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "r1"),
				msg("3", "2", "user", "q2"),
				msg("4", "3", "assistant", "r2"),
				compaction("5", "4", "Compacted history", "3"),
				msg("6", "5", "user", "q3"),
				msg("7", "6", "assistant", "r3"),
				// Abandoned branch from 3
				msg("8", "3", "user", "wrong path"),
				msg("9", "8", "assistant", "wrong response"),
				// Branch summary resuming from 3
				branchSummary("10", "3", "Tried wrong approach", "9"),
				msg("11", "10", "user", "better approach"),
			];

			// Main path to 7: summary + kept(3,4) + after(6,7)
			const ctxMain = buildSessionContext(entries, "7");
			expect(ctxMain.messages).toHaveLength(5);
			expect((ctxMain.messages[0] as any).summary).toContain("Compacted history");
			expect((ctxMain.messages[1] as any).content).toBe("q2");
			expect((ctxMain.messages[2] as any).content[0].text).toBe("r2");
			expect((ctxMain.messages[3] as any).content).toBe("q3");
			expect((ctxMain.messages[4] as any).content[0].text).toBe("r3");

			// Branch path to 11: 1,2,3 + branch_summary + 11
			const ctxBranch = buildSessionContext(entries, "11");
			expect(ctxBranch.messages).toHaveLength(5);
			expect((ctxBranch.messages[0] as any).content).toBe("start");
			expect((ctxBranch.messages[1] as any).content[0].text).toBe("r1");
			expect((ctxBranch.messages[2] as any).content).toBe("q2");
			expect((ctxBranch.messages[3] as any).summary).toContain("Tried wrong approach");
			expect((ctxBranch.messages[4] as any).content).toBe("better approach");
		});
	});

	describe("edge cases", () => {
		it("uses last entry when leafId not found", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello"), msg("2", "1", "assistant", "hi")];
			const ctx = buildSessionContext(entries, "nonexistent");
			expect(ctx.messages).toHaveLength(2);
		});

		it("handles orphaned entries gracefully", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				msg("2", "missing", "assistant", "orphan"), // parent doesn't exist
			];
			const ctx = buildSessionContext(entries, "2");
			// Should only get the orphan since parent chain is broken
			expect(ctx.messages).toHaveLength(1);
		});
	});
});

const FIXED_TIMESTAMP_MS = Date.parse("2025-01-01T00:00:00Z");

/**
 * One representative message per AgentMessage kind. Typed as a total mapping over
 * `AgentMessage["role"]`, so a newly added message kind is a compile error here too - the same
 * drift protection the `never` checks in `isWireNativeAgentMessageRole` /
 * `isCoreConversationMessageRole` give the predicates themselves.
 */
const AGENT_MESSAGE_FIXTURES: { [R in AgentMessage["role"]]: Extract<AgentMessage, { role: R }> } = {
	user: { role: "user", content: "plain user turn", timestamp: 10 },
	assistant: {
		role: "assistant",
		content: [{ type: "text", text: "assistant turn" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 11,
	},
	toolResult: {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "tool output" }],
		isError: false,
		timestamp: 12,
	},
	custom: {
		role: "custom",
		customType: "tool_failure_ledger",
		content: "ledger body",
		display: false,
		timestamp: 13,
	},
	bashExecution: {
		role: "bashExecution",
		command: "ls",
		output: "a.ts",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 14,
	},
	branchSummary: { role: "branchSummary", summary: "abandoned branch", fromId: "9", timestamp: 15 },
	compactionSummary: { role: "compactionSummary", summary: "compacted history", tokensBefore: 1000, timestamp: 16 },
};

const AGENT_MESSAGE_ROLES = Object.keys(AGENT_MESSAGE_FIXTURES) as AgentMessage["role"][];

describe("convertToLlm over a built session context", () => {
	it("wraps a compaction summary in the compaction markers and leaves real turns byte-identical", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "first"),
			msg("2", "1", "assistant", "response1"),
			compaction("3", "2", "Summary of the first turn", "2"),
			msg("4", "3", "user", "second"),
		];
		const context = buildSessionContext(entries);
		const wire = convertToLlm(context.messages);

		expect(wire).toHaveLength(3);
		expect(wire[0]).toEqual({
			role: "user",
			content: [
				{
					type: "text",
					text: `${COMPACTION_SUMMARY_PREFIX}Summary of the first turn${COMPACTION_SUMMARY_SUFFIX}`,
				},
			],
			timestamp: FIXED_TIMESTAMP_MS,
		});
		// The kept turns are already wire-shaped, so they must reach the provider as the very same
		// objects - not re-serialized copies.
		expect(wire[1]).toBe(context.messages[1]);
		expect(wire[2]).toBe(context.messages[2]);
	});

	it("wraps a branch summary in the branch markers rather than the compaction markers", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "start"),
			msg("2", "1", "assistant", "response"),
			msg("3", "2", "user", "abandoned path"),
			branchSummary("4", "2", "Tried the wrong approach", "3"),
			msg("5", "4", "user", "new direction"),
		];
		const wire = convertToLlm(buildSessionContext(entries, "5").messages);

		expect(wire).toHaveLength(4);
		expect(wire[2]).toEqual({
			role: "user",
			content: [{ type: "text", text: `${BRANCH_SUMMARY_PREFIX}Tried the wrong approach${BRANCH_SUMMARY_SUFFIX}` }],
			timestamp: FIXED_TIMESTAMP_MS,
		});
		expect(JSON.stringify(wire[2])).not.toContain(COMPACTION_SUMMARY_PREFIX);
	});

	it("lifts a string-content custom message into a single text block and keeps array content as authored", () => {
		const authoredContent = [
			{ type: "text" as const, text: "look at this" },
			{ type: "image" as const, data: "AAAA", mimeType: "image/png" as const },
		];
		const wire = convertToLlm([
			AGENT_MESSAGE_FIXTURES.custom,
			{ ...AGENT_MESSAGE_FIXTURES.custom, content: authoredContent, timestamp: 99 },
		]);

		expect(wire[0]).toEqual({ role: "user", content: [{ type: "text", text: "ledger body" }], timestamp: 13 });
		expect(wire[1]).toEqual({ role: "user", content: authoredContent, timestamp: 99 });
	});

	it("drops a bash execution marked excludeFromContext and keeps the rest of the conversation", () => {
		const wire = convertToLlm([
			AGENT_MESSAGE_FIXTURES.user,
			{ ...AGENT_MESSAGE_FIXTURES.bashExecution, excludeFromContext: true },
			AGENT_MESSAGE_FIXTURES.bashExecution,
		]);

		expect(wire).toHaveLength(2);
		expect(wire[0]).toBe(AGENT_MESSAGE_FIXTURES.user);
		expect(wire[1]).toEqual({
			role: "user",
			content: [{ type: "text", text: "Ran `ls`\n```\na.ts\n```" }],
			timestamp: 14,
		});
	});
});

describe("bashExecutionToText", () => {
	it("reports no output rather than an empty fenced block", () => {
		expect(bashExecutionToText({ ...AGENT_MESSAGE_FIXTURES.bashExecution, output: "" })).toBe(
			"Ran `ls`\n(no output)",
		);
	});

	it("reports cancellation instead of the exit code when the command was cancelled", () => {
		const text = bashExecutionToText({
			...AGENT_MESSAGE_FIXTURES.bashExecution,
			cancelled: true,
			exitCode: 130,
		});
		expect(text).toContain("(command cancelled)");
		expect(text).not.toContain("exited with code");
	});

	it("reports a non-zero exit code and points at the full output file when truncated", () => {
		const text = bashExecutionToText({
			...AGENT_MESSAGE_FIXTURES.bashExecution,
			exitCode: 2,
			truncated: true,
			fullOutputPath: "/tmp/full.log",
		});
		expect(text).toContain("Command exited with code 2");
		expect(text).toContain("[Output truncated. Full output: /tmp/full.log]");
	});

	it("stays silent about the exit code on success", () => {
		expect(bashExecutionToText(AGENT_MESSAGE_FIXTURES.bashExecution)).not.toContain("exited with code");
	});
});

describe("AgentMessage role predicates", () => {
	it("accepts a role as wire-native exactly when convertToLlm passes that message through unchanged", () => {
		for (const role of AGENT_MESSAGE_ROLES) {
			const message = AGENT_MESSAGE_FIXTURES[role];
			const [converted] = convertToLlm([message]);

			if (isWireNativeAgentMessageRole(role)) {
				expect(converted, `${role} should reach the provider untouched`).toBe(message);
			} else {
				expect(converted, `${role} should be converted, not passed through`).not.toBe(message);
				expect(converted?.role).toBe("user");
			}
		}
	});

	it("answers the wire-native question for every AgentMessage role", () => {
		const answers = Object.fromEntries(AGENT_MESSAGE_ROLES.map((role) => [role, isWireNativeAgentMessageRole(role)]));
		expect(answers).toEqual({
			user: true,
			assistant: true,
			toolResult: true,
			custom: false,
			bashExecution: false,
			branchSummary: false,
			compactionSummary: false,
		});
	});

	it("answers the core-conversation question for every AgentMessage role", () => {
		const answers = Object.fromEntries(
			AGENT_MESSAGE_ROLES.map((role) => [role, isCoreConversationMessageRole(role)]),
		);
		expect(answers).toEqual({
			user: true,
			assistant: true,
			toolResult: true,
			custom: true,
			bashExecution: false,
			branchSummary: false,
			compactionSummary: false,
		});
	});

	it("disagrees on custom: durable conversation content that still needs conversion before the wire", () => {
		expect(isWireNativeAgentMessageRole("custom")).toBe(false);
		expect(isCoreConversationMessageRole("custom")).toBe(true);

		// The disagreement is not cosmetic: reading `custom` as wire-native would hand the provider a
		// message with a role no wire API knows, instead of the converted user message.
		const [converted] = convertToLlm([AGENT_MESSAGE_FIXTURES.custom]);
		expect(converted?.role).toBe("user");
		expect(converted).not.toBe(AGENT_MESSAGE_FIXTURES.custom);
	});

	it("rejects host-computed annotations from both predicates", () => {
		for (const role of ["bashExecution", "branchSummary", "compactionSummary"] as const) {
			expect(isWireNativeAgentMessageRole(role), `${role} is not wire-native`).toBe(false);
			expect(isCoreConversationMessageRole(role), `${role} is not core conversation content`).toBe(false);
		}
	});
});
