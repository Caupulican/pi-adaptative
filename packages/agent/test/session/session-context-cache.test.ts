import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, UserMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSessionContext as buildUncachedSessionContext,
	CURRENT_SESSION_VERSION,
	SessionManager,
} from "../../src/session/session-manager.ts";

function assistantMessage(text: string, provider = "anthropic", model = "test-model"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider,
		model,
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

function countedUserMessage(text: string, onRoleRead: () => void): UserMessage {
	const message: UserMessage = { role: "user", content: text, timestamp: 1 };
	Object.defineProperty(message, "role", {
		configurable: true,
		enumerable: true,
		get: () => {
			onRoleRead();
			return "user";
		},
	});
	return message;
}

function userText(message: ReturnType<SessionManager["buildSessionContext"]>["messages"][number]): string {
	if (message.role !== "user" || typeof message.content !== "string") {
		throw new TypeError("Expected a textual user message.");
	}
	return message.content;
}

describe("SessionManager context cache", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("advances linear messages and settings without revisiting the settled prefix", () => {
		const session = SessionManager.inMemory("/repo");
		let prefixRoleReads = 0;
		for (let index = 0; index < 256; index++) {
			session.appendMessage(
				countedUserMessage(`prefix-${index}`, () => {
					prefixRoleReads += 1;
				}),
			);
		}
		session.appendMessage(assistantMessage("prefix assistant"));

		const initial = session.buildSessionContext();
		expect(initial.messages).toHaveLength(257);
		expect(prefixRoleReads).toBe(256);
		prefixRoleReads = 0;

		initial.messages.length = 0;
		if (!initial.model) throw new Error("Expected an assistant-derived model projection.");
		initial.model.provider = "mutated-by-caller";
		const defensive = session.buildSessionContext();
		expect(defensive.messages).toHaveLength(257);
		expect(defensive.model).toEqual({ provider: "anthropic", modelId: "test-model" });

		session.appendMessage({ role: "user", content: "next user", timestamp: 3 });
		session.appendThinkingLevelChange("high");
		session.appendModelChange("openai", "gpt-cache");
		let advanced = session.buildSessionContext();
		expect(advanced.messages).toHaveLength(258);
		expect(advanced.thinkingLevel).toBe("high");
		expect(advanced.model).toEqual({ provider: "openai", modelId: "gpt-cache" });

		session.appendMessage(assistantMessage("next assistant", "google", "gemini-cache"));
		advanced = session.buildSessionContext();
		expect(advanced.messages).toHaveLength(259);
		expect(advanced.model).toEqual({ provider: "google", modelId: "gemini-cache" });
		expect(prefixRoleReads).toBe(0);
	});

	it("rebuilds once after compaction and never revisits compacted-away entries on later appends", () => {
		const session = SessionManager.inMemory("/repo");
		let compactedRoleReads = 0;
		for (let index = 0; index < 2_044; index++) {
			session.appendMessage(
				countedUserMessage(`compacted-${index}`, () => {
					compactedRoleReads += 1;
				}),
			);
		}
		const keptIds: string[] = [];
		for (let index = 0; index < 4; index++) {
			keptIds.push(session.appendMessage({ role: "user", content: `kept-${index}`, timestamp: index + 2 }));
		}
		session.appendCompaction("bounded summary", keptIds[0]!, 100_000);

		compactedRoleReads = 0;
		const rebuilt = session.buildSessionContext();
		expect(rebuilt.messages).toHaveLength(5);
		expect(compactedRoleReads).toBe(2_044);
		compactedRoleReads = 0;

		for (let index = 0; index < 32; index++) {
			session.appendMessage({ role: "user", content: `later-${index}`, timestamp: index + 10 });
			expect(session.buildSessionContext().messages).toHaveLength(6 + index);
		}
		expect(compactedRoleReads).toBe(0);
	});

	it("invalidates a cached projection on branch, reset, and new session transitions", () => {
		const session = SessionManager.inMemory("/repo");
		let roleReads = 0;
		const countRoleRead = () => {
			roleReads += 1;
		};
		const rootId = session.appendMessage(countedUserMessage("root", countRoleRead));
		const mainId = session.appendMessage(countedUserMessage("main", countRoleRead));
		expect(session.buildSessionContext().messages).toHaveLength(2);

		roleReads = 0;
		session.branch(mainId);
		expect(session.buildSessionContext().messages).toHaveLength(2);
		expect(roleReads).toBe(2);

		session.branch(rootId);
		session.appendMessage({ role: "user", content: "branch", timestamp: 3 });
		expect(session.buildSessionContext().messages.map(userText)).toEqual(["root", "branch"]);

		session.resetLeaf();
		session.appendMessage({ role: "user", content: "new root", timestamp: 4 });
		expect(session.buildSessionContext().messages.map(userText)).toEqual(["new root"]);

		session.newSession();
		session.appendMessage({ role: "user", content: "new session", timestamp: 5 });
		expect(session.buildSessionContext().messages.map(userText)).toEqual(["new session"]);
	});

	it("invalidates a cached projection when the manager reopens a file with the same leaf id", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-context-cache-"));
		tempDirs.push(dir);
		const firstFile = join(dir, "first.jsonl");
		const secondFile = join(dir, "second.jsonl");
		const header = (id: string) => ({
			type: "session" as const,
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		});
		const entry = (content: string) => ({
			type: "message" as const,
			id: "shared-leaf",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user" as const, content, timestamp: 1 },
		});
		writeFileSync(firstFile, `${JSON.stringify(header("first"))}\n${JSON.stringify(entry("first"))}\n`);
		writeFileSync(secondFile, `${JSON.stringify(header("second"))}\n${JSON.stringify(entry("second"))}\n`);

		const session = SessionManager.open(firstFile, dir, dir);
		expect(session.buildSessionContext().messages.map(userText)).toEqual(["first"]);
		session.setSessionFile(secondFile);
		expect(session.buildSessionContext().messages.map(userText)).toEqual(["second"]);
	});

	it("isolates synthesized cached messages from caller mutation", () => {
		const session = SessionManager.inMemory("/repo");
		const keptId = session.appendMessage({ role: "user", content: "keep", timestamp: 1 });
		session.appendCompaction("canonical summary", keptId, 100);

		const first = session.buildSessionContext();
		const summary = first.messages.find((message) => message.role === "compactionSummary");
		if (!summary || summary.role !== "compactionSummary") throw new Error("Expected compaction summary.");
		summary.summary = "caller mutation";

		expect(
			session.buildSessionContext().messages.find((message) => message.role === "compactionSummary"),
		).toMatchObject({
			summary: "canonical summary",
		});

		session.appendCustomMessageEntry("canonical custom", "notice", false);
		const custom = session.buildSessionContext().messages.find((message) => message.role === "custom");
		if (!custom || custom.role !== "custom") throw new Error("Expected custom message.");
		custom.customType = "caller mutation";
		expect(session.buildSessionContext().messages.find((message) => message.role === "custom")).toMatchObject({
			customType: "canonical custom",
		});

		session.branchWithSummary(session.getLeafId(), "canonical branch summary");
		const branchSummary = session.buildSessionContext().messages.find((message) => message.role === "branchSummary");
		if (!branchSummary || branchSummary.role !== "branchSummary") throw new Error("Expected branch summary.");
		branchSummary.summary = "caller mutation";
		expect(session.buildSessionContext().messages.find((message) => message.role === "branchSummary")).toMatchObject({
			summary: "canonical branch summary",
		});
	});

	it("matches an uncached projection after every appendable entry variant", () => {
		const session = SessionManager.inMemory("/repo");
		const assertMatchesUncachedProjection = () => {
			const entries = session.getEntries();
			const byId = new Map(entries.map((entry) => [entry.id, entry]));
			expect(session.buildSessionContext()).toEqual(buildUncachedSessionContext(entries, session.getLeafId(), byId));
		};

		const rootId = session.appendMessage({ role: "user", content: "root", timestamp: 1 });
		assertMatchesUncachedProjection();
		session.appendMessage(assistantMessage("assistant"));
		assertMatchesUncachedProjection();
		session.appendThinkingLevelChange("medium");
		assertMatchesUncachedProjection();
		session.appendModelChange("openai", "gpt-test");
		assertMatchesUncachedProjection();
		session.appendCustomEntry("state", { value: 1 });
		assertMatchesUncachedProjection();
		session.appendSessionInfo("named session");
		assertMatchesUncachedProjection();
		session.appendCustomMessageEntry("notice", "custom content", false, { value: 2 });
		assertMatchesUncachedProjection();
		session.appendLabelChange(rootId, "root label");
		assertMatchesUncachedProjection();
		session.branchWithSummary(session.getLeafId(), "branch summary");
		assertMatchesUncachedProjection();
		session.appendCompaction("compaction summary", rootId, 1_000);
		assertMatchesUncachedProjection();
	});
});
