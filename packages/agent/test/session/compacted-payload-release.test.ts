import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/session/session-manager.ts";

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function toolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

describe("SessionManager compacted payload release", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("moves compacted large message content behind an exact disk-backed getter", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-compacted-payload-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir, dir);
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(assistantMessage());
		const payload = `large-prefix-${"x".repeat(32 * 1024)}-large-tail`;
		const toolResultId = session.appendMessage(toolResultMessage(payload));
		const keptId = session.appendMessage({ role: "user", content: "keep", timestamp: 4 });

		session.appendCompaction("summary", keptId, 10_000);

		const entry = session.getEntry(toolResultId);
		expect(entry?.type).toBe("message");
		if (!entry || entry.type !== "message") return;
		const descriptor = Object.getOwnPropertyDescriptor(entry.message, "content");
		expect(descriptor?.get).toBeTypeOf("function");
		expect((entry.message as ToolResultMessage).content).toEqual([{ type: "text", text: payload }]);
		expect(JSON.stringify(entry)).toContain("large-tail");
		expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeTypeOf("function");

		const branchFile = session.createBranchedSession(keptId);
		expect(branchFile).toBeTypeOf("string");
		const branchedEntry = session.getEntry(toolResultId);
		expect(branchedEntry?.type).toBe("message");
		if (branchedEntry?.type === "message") {
			expect((branchedEntry.message as ToolResultMessage).content).toEqual([{ type: "text", text: payload }]);
		}
	});

	it("restores disk-backed payloads when reopening a compacted session", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-compacted-payload-reopen-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir, dir);
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(assistantMessage());
		const payload = `large-prefix-${"x".repeat(32 * 1024)}-large-tail`;
		const toolResultId = session.appendMessage(toolResultMessage(payload));
		const keptId = session.appendMessage({ role: "user", content: "keep", timestamp: 4 });
		session.appendCompaction("summary", keptId, 10_000);
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeTypeOf("string");
		if (!sessionFile) return;

		const reopened = SessionManager.open(sessionFile, dir, dir);
		const entry = reopened.getEntry(toolResultId);
		expect(entry?.type).toBe("message");
		if (!entry || entry.type !== "message") return;
		expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeTypeOf("function");
		expect((entry.message as ToolResultMessage).content).toEqual([{ type: "text", text: payload }]);
	});

	it("keeps in-memory sessions self-contained", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(assistantMessage());
		const toolResultId = session.appendMessage(toolResultMessage("x".repeat(32 * 1024)));
		const keptId = session.appendMessage({ role: "user", content: "keep", timestamp: 4 });

		session.appendCompaction("summary", keptId, 10_000);

		const entry = session.getEntry(toolResultId);
		expect(entry?.type).toBe("message");
		if (!entry || entry.type !== "message") return;
		expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeUndefined();
	});
});
