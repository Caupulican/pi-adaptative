import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/session/session-manager.ts";

function assistantMessage(text = "ready"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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

describe("SessionManager unterminated JSONL tail recovery (F2)", () => {
	it("isolates an unterminated trailing partial line on resume and preserves subsequent appends", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-unterminated-tail-"));
		try {
			// 1. Create a valid session and flush it
			const session1 = SessionManager.create(dir, dir, dir);
			session1.appendMessage({ role: "user", content: "first user message", timestamp: 1 });
			session1.appendMessage(assistantMessage("first assistant reply"));
			const sessionFile = session1.getSessionFile();
			if (!sessionFile) throw new Error("Expected session file");

			// 2. Simulate process death mid-write: append a partial record without trailing newline
			const partialLine = '{"type":"message","id":"partial-record","partial":true';
			appendFileSync(sessionFile, partialLine);

			// Verify the file ends without \n
			const rawBeforeResume = readFileSync(sessionFile, "utf8");
			expect(rawBeforeResume.endsWith("\n")).toBe(false);

			// 3. Resume session in a fresh SessionManager instance
			const session2 = SessionManager.open(sessionFile, dir, dir);
			expect(session2.buildSessionContext().messages).toHaveLength(2);

			// 4. Append a new message to the resumed session
			const newId = session2.appendMessage({ role: "user", content: "second user message", timestamp: 3 });
			session2.appendMessage(assistantMessage("second assistant reply"));

			// 5. Read the raw file from disk and verify lines
			const rawAfterAppend = readFileSync(sessionFile, "utf8");
			expect(rawAfterAppend.endsWith("\n")).toBe(true);

			const rawLines = rawAfterAppend.trimEnd().split("\n");
			let partialLineFound = false;
			for (const line of rawLines) {
				try {
					const parsed = JSON.parse(line);
					if (parsed.id === newId) {
						expect(parsed.message.content).toBe("second user message");
					}
				} catch {
					if (line === partialLine) {
						partialLineFound = true;
					} else {
						throw new Error(`Unexpected corrupt line: ${line}`);
					}
				}
			}
			expect(partialLineFound).toBe(true);

			// 6. Resume again to verify round-trip integrity
			const session3 = SessionManager.open(sessionFile, dir, dir);
			const contextMessages = session3.buildSessionContext().messages;
			expect(contextMessages).toHaveLength(4);
			expect((contextMessages[0] as { content: string }).content).toBe("first user message");
			expect((contextMessages[1] as AssistantMessage).content).toEqual([
				{ type: "text", text: "first assistant reply" },
			]);
			expect((contextMessages[2] as { content: string }).content).toBe("second user message");
			expect((contextMessages[3] as AssistantMessage).content).toEqual([
				{ type: "text", text: "second assistant reply" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("negative control: properly terminated file gets no extra newline on resume", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-terminated-tail-"));
		try {
			const session1 = SessionManager.create(dir, dir, dir);
			session1.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			session1.appendMessage(assistantMessage("world"));
			const sessionFile = session1.getSessionFile();
			if (!sessionFile) throw new Error("Expected session file");

			const sizeBefore = statSync(sessionFile).size;
			const contentBefore = readFileSync(sessionFile);

			// Open in a fresh session
			SessionManager.open(sessionFile, dir, dir);
			const sizeAfter = statSync(sessionFile).size;
			const contentAfter = readFileSync(sessionFile);

			expect(sizeAfter).toBe(sizeBefore);
			expect(contentAfter).toEqual(contentBefore);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
