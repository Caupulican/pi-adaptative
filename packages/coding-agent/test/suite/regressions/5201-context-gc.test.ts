import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../../src/core/compaction/compaction.ts";
import { applyContextGc } from "../../../src/core/context-gc.ts";
import { createCoreDiagnosticsToolDefinitions } from "../../../src/core/extensions/builtin.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function customMemory(text: string): AgentMessage {
	return {
		role: "custom",
		customType: "automata-session-context",
		content: [{ type: "text", text }],
		display: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

function textOf(message: AgentMessage): string {
	if (message.role !== "toolResult" && message.role !== "user" && message.role !== "custom") return "";
	if (typeof message.content === "string") return message.content;
	const first = message.content[0];
	if (typeof first !== "string" && first?.type === "text") return first.text;
	return "";
}

function large(label: string): string {
	return `${label}\n${"0123456789abcdef".repeat(220)}`;
}

describe("Context GC", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("packs older same-file read snapshots while preserving the latest read", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("read-old", "read", { path: "src/file.ts" }),
			toolResult("read-old", "read", large("OLD SNAPSHOT")),
			user("continue"),
			assistantToolCall("read-new", "read", { path: "src/file.ts" }),
			toolResult("read-new", "read", large("NEW SNAPSHOT")),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			writePayloads: false,
		});

		expect(result.report.packedCount).toBe(1);
		expect(textOf(result.messages[1])).toContain("Context GC packed stale tool result");
		expect(textOf(result.messages[1])).toContain("older read snapshot superseded");
		expect(textOf(result.messages[4])).toContain("NEW SNAPSHOT");
		expect(textOf(result.messages[4])).not.toContain("Context GC packed");
	});

	it("preserves the latest read snapshot even when it is old", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("read-only", "read", { path: "src/file.ts" }),
			toolResult("read-only", "read", large("LATEST ONLY SNAPSHOT")),
			...Array.from({ length: 20 }, (_, index) => user(`noise ${index}`)),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			writePayloads: false,
		});

		expect(result.report.packedCount).toBe(0);
		expect(textOf(result.messages[1])).toContain("LATEST ONLY SNAPSHOT");
	});

	it("packs stale bulky bash and rg tool results outside the recent window", () => {
		const messages: AgentMessage[] = [
			assistantToolCall("bash-old", "bash", { command: "npm test" }),
			toolResult("bash-old", "bash", large("OLD BASH")),
			assistantToolCall("rg-old", "rg", { pattern: "foo", path: "src" }),
			toolResult("rg-old", "rg", large("OLD RG")),
			user("recent user"),
			assistantToolCall("bash-new", "bash", { command: "git status" }),
			toolResult("bash-new", "bash", large("RECENT BASH")),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 2,
			minToolResultChars: 20,
			writePayloads: false,
		});

		expect(result.report.records.map((record) => record.toolName)).toEqual(["bash", "rg"]);
		expect(textOf(result.messages[1])).toContain("Context GC packed stale tool result");
		expect(textOf(result.messages[3])).toContain("Context GC packed stale tool result");
		expect(textOf(result.messages[6])).toContain("RECENT BASH");
		expect(textOf(result.messages[6])).not.toContain("Context GC packed");
	});

	it("writes exact old payloads outside the session context without mutating the original messages", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-context-gc-test-"));
		tempDirs.push(dir);
		const original = large("OLD BASH PAYLOAD");
		const messages: AgentMessage[] = [
			assistantToolCall("bash-old", "bash", { command: "npm test" }),
			toolResult("bash-old", "bash", original),
			user("later"),
		];
		const beforeTokens = estimateTokens(messages[1]);

		const result = applyContextGc(messages, {
			cwd: "/repo",
			storageDir: dir,
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			writePayloads: true,
		});

		const storagePath = result.report.records[0]?.storagePath;
		expect(storagePath).toBeDefined();
		expect(existsSync(storagePath!)).toBe(true);
		expect(readFileSync(storagePath!, "utf8")).toBe(original);
		expect(textOf(messages[1])).toBe(original);
		expect(textOf(result.messages[1])).toContain(storagePath!);
		expect(result.report.originalTokens).toBe(beforeTokens);
		expect(result.report.savedTokens).toBeGreaterThan(0);
	});

	it("packs stale Automata semantic memory pages while preserving recent pages", () => {
		const page = (label: string) =>
			`<automata_response format="automata-context-v1" kind="query_page"><page_metadata><query>${label}</query></page_metadata><results_grouped_by_topic>${"memory ".repeat(320)}</results_grouped_by_topic></automata_response>`;
		const messages: AgentMessage[] = [
			customMemory(page("old")),
			user(`${page("user prompt marker")} keep my real prompt intact`),
			...Array.from({ length: 4 }, (_, index) => user(`noise ${index}`)),
			customMemory(page("recent")),
		];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 20,
			semanticMemory: { preserveRecentPages: 1, minChars: 20 },
			writePayloads: false,
		});

		expect(result.report.records.map((record) => record.reason)).toEqual(["stale-semantic-memory"]);
		expect(textOf(result.messages[0])).toContain("Semantic GC packed stale Automata/Mind context page");
		expect(textOf(result.messages[1])).toContain("keep my real prompt intact");
		expect(textOf(result.messages[6])).toContain("<automata_response");
		expect(textOf(result.messages[6])).not.toContain("Semantic GC packed");
	});

	it("reports Context GC savings from context_audit", async () => {
		const messages: AgentMessage[] = [
			assistantToolCall("bash-old", "bash", { command: "npm test" }),
			toolResult("bash-old", "bash", large("OLD BASH AUDIT")),
			user("later"),
		];
		const entries: SessionEntry[] = messages.map((message, index) => ({
			type: "message",
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: new Date().toISOString(),
			message,
		}));
		const [definition] = createCoreDiagnosticsToolDefinitions(
			() => ["context_audit"],
			() => [
				{
					name: "context_audit",
					description: "audit",
					parameters: {},
					sourceInfo: createSyntheticSourceInfo("<test>", { source: "builtin" }),
				},
			],
			(activeMessages) =>
				applyContextGc(activeMessages, {
					cwd: "/repo",
					preserveRecentMessages: 0,
					minToolResultChars: 20,
					writePayloads: false,
				}).report,
		);

		const result = await definition.execute("audit-call", { maxItems: 5 }, new AbortController().signal, () => {}, {
			sessionManager: { getBranch: () => entries },
			getContextUsage: () => undefined,
			getSystemPrompt: () => "",
		} as never);

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Context GC estimate:");
		expect(text).toContain("tokens saved");
	});
});
