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

describe("context GC reference protection (ledger #144)", () => {
	function packedIds(result: ReturnType<typeof applyContextGc>): string[] {
		return result.report.records.map((record) => record.toolCallId);
	}

	it("keeps a shell result whose command is cited by recent assistant text while packing its unreferenced sibling", () => {
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

		expect(packedIds(result)).toEqual(["bash-uncited"]);
		expect(result.messages[1]).toBe(messages[1]);
		expect(JSON.stringify(result.messages[3])).toContain("Context GC packed stale tool result");
	});

	it("keeps a path-scoped result whose file name is cited by recent assistant text while packing an unreferenced sibling", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("rg-cited", "rg", { pattern: "breaking", path: "docs/CHANGELOG.md" }),
			toolResult("rg-cited", "rg", bulky("CITED RG")),
			assistantToolCall("rg-uncited", "rg", { pattern: "notes", path: "src/other-notes.txt" }),
			toolResult("rg-uncited", "rg", bulky("UNCITED RG")),
			assistantText("Per CHANGELOG.md the breaking change shipped in the previous minor version."),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			writePayloads: false,
		});

		expect(packedIds(result)).toEqual(["rg-uncited"]);
		expect(result.messages[1]).toBe(messages[1]);
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

	it("keeps a python code result whose code is cited by recent assistant text while packing an uncited sibling", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("py-cited", "python", {
				code: "manifest = load_manifest()\nprint(manifest.total_bytes)",
			}),
			toolResult("py-cited", "python", bulky("CITED PYTHON")),
			assistantToolCall("py-uncited", "python", { code: "cache.purge()\nprint(cache.stats())" }),
			toolResult("py-uncited", "python", bulky("UNCITED PYTHON")),
			assistantText("The manifest totals confirm the size regression."),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			writePayloads: false,
		});

		expect(packedIds(result)).toEqual(["py-uncited"]);
		expect(result.messages[1]).toBe(messages[1]);
	});

	it("keeps a python script result whose scriptPath is cited by recent assistant text while packing an uncited sibling", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("script-cited", "python", { scriptPath: "tools/build_report.py" }),
			toolResult("script-cited", "python", bulky("CITED SCRIPT")),
			assistantToolCall("script-uncited", "python", { scriptPath: "tools/cleanup_cache.py" }),
			toolResult("script-uncited", "python", bulky("UNCITED SCRIPT")),
			assistantText("Per build_report.py the nightly job regressed."),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			writePayloads: false,
		});

		expect(packedIds(result)).toEqual(["script-uncited"]);
		expect(result.messages[1]).toBe(messages[1]);
	});

	it("keeps a run_process result whose argv is cited by recent assistant text while packing an uncited sibling", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("proc-cited", "run_process", {
				executable: "cargo",
				args: ["build", "--release", "--target-dir", "out/release-build"],
			}),
			toolResult("proc-cited", "run_process", bulky("CITED PROCESS")),
			assistantToolCall("proc-uncited", "run_process", { executable: "7zip", args: ["a", "backup.zip"] }),
			toolResult("proc-uncited", "run_process", bulky("UNCITED PROCESS")),
			assistantText("The cargo build output pins the failure to the linker step."),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			tools: ["run_process"],
			writePayloads: false,
		});

		expect(packedIds(result)).toEqual(["proc-uncited"]);
		expect(result.messages[1]).toBe(messages[1]);
	});

	it("stops protecting once the citation falls outside the last 8 assistant messages", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("bash-once-cited", "bash", { command: "git log --oneline -30" }),
			toolResult("bash-once-cited", "bash", bulky("ONCE CITED BASH")),
			assistantText("The git log output shows the regression landed two releases ago."),
			...Array.from({ length: 8 }, (_, index) => assistantText(`unrelated follow-up note ${index}`)),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			writePayloads: false,
		});

		expect(packedIds(result)).toEqual(["bash-once-cited"]);
	});
});
