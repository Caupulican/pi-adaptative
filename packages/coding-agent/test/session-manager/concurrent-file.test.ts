import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

function userMessage(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
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
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("two session managers on the same file", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-concurrent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("interleaved appends produce a valid forked tree, not a corrupted file", () => {
		const file = join(tempDir, "shared.jsonl");
		const first = SessionManager.create(tempDir, tempDir);
		first.setSessionFile(file);
		first.appendMessage(userMessage("hello"));
		first.appendMessage(assistantMessage("hi"));

		// Second process resumes the same file mid-conversation.
		const second = SessionManager.open(file, tempDir);

		// Both processes append from the same leaf.
		first.appendMessage(userMessage("from first"));
		second.appendMessage(userMessage("from second"));

		// A fresh load must parse every line and resolve every parent.
		const entries = loadEntriesFromFile(file);
		expect(entries.length).toBe(5); // header + 4 messages
		const ids = new Set(entries.filter((entry) => entry.type !== "session").map((entry) => entry.id));
		for (const entry of entries) {
			if (entry.type === "session") continue;
			if (entry.parentId !== null) {
				expect(ids.has(entry.parentId)).toBe(true);
			}
		}

		// The two concurrent appends become siblings (a fork), both reachable.
		const reopened = SessionManager.open(file, tempDir);
		const context = reopened.buildSessionContext();
		expect(context.messages.length).toBeGreaterThan(0);
	});
});
