import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { applyContextGc, getContextGcSettings } from "../src/core/context-gc.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function delegateResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "delegate",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function messageText(message: AgentMessage): string {
	if (message.role !== "toolResult") return "";
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("delegate context GC", () => {
	it("includes delegate in both built-in context-GC defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-context-gc-delegate-settings-"));
		const agentDir = join(dir, "agent");
		const projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });

		try {
			expect(getContextGcSettings().tools).toContain("delegate");
			expect(SettingsManager.create(projectDir, agentDir).getContextGcSettings().tools).toContain("delegate");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("packs only stale delegate output and preserves its exact retrievable payload", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-context-gc-delegate-"));
		const staleText = `STALE DELEGATE\n${"old worker evidence ".repeat(120)}`;
		const recentText = `RECENT DELEGATE\n${"current worker evidence ".repeat(120)}`;
		const stale = delegateResult("delegate-old", staleText);
		const recent = delegateResult("delegate-recent", recentText);
		const messages: AgentMessage[] = [stale, recent];

		try {
			const result = applyContextGc(messages, {
				...getContextGcSettings(),
				cwd: "/repo",
				storageDir: dir,
				preserveRecentMessages: 1,
				writePayloads: true,
			});

			expect(result.report.records).toHaveLength(1);
			expect(result.report.records[0]).toMatchObject({
				toolName: "delegate",
				toolCallId: "delegate-old",
				reason: "stale-tool-result",
			});
			const storagePath = result.report.records[0]?.storagePath;
			expect(storagePath).toBeDefined();
			expect(existsSync(storagePath!)).toBe(true);
			expect(readFileSync(storagePath!, "utf8")).toBe(staleText);
			expect(messageText(result.messages[0]!)).toContain("Context GC packed stale tool result");
			expect(messageText(result.messages[0]!)).toContain(storagePath!);
			expect(messageText(result.messages[1]!)).toBe(recentText);
			expect(messageText(messages[0]!)).toBe(staleText);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
