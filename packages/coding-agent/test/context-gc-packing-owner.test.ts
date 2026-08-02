import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { applyContextGc } from "../src/core/context-gc.ts";

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
});
