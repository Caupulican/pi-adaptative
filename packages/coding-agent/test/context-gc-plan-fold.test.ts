import type { AgentMessage } from "@caupulican/pi-agent-core";
import { createCustomMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { applyContextGc, packSupersededHostRecords } from "../src/core/context-gc.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function readCall(index: number, path: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path } }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: index * 2,
	};
}

function readResult(index: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${index}`,
		toolName: "read",
		content: [{ type: "text", text: `content ${index}\n${"0123456789abcdef".repeat(80)}` }],
		isError: false,
		timestamp: index * 2 + 1,
	};
}

const settings = {
	cwd: "/repo",
	preserveRecentMessages: 0,
	minToolResultChars: 10,
	tools: ["read"],
	writePayloads: false,
	semanticMemory: { preserveRecentPages: 0, minChars: Number.MAX_SAFE_INTEGER },
	frozenBelow: 0,
};

function reasons(messages: AgentMessage[]): string[] {
	return applyContextGc(messages, settings).report.records.map((record) => `${record.messageIndex}:${record.reason}`);
}

describe("context-gc plan fold", () => {
	it("plans an appended history from the remembered prefix exactly as a fresh scan would", () => {
		const history: AgentMessage[] = [readCall(1, "a.ts"), readResult(1), readCall(2, "b.ts"), readResult(2)];
		const first = reasons(history);
		// A second read of a.ts supersedes the first; the plan must see it through the resumed fold.
		history.push(readCall(3, "a.ts"), readResult(3));
		const resumed = reasons(history);
		const fresh = reasons(structuredClone(history));
		expect(resumed).toEqual(fresh);
		expect(resumed).toContain("1:superseded-read");
		expect(first).not.toContain("1:superseded-read");
	});

	it("starts a new plan when the history no longer extends the remembered one", () => {
		const history: AgentMessage[] = [readCall(1, "a.ts"), readResult(1), readCall(2, "a.ts"), readResult(2)];
		expect(reasons(history)).toContain("1:superseded-read");
		// The older read is gone (a compaction): nothing supersedes the remaining one.
		const trimmed = history.slice(2);
		expect(reasons(trimmed)).toEqual(reasons(structuredClone(trimmed)));
		expect(reasons(trimmed).some((entry) => entry.endsWith("superseded-read"))).toBe(false);
	});
});

describe("context-gc superseded transient records", () => {
	const record = (kind: string, text: string, at: number) =>
		createCustomMessage(kind, text, false, undefined, new Date(at).toISOString());

	it("packs every record that a later record of the same kind supersedes, and keeps the newest", () => {
		const long = (label: string) => `${label} ${"0123456789abcdef".repeat(40)}`;
		const messages: AgentMessage[] = [
			record("active_goal_context", long("goal v1"), 1),
			readCall(1, "a.ts"),
			readResult(1),
			record("active_goal_context", long("goal v2"), 2),
			record("path_alias_legend", long("legend v1"), 3),
			readCall(2, "b.ts"),
			readResult(2),
			record("active_goal_context", long("goal v3"), 4),
		];
		const result = applyContextGc(messages, { ...settings, tools: [] });
		const packed = result.report.records.filter((entry) => entry.reason === "superseded-transient-record");
		expect(packed.map((entry) => entry.messageIndex)).toEqual([0, 3]);
		expect(packed.map((entry) => entry.toolName)).toEqual(["active_goal_context", "active_goal_context"]);
		// The packed record keeps its role and kind and names the newer record as current.
		const first = result.messages[0];
		expect(first?.role).toBe("custom");
		expect((first as { customType: string }).customType).toBe("active_goal_context");
		expect((first as { content: string }).content).toContain("superseded active_goal_context record");
		// The newest of each kind is untouched.
		expect(result.messages[4]).toBe(messages[4]);
		expect(result.messages[7]).toBe(messages[7]);
	});
});

describe("context-gc cumulative host records and the compaction projection", () => {
	const long = (label: string) => `${label} ${"0123456789abcdef".repeat(40)}`;
	const record = (kind: string, text: string, at: number, details?: unknown) =>
		createCustomMessage(kind, text, false, details, new Date(at).toISOString());

	it("never packs a cumulative record, however many later records of the kind exist", () => {
		const messages: AgentMessage[] = [
			record("path_alias_legend", long("legend delta 1"), 1, { cumulative: true }),
			readCall(1, "a.ts"),
			readResult(1),
			record("path_alias_legend", long("legend delta 2"), 2, { cumulative: true }),
			record("active_goal_context", long("goal v1"), 3),
			record("active_goal_context", long("goal v2"), 4),
		];
		const result = applyContextGc(messages, { ...settings, tools: [] });
		expect(result.report.records.map((entry) => entry.messageIndex)).toEqual([4]);
		expect(result.messages[0]).toBe(messages[0]);
		expect(result.messages[3]).toBe(messages[3]);
	});

	it("projects superseded host records to one line for the summarizer without touching anything else", () => {
		const messages: AgentMessage[] = [
			record("active_goal_context", long("goal v1"), 1),
			readCall(1, "a.ts"),
			readResult(1),
			record("path_alias_legend", long("legend delta 1"), 2, { cumulative: true }),
			record("active_goal_context", long("goal v2"), 3),
		];
		const packed = packSupersededHostRecords(messages);
		expect((packed[0] as { content: string }).content).toBe(
			"[Context GC packed superseded active_goal_context record; a later record of this kind is current]",
		);
		expect(packed[1]).toBe(messages[1]);
		expect(packed[2]).toBe(messages[2]);
		expect(packed[3]).toBe(messages[3]);
		expect(packed[4]).toBe(messages[4]);
		// Pure: the input is untouched.
		expect((messages[0] as { content: string }).content).toContain("goal v1");
	});
});
