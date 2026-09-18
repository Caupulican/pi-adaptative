import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
	it.each([false, true])("does not publish a summary cancelled during encoding: flushed=%s", (flushed) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-summary-cancel-encoding-"));
		try {
			const session = SessionManager.create(dir, dir, dir);
			const rootId = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
			if (flushed) session.appendMessage(assistantMessage());
			const leaf = session.getLeafId();
			const count = session.getEntryCount();
			const context = session.buildSessionContext();
			const file = session.getSessionFile();
			if (!file) throw new Error("Expected a session file path");
			const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
			const controller = new AbortController();
			const reason = new Error("Summary superseded while encoding");
			const details = {
				get value() {
					controller.abort(reason);
					return "metadata";
				},
			};
			let failure: unknown;
			try {
				session.branchWithSummary(rootId, "discarded summary", details, true, undefined, controller.signal);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBe(reason);
			expect(session.getLeafId()).toBe(leaf);
			expect(session.getEntryCount()).toBe(count);
			expect(session.buildSessionContext()).toEqual(context);
			expect(existsSync(file) ? readFileSync(file, "utf8") : undefined).toBe(before);
			const summaryId = session.branchWithSummary(rootId, "accepted summary");
			expect(session.getLeafId()).toBe(summaryId);
			session.appendMessage(assistantMessage("after cancellation"));
			expect(readFileSync(file, "utf8")).toContain("accepted summary");
			expect(readFileSync(file, "utf8")).not.toContain("discarded summary");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects an already-cancelled in-memory summary before publishing", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const controller = new AbortController();
		const reason = new Error("Already superseded");
		controller.abort(reason);
		expect(() => session.branchWithSummary(null, "discarded", undefined, true, undefined, controller.signal)).toThrow(
			reason,
		);
		expect(session.getLeafId()).toBe(rootId);
		expect(session.getEntryCount()).toBe(1);
		expect(session.branchWithSummary(null, "accepted")).toBe(session.getLeafId());
	});

	it("does not create a file or fence recovery when buffered prefix serialization fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-prefix-encoding-failure-"));
		try {
			const session = SessionManager.create(dir, dir, dir);
			let failSerialization = false;
			const rootId = session.appendMessage({
				role: "user",
				get content() {
					if (failSerialization) throw new Error("Buffered prefix cannot serialize");
					return "start";
				},
				timestamp: 1,
			});
			const file = session.getSessionFile();
			if (!file) throw new Error("Expected a session file path");
			failSerialization = true;
			expect(() => session.appendMessage(assistantMessage())).toThrow("Buffered prefix cannot serialize");
			expect(existsSync(file)).toBe(false);
			expect(session.getLeafId()).toBe(rootId);
			expect(session.getEntryCount()).toBe(1);
			failSerialization = false;
			session.appendMessage(assistantMessage("recovered"));
			expect(session.getEntryCount()).toBe(2);
			expect(readFileSync(file, "utf8")).toContain("recovered");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([false, true])("keeps the active branch when a summary write fails: root target=%s", (rootTarget) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-summary-write-failure-"));
		try {
			const session = SessionManager.create(dir, dir, dir);
			const rootId = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
			session.appendMessage(assistantMessage());
			const before = session.buildSessionContext();
			const leaf = session.getLeafId();
			const entries = session.getEntries();
			const file = session.getSessionFile();
			if (!file) throw new Error("Expected a persisted session file.");
			const backup = `${file}.backup`;
			renameSync(file, backup);
			mkdirSync(file);

			expect(() => session.branchWithSummary(rootTarget ? null : rootId, "discarded summary")).toThrow();
			expect(session.getLeafId()).toBe(leaf);
			expect(session.getEntries()).toEqual(entries);
			expect(session.buildSessionContext()).toEqual(before);
			rmSync(file, { recursive: true });
			renameSync(backup, file);
			expect(() => session.branchWithSummary(rootTarget ? null : rootId, "still fenced")).toThrow(
				/uncertain.*reopen/i,
			);
			expect(session.getLeafId()).toBe(leaf);

			session.setSessionFile(file);
			const summaryId = session.branchWithSummary(rootTarget ? null : rootId, "accepted summary");
			expect(session.getLeafId()).toBe(summaryId);
			expect(session.getEntry(summaryId)).toMatchObject({
				type: "branch_summary",
				parentId: rootTarget ? null : rootId,
				summary: "accepted summary",
			});
			expect(session.buildSessionContext().messages).toHaveLength(rootTarget ? 1 : 2);
			expect(session.getEntryCount()).toBe(entries.length + 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the active branch on summary serialization failure without fencing a later valid append", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-summary-encoding-failure-"));
		try {
			const session = SessionManager.create(dir, dir, dir);
			const rootId = session.appendMessage({ role: "user", content: "start", timestamp: 1 });
			session.appendMessage(assistantMessage());
			const before = session.buildSessionContext();
			const leaf = session.getLeafId();
			const count = session.getEntryCount();
			const details = {
				get value(): never {
					throw new Error("summary cannot serialize");
				},
			};
			expect(() => session.branchWithSummary(rootId, "discarded summary", details)).toThrow(
				"summary cannot serialize",
			);
			expect(session.getLeafId()).toBe(leaf);
			expect(session.getEntryCount()).toBe(count);
			expect(session.buildSessionContext()).toEqual(before);
			const summaryId = session.branchWithSummary(rootId, "accepted summary");
			expect(session.getLeafId()).toBe(summaryId);
			expect(session.getEntryCount()).toBe(count + 1);
			expect(session.getEntry(summaryId)?.parentId).toBe(rootId);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

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
