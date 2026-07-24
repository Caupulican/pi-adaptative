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
