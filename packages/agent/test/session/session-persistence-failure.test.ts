import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
} from "node:fs";
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

describe("SessionManager persistence failures", () => {
	it("rolls back an already-flushed append and fences later writes until reopen", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-persisted-append-failure-"));
		try {
			const session = SessionManager.create(dir, dir, dir);
			const rootId = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
			session.appendMessage(assistantMessage());
			session.appendLabelChange(rootId, "stable");
			expect(session.buildSessionContext().messages).toHaveLength(2);
			const stableLeafId = session.getLeafId();
			const stableEntryCount = session.getEntryCount();
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file.");
			const backupFile = `${sessionFile}.backup`;
			renameSync(sessionFile, backupFile);
			mkdirSync(sessionFile);

			expect(() => session.appendLabelChange(rootId, "phantom")).toThrow();
			expect(session.getLeafId()).toBe(stableLeafId);
			expect(session.getEntryCount()).toBe(stableEntryCount);
			expect(session.getLabel(rootId)).toBe("stable");
			expect(session.buildSessionContext().messages).toHaveLength(2);

			rmSync(sessionFile, { recursive: true });
			renameSync(backupFile, sessionFile);
			expect(() => session.appendMessage({ role: "user", content: "blocked", timestamp: 3 })).toThrow(
				/uncertain.*reopen/i,
			);
			expect(() => session.releasePersistedMessagePayload(rootId)).toThrow(/uncertain.*reopen/i);
			expect(session.getEntryCount()).toBe(stableEntryCount);

			const stableFileBytes = statSync(sessionFile).size;
			appendFileSync(sessionFile, '{"type":"message"');
			expect(() => session.setSessionFile(sessionFile)).toThrow(/incomplete JSONL record/i);
			truncateSync(sessionFile, stableFileBytes);
			session.setSessionFile(sessionFile);
			expect(session.getLabel(rootId)).toBe("stable");
			session.appendMessage({ role: "user", content: "recovered", timestamp: 4 });
			expect(session.buildSessionContext().messages).toHaveLength(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rolls back a failed initial flush and requires explicit recovery", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-initial-flush-failure-"));
		try {
			const session = SessionManager.create(dir, dir, dir);
			const rootId = session.appendMessage({ role: "user", content: "staged", timestamp: 1 });
			expect(session.buildSessionContext().messages).toHaveLength(1);
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected a session file path.");
			mkdirSync(sessionFile);

			expect(() => session.appendMessage(assistantMessage())).toThrow();
			expect(session.getLeafId()).toBe(rootId);
			expect(session.getEntryCount()).toBe(1);
			expect(session.buildSessionContext().messages).toHaveLength(1);

			rmSync(sessionFile, { recursive: true });
			expect(() => session.appendMessage(assistantMessage("blocked"))).toThrow(/uncertain.*reopen/i);
			expect(existsSync(sessionFile)).toBe(false);

			session.setSessionFile(sessionFile);
			expect(session.getEntryCount()).toBe(0);
			session.appendMessage({ role: "user", content: "new root", timestamp: 3 });
			session.appendMessage(assistantMessage("recovered"));
			expect(session.buildSessionContext().messages).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
