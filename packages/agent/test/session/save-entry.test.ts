import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/session/session-manager.ts";

describe("SessionManager.saveCustomEntry", () => {
	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		// Save a message
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		const customId = session.appendCustomEntry("my_data", { foo: "bar" });

		// Save another message
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
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
		});

		// Custom entry should be in entries
		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("my_data");
		expect(customEntry.data).toEqual({ foo: "bar" });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(2); // only message entries
	});
});

describe("SessionManager.getEntriesSince", () => {
	it("returns only append-ordered entries after the requested index", () => {
		const session = SessionManager.inMemory();
		const first = session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const second = session.appendCustomEntry("metric", { value: 2 });
		const third = session.appendMessage({ role: "user", content: "third", timestamp: 3 });

		expect(session.getEntryCount()).toBe(3);
		expect(session.getEntriesSince(1).map((entry) => entry.id)).toEqual([second, third]);
		expect(session.getEntriesSince(3)).toEqual([]);
		expect(session.getEntriesSince(-1).map((entry) => entry.id)).toEqual([first, second, third]);
	});
});

describe("SessionManager.getRecentUserInputHistory", () => {
	it("returns active-branch user prompts oldest first without assistant messages", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
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
		});
		session.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "second " },
				{ type: "image", data: "aaa", mimeType: "image/png" },
				{ type: "text", text: "prompt" },
			],
			timestamp: 3,
		});

		expect(session.getRecentUserInputHistory()).toEqual(["first", "second prompt"]);
		expect(session.getRecentUserInputHistory(1)).toEqual(["second prompt"]);
	});
});
