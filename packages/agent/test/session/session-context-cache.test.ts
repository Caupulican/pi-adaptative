import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSessionContext as buildUncachedSessionContext,
	CURRENT_SESSION_VERSION,
	SessionManager,
} from "../../src/session/session-manager.ts";
import {
	createVerificationObligationSnapshotDetails,
	VerificationObligationTracker,
} from "../../src/verification-obligations.ts";

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

/**
 * Appends a user message and records every later projection that visits its stored entry (by reading the
 * entry's `type`, which any full rebuild must), so a test can tell a full rebuild from an incremental one.
 */
function appendVisitedUserMessage(session: SessionManager, text: string, visited: Set<string>): string {
	const message: UserMessage = { role: "user", content: text, timestamp: 1 };
	const id = session.appendMessage(message);
	const entry = session.getEntry(id);
	if (!entry) throw new Error("Expected the appended entry.");
	const type = entry.type;
	Object.defineProperty(entry, "type", {
		configurable: true,
		enumerable: true,
		get: () => {
			visited.add(id);
			return type;
		},
	});
	return id;
}

function userText(message: ReturnType<SessionManager["buildSessionContext"]>["messages"][number]): string {
	if (message.role !== "user" || typeof message.content !== "string") {
		throw new TypeError("Expected a textual user message.");
	}
	return message.content;
}

function verificationResult(id: string, status: "failed" | "passed"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `verification-${id}-${status}`,
		toolName: "verify",
		content: [{ type: "text", text: `${id}: ${status}` }],
		details: { piVerification: { version: 1, id, status } },
		isError: status === "failed",
		timestamp: 1,
	};
}

describe("SessionManager context cache", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("advances linear messages and settings without revisiting the settled prefix", () => {
		const session = SessionManager.inMemory("/repo");
		const visited = new Set<string>();
		session.appendModelChange("anthropic", "test-model");
		for (let index = 0; index < 256; index++) appendVisitedUserMessage(session, `prefix-${index}`, visited);
		session.appendMessage(assistantMessage("prefix assistant"));

		const initial = session.buildSessionContext();
		expect(initial.messages).toHaveLength(257);
		expect(visited.size).toBe(256);
		visited.clear();

		initial.messages.length = 0;
		if (!initial.model) throw new Error("Expected the model_change projection.");
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

		// A reply written by another model (a routed turn) never becomes the session's model.
		session.appendMessage(assistantMessage("next assistant", "google", "gemini-cache"));
		advanced = session.buildSessionContext();
		expect(advanced.messages).toHaveLength(259);
		expect(advanced.model).toEqual({ provider: "openai", modelId: "gpt-cache" });
		expect(visited.size).toBe(0);
	});

	it("rebuilds once after compaction and never revisits compacted-away entries on later appends", () => {
		const session = SessionManager.inMemory("/repo");
		const visited = new Set<string>();
		for (let index = 0; index < 2_044; index++) appendVisitedUserMessage(session, `compacted-${index}`, visited);
		const keptIds: string[] = [];
		for (let index = 0; index < 4; index++) {
			keptIds.push(session.appendMessage({ role: "user", content: `kept-${index}`, timestamp: index + 2 }));
		}
		session.appendCompaction("bounded summary", keptIds[0]!, 100_000);

		visited.clear();
		const rebuilt = session.buildSessionContext();
		expect(rebuilt.messages).toHaveLength(5);
		expect(visited.size).toBe(2_044);
		visited.clear();

		for (let index = 0; index < 32; index++) {
			session.appendMessage({ role: "user", content: `later-${index}`, timestamp: index + 10 });
			expect(session.buildSessionContext().messages).toHaveLength(6 + index);
		}
		expect(visited.size).toBe(0);
	});

	it("invalidates a cached projection on branch, reset, and new session transitions", () => {
		const session = SessionManager.inMemory("/repo");
		const visited = new Set<string>();
		const rootId = appendVisitedUserMessage(session, "root", visited);
		const mainId = appendVisitedUserMessage(session, "main", visited);
		expect(session.buildSessionContext().messages).toHaveLength(2);

		visited.clear();
		session.branch(mainId);
		expect(session.buildSessionContext().messages).toHaveLength(2);
		expect(visited.size).toBe(2);

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
		if (summary?.role !== "compactionSummary") throw new Error("Expected compaction summary.");
		summary.summary = "caller mutation";

		expect(
			session.buildSessionContext().messages.find((message) => message.role === "compactionSummary"),
		).toMatchObject({
			summary: "canonical summary",
		});

		session.appendCustomMessageEntry("canonical custom", "notice", false);
		const custom = session.buildSessionContext().messages.find((message) => message.role === "custom");
		if (custom?.role !== "custom") throw new Error("Expected custom message.");
		custom.customType = "caller mutation";
		expect(session.buildSessionContext().messages.find((message) => message.role === "custom")).toMatchObject({
			customType: "canonical custom",
		});

		session.branchWithSummary(session.getLeafId(), "canonical branch summary");
		const branchSummary = session.buildSessionContext().messages.find((message) => message.role === "branchSummary");
		if (branchSummary?.role !== "branchSummary") throw new Error("Expected branch summary.");
		branchSummary.summary = "caller mutation";
		expect(session.buildSessionContext().messages.find((message) => message.role === "branchSummary")).toMatchObject({
			summary: "canonical branch summary",
		});
	});

	it("persists bounded verification snapshots through iterative compaction and clears them after a kept pass", () => {
		const session = SessionManager.inMemory("/repo");
		const rootId = session.appendMessage({ role: "user", content: "verify work", timestamp: 1 });
		session.appendMessage(verificationResult("unit-suite", "failed"));

		const firstDetails = createVerificationObligationSnapshotDetails(
			new VerificationObligationTracker(session.buildSessionContext().messages).getActiveIds(),
		);
		expect(firstDetails).toEqual({
			piVerificationObligations: { version: 1, activeIds: ["unit-suite"] },
		});
		session.appendCompaction("first checkpoint", rootId, 100, firstDetails);

		const firstContext = session.buildSessionContext().messages;
		const firstSummary = firstContext.find((message) => message.role === "compactionSummary");
		expect(firstSummary).toMatchObject({ details: firstDetails });
		expect(new VerificationObligationTracker(firstContext).getActiveIds()).toEqual(["unit-suite"]);

		const secondDetails = createVerificationObligationSnapshotDetails(
			new VerificationObligationTracker(firstContext).getActiveIds(),
		);
		session.appendCompaction("second checkpoint", rootId, 80, secondDetails);
		expect(new VerificationObligationTracker(session.buildSessionContext().messages).getActiveIds()).toEqual([
			"unit-suite",
		]);

		const passId = session.appendMessage(verificationResult("unit-suite", "passed"));
		const afterPass = session.buildSessionContext().messages;
		expect(new VerificationObligationTracker(afterPass).getActiveIds()).toEqual([]);
		const clearedDetails = createVerificationObligationSnapshotDetails(
			new VerificationObligationTracker(afterPass).getActiveIds(),
		);
		session.appendCompaction("cleared checkpoint", passId, 60, clearedDetails);

		const clearedSummary = session
			.buildSessionContext()
			.messages.find((message) => message.role === "compactionSummary");
		expect(clearedSummary).toMatchObject({
			details: { piVerificationObligations: { version: 1, activeIds: [] } },
		});
		expect(new VerificationObligationTracker(session.buildSessionContext().messages).getActiveIds()).toEqual([]);
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
