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
		if (entry?.type !== "message") return;
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
		if (entry?.type !== "message") return;
		expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeTypeOf("function");
		expect((entry.message as ToolResultMessage).content).toEqual([{ type: "text", text: payload }]);

		const liveContext = reopened.buildSessionContext();
		expect(liveContext.messages.map((message) => message.role)).toEqual(["compactionSummary", "user"]);
		expect(JSON.stringify(liveContext.messages)).not.toContain("large-prefix");
		expect(JSON.stringify(liveContext.messages)).not.toContain("large-tail");
	});

	it("keeps repeated compaction and reopen cycles free of stale large payloads", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-compacted-payload-soak-"));
		tempDirs.push(dir);
		let session = SessionManager.create(dir, dir, dir);
		const compactedEntryIds: string[] = [];
		const payloadMarkers: string[] = [];

		for (let cycle = 0; cycle < 12; cycle++) {
			session.appendMessage({ role: "user", content: `cycle-${cycle}-start`, timestamp: cycle * 10 + 1 });
			session.appendMessage(assistantMessage());
			const marker = `payload-cycle-${cycle}`;
			payloadMarkers.push(marker);
			compactedEntryIds.push(
				session.appendMessage(toolResultMessage(`${marker}-prefix-${"x".repeat(32 * 1024)}-${marker}-tail`)),
			);
			const keptId = session.appendMessage({
				role: "user",
				content: `cycle-${cycle}-keep`,
				timestamp: cycle * 10 + 4,
			});
			session.appendCompaction(`summary-cycle-${cycle}`, keptId, 10_000 + cycle);

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeTypeOf("string");
			if (!sessionFile) throw new Error("Expected persisted soak session");
			session = SessionManager.open(sessionFile, dir, dir);

			const liveContext = session.buildSessionContext();
			expect(liveContext.messages.map((message) => message.role)).toEqual(["compactionSummary", "user"]);
			const serializedContext = JSON.stringify(liveContext.messages);
			expect(serializedContext).toContain(`summary-cycle-${cycle}`);
			for (const oldMarker of payloadMarkers) expect(serializedContext).not.toContain(oldMarker);
			for (const entryId of compactedEntryIds) {
				const entry = session.getEntry(entryId);
				expect(entry?.type).toBe("message");
				if (entry?.type === "message") {
					expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeTypeOf("function");
				}
			}
		}
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
		if (entry?.type !== "message") return;
		expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeUndefined();
	});

	it("releases the discarded middle while retaining sparse original and post-compaction messages", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-replacement-payload-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir, dir);
		const originalId = session.appendMessage({ role: "user", content: "original request", timestamp: 1 });
		session.appendMessage(assistantMessage());
		const discardedPayload = `discarded-prefix-${"x".repeat(32 * 1024)}-discarded-tail`;
		const discardedId = session.appendMessage(toolResultMessage(discardedPayload));
		session.appendCompaction("replacement summary", originalId, 400_000, undefined, false, undefined, {
			mode: "original-user",
			userEntryId: originalId,
		});
		const postPayload = `post-prefix-${"y".repeat(32 * 1024)}-post-tail`;
		const postId = session.appendMessage({ role: "user", content: postPayload, timestamp: 4 });
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session replacement fixture");

		const reopened = SessionManager.open(sessionFile, dir, dir);
		const original = reopened.getEntry(originalId);
		const discarded = reopened.getEntry(discardedId);
		const post = reopened.getEntry(postId);
		expect(original?.type).toBe("message");
		expect(discarded?.type).toBe("message");
		expect(post?.type).toBe("message");
		if (original?.type !== "message" || discarded?.type !== "message" || post?.type !== "message") return;
		expect(Object.getOwnPropertyDescriptor(original.message, "content")?.get).toBeUndefined();
		expect(Object.getOwnPropertyDescriptor(discarded.message, "content")?.get).toBeTypeOf("function");
		expect(Object.getOwnPropertyDescriptor(post.message, "content")?.get).toBeTypeOf("function");
		if (post.message.role !== "user") throw new Error("Expected retained post-compaction user message");
		expect(post.message.content).toBe(postPayload);
		const liveContext = reopened.buildSessionContext();
		expect(liveContext.messages.map((message) => message.role)).toEqual(["user", "compactionSummary", "user"]);
		expect(JSON.stringify(liveContext.messages)).toContain("post-tail");
		expect(JSON.stringify(liveContext.messages)).not.toContain("discarded-tail");
	});
});
