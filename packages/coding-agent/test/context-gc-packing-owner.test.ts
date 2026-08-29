import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { applyContextGc, getContextGcSettings } from "../src/core/context-gc.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: 0,
	};
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

function bulky(label: string): string {
	return `${label}\n${"0123456789abcdef".repeat(120)}`;
}

describe("context GC packed-message commit", () => {
	it("commits semantic and tool-result packs through the same accounting contract", () => {
		const semanticText = `<automata_context>${"semantic".repeat(40)}`;
		const toolText = `tool output ${"result".repeat(40)}`;
		const semanticMessage = {
			role: "custom",
			customType: "automata-session-context",
			content: [{ type: "text", text: semanticText }],
			display: false,
			timestamp: 0,
		} as AgentMessage;
		const toolMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "grep-old",
			toolName: "grep",
			content: [{ type: "text", text: toolText }],
			isError: false,
			timestamp: 0,
		};
		const packedEvents: Array<{
			key: string | undefined;
			digest: string | undefined;
			packedTokens: number;
			originalText: string;
		}> = [];

		const result = applyContextGc([semanticMessage, toolMessage], {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			writePayloads: false,
			semanticMemory: { preserveRecentPages: 0, minChars: 20 },
			curation: {
				resolveDigest: (key) => `digest:${key}`,
				onPacked: (record, originalText) => {
					packedEvents.push({
						key: record.key,
						digest: record.digest,
						packedTokens: record.packedTokens,
						originalText,
					});
				},
			},
		});

		expect(result.report.records.map((record) => record.reason)).toEqual([
			"stale-semantic-memory",
			"stale-tool-result",
		]);
		expect(packedEvents).toEqual([
			{
				key: result.report.records[0]?.key,
				digest: `digest:${result.report.records[0]?.key}`,
				packedTokens: 0,
				originalText: semanticText,
			},
			{
				key: result.report.records[1]?.key,
				digest: `digest:${result.report.records[1]?.key}`,
				packedTokens: 0,
				originalText: toolText,
			},
		]);
		expect(result.report.packedCount).toBe(2);
		expect(result.report.originalTokens).toBe(
			result.report.records.reduce((total, record) => total + record.originalTokens, 0),
		);
		expect(result.report.packedTokens).toBe(
			result.report.records.reduce((total, record) => total + record.packedTokens, 0),
		);
		expect(result.report.records.every((record) => record.packedTokens > 0)).toBe(true);
		expect(JSON.stringify(result.messages[0])).toContain(`digest:${result.report.records[0]?.key}`);
		expect(JSON.stringify(result.messages[1])).toContain(`digest:${result.report.records[1]?.key}`);
		expect(JSON.stringify(semanticMessage)).toContain(semanticText);
		expect(JSON.stringify(toolMessage)).toContain(toolText);
	});

	it("defaults preserveRecentMessages to 24 (ledger #144 window raise)", () => {
		expect(getContextGcSettings().preserveRecentMessages).toBe(24);
	});
});

describe("context GC out-of-window packing (ledger #144)", () => {
	function packedIds(result: ReturnType<typeof applyContextGc>): string[] {
		return result.report.records.map((record) => record.toolCallId);
	}

	it("packs out-of-window bulky results even when recent assistant text still cites them", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("bash-cited", "bash", { command: "git log --oneline -30" }),
			toolResult("bash-cited", "bash", bulky("CITED BASH")),
			assistantToolCall("bash-uncited", "bash", { command: "npm run typecheck" }),
			toolResult("bash-uncited", "bash", bulky("UNCITED BASH")),
			assistantText("The git log output shows the regression landed two releases ago."),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			writePayloads: false,
		});

		expect(packedIds(result)).toEqual(["bash-cited", "bash-uncited"]);
		expect(JSON.stringify(result.messages[1])).toContain("Context GC packed stale tool result");
		expect(JSON.stringify(result.messages[3])).toContain("Context GC packed stale tool result");
	});

	it("does not pack bulky results still inside preserveRecentMessages", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("bash-recent", "bash", { command: "git log --oneline -30" }),
			toolResult("bash-recent", "bash", bulky("RECENT BASH")),
			assistantText("The git log output shows the regression landed two releases ago."),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 24,
			minToolResultChars: 20,
			writePayloads: false,
		});

		expect(packedIds(result)).toEqual([]);
		expect(result.messages[1]).toBe(messages[1]);
	});

	it("packs a cited bulky result once it ages past the quantized preserve boundary", () => {
		// The boundary advances on a 12-message grid at this window (context/prefix-stability.ts), so
		// a result ages out at 24 + 12 messages rather than the moment it leaves the raw window.
		const messages: AgentMessage[] = [
			assistantToolCall("bash-cited", "bash", { command: "git log --oneline -30" }),
			toolResult("bash-cited", "bash", bulky("CITED BASH")),
			...Array.from({ length: 34 }, (_, index) => assistantText(`The git log still matters; note ${index}`)),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 24,
			minToolResultChars: 20,
			writePayloads: false,
		});

		expect(packedIds(result)).toEqual(["bash-cited"]);
	});

	it("packs a second-wave bulky result after an earlier pack under the production window", () => {
		const firstMessages: AgentMessage[] = [
			assistantToolCall("bash-first", "bash", { command: "git log --oneline -30" }),
			toolResult("bash-first", "bash", bulky("FIRST WAVE")),
			...Array.from({ length: 34 }, (_, index) => assistantText(`first-wave note ${index}`)),
		];
		const first = applyContextGc(firstMessages, {
			cwd: "/repo",
			preserveRecentMessages: 24,
			minToolResultChars: 20,
			writePayloads: false,
		});
		expect(packedIds(first)).toEqual(["bash-first"]);

		const secondMessages: AgentMessage[] = [
			...first.messages,
			assistantToolCall("bash-second", "bash", { command: "npm run typecheck" }),
			toolResult("bash-second", "bash", bulky("SECOND WAVE")),
			...Array.from({ length: 34 }, (_, index) => assistantText(`second-wave note ${index}`)),
		];
		const second = applyContextGc(secondMessages, {
			cwd: "/repo",
			preserveRecentMessages: 24,
			minToolResultChars: 20,
			writePayloads: false,
		});
		expect(packedIds(second)).toContain("bash-second");
	});

	it("still packs a superseded read regardless of recent references to its file", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("read-old", "read", { path: "docs/CHANGELOG.md" }),
			toolResult("read-old", "read", bulky("OLD SNAPSHOT")),
			assistantToolCall("read-new", "read", { path: "docs/CHANGELOG.md" }),
			toolResult("read-new", "read", bulky("NEW SNAPSHOT")),
			assistantText("Still working through CHANGELOG.md; the old snapshot is outdated."),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			writePayloads: false,
		});

		expect(result.report.records).toHaveLength(1);
		expect(result.report.records[0]).toMatchObject({ toolCallId: "read-old", reason: "superseded-read" });
		expect(result.messages[3]).toBe(messages[3]);
	});
});
