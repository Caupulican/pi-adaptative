import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/session/session-manager.ts";

describe("SessionManager.createBranchedSessionManager", () => {
	const cleanups: string[] = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			const path = cleanups.pop();
			if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
		}
	});

	it("prepares an in-memory branch without mutating the source manager", () => {
		const source = SessionManager.inMemory("/repo");
		const first = source.appendMessage({ role: "user", content: "first", timestamp: 1 });
		source.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const sourceSessionId = source.getSessionId();
		const sourceLeafId = source.getLeafId();

		const branched = source.createBranchedSessionManager(first);

		expect(source.getSessionId()).toBe(sourceSessionId);
		expect(source.getLeafId()).toBe(sourceLeafId);
		expect(source.getEntries()).toHaveLength(2);
		expect(branched.getSessionId()).not.toBe(sourceSessionId);
		expect(branched.getLeafId()).toBe(first);
		expect(branched.getEntries()).toHaveLength(1);
	});

	it("writes a persisted branch copy while leaving the source file active", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-branched-session-manager-"));
		cleanups.push(root);
		const source = SessionManager.create(root, root, join(root, "sessions"));
		const first = source.appendMessage({ role: "user", content: "first", timestamp: 1 });
		source.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			api: "faux",
			provider: "faux",
			model: "faux",
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
		});
		const sourceFile = source.getSessionFile();
		const sourceSessionId = source.getSessionId();

		const branched = source.createBranchedSessionManager(first);

		expect(source.getSessionId()).toBe(sourceSessionId);
		expect(source.getSessionFile()).toBe(sourceFile);
		expect(branched.getSessionFile()).not.toBe(sourceFile);
		expect(branched.getEntries()).toHaveLength(1);
	});
});

describe("SessionManager batch id minting", () => {
	it("mints unique, chained ids for a tool-start batch and a message batch without copying the persisted id set", () => {
		const manager = SessionManager.inMemory("/repo");
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "start" }], timestamp: 1 });
		const assistantId = manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
				{ type: "toolCall", id: "call-2", name: "edit", arguments: { path: "b.txt" } },
				{ type: "toolCall", id: "call-3", name: "bash", arguments: { command: "true" } },
			],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		});
		const startIds = manager.appendForegroundToolStarts([
			{ requestId: "req-1", assistantMessageEntryId: assistantId, callId: "call-1", toolName: "read" },
			{ requestId: "req-1", assistantMessageEntryId: assistantId, callId: "call-2", toolName: "edit" },
		]);
		expect(new Set(startIds).size).toBe(2);
		const entries = manager.getEntries();
		const starts = entries.filter((entry) => entry.type === "foreground_tool_start");
		expect(starts.map((entry) => entry.id)).toEqual(startIds);
		expect(starts[0]?.parentId).toBe(assistantId);
		expect(starts[1]?.parentId).toBe(startIds[0]);
		expect(manager.appendForegroundToolStart("req-1", assistantId, "call-3", "bash")).not.toBe(startIds[1]);

		const batchIds = manager.appendMessageBatch([
			{ kind: "message", message: { role: "user", content: [{ type: "text", text: "batched" }], timestamp: 2 } },
			{
				kind: "custom",
				message: { role: "custom", customType: "note", content: "batched note", display: false, timestamp: 3 },
			},
		]);
		expect(new Set(batchIds).size).toBe(2);
		const allIds = manager.getEntries().map((entry) => entry.id);
		expect(new Set(allIds).size).toBe(allIds.length);
	});
});
