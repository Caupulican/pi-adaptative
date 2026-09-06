import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import { WorkerConversation, WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";

describe("worker transcript inspection", () => {
	it.each(["input", "output"])("keeps the %s byte ceiling and advances past omissions", (ceiling) => {
		const manager = SessionManager.inMemory("/repo");
		manager.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: ceiling === "output" ? "large output".repeat(400) : "small" },
				{
					type: "thinking",
					thinking: "small",
					thinkingSignature: ceiling === "input" ? "x".repeat(140_000) : "opaque",
				},
			]),
		);
		manager.appendMessage({ role: "user", content: "retained next entry", timestamp: 1 });
		const conversation = new WorkerConversation(manager, {
			provider: "pi",
			sessionId: manager.getSessionId(),
			cwd: "/repo",
			resourceProfileNames: [],
			contextPointers: [],
		});
		const first = conversation.getRawTranscriptPage({ projection: "inspection", maxBytes: 2048, maxMessages: 1 });
		expect(first).toMatchObject({ messages: [], omittedMessages: 1, serializedBytes: 2 });
		expect(first.nextCursor).toBeGreaterThan(0);
		const next = conversation.getRawTranscriptPage({
			projection: "inspection",
			maxBytes: 2048,
			maxMessages: 1,
			cursor: first.nextCursor,
		});
		expect(next.messages).toMatchObject([{ role: "user", content: "retained next entry" }]);
		expect(next.omittedMessages).toBe(0);
		expect(next.nextCursor).toBeUndefined();
	});

	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	it("returns useful persisted output through worker control without changing replay", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-transcript-control-"));
		roots.push(agentDir);
		const parentSessionId = "parent";
		const store = new WorkerConversationStore();
		const conversation = store.create({
			agentDir,
			parentSessionId,
			logicalAgentId: "worker",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const original = fauxAssistantMessage([
			{ type: "thinking", thinking: "Checked the result.", thinkingSignature: "opaque".repeat(4000) },
			{ type: "text", text: "Verified final finding." },
		]);
		conversation.appendMessage(original);
		conversation.appendMessage({ role: "user", content: "next page", timestamp: 1 });
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: parentSessionId });
		lifecycle.ensureAgent({ agentId: "worker", role: "explorer", resumeContext: conversation.getResumeContext() });
		const coordinator = new WorkerAgentControlCoordinator({
			agentDir,
			parentSessionId,
			processOwnerId: "pi-worker:1:owner",
			isControlAvailable: () => true,
			getLifecycle: () => lifecycle,
			recoveredRequest: () => ({ instructions: "unused" }),
			run: async () => ({ started: false, skipReason: "unused" }),
			scheduler: { enqueue: vi.fn(), drain: vi.fn(), track: vi.fn(), dropQueued: vi.fn() },
			statusChanged: vi.fn(),
			abortLane: vi.fn(),
			cancelLane: vi.fn(),
		});
		const page = coordinator.readWorkerAgentTranscript("worker", { maxBytes: 2048, maxMessages: 1 });
		expect(page.omittedMessages).toBe(0);
		expect(JSON.stringify(page.messages)).toContain("Verified final finding.");
		expect(JSON.stringify(page.messages)).not.toContain("opaque");
		expect(page.serializedBytes).toBeLessThanOrEqual(2048);
		expect(
			coordinator.readWorkerAgentTranscript("worker", {
				cursor: page.nextCursor,
				maxBytes: 2048,
				maxMessages: 1,
			}).messages,
		).toMatchObject([{ role: "user", content: "next page" }]);
		expect(conversation.getRawTranscript()[0]).toEqual(original);
	});
	it.each([false, true])(
		"budgets useful content without opaque signatures and preserves raw replay (persisted=%s)",
		(persisted) => {
			const manager = SessionManager.inMemory("/repo");
			const message = fauxAssistantMessage([
				{ type: "thinking", thinking: "Checked the invariant.", thinkingSignature: "opaque".repeat(4000) },
				{ type: "text", text: "Verified final finding.", textSignature: "opaque-text" },
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "source.ts", textSignature: "literal argument" },
					thoughtSignature: "opaque-tool",
				},
			]);
			let conversation = new WorkerConversation(manager, {
				provider: "pi",
				sessionId: manager.getSessionId(),
				cwd: "/repo",
				resourceProfileNames: [],
				contextPointers: [],
			});
			const root = mkdtempSync(join(tmpdir(), "pi-transcript-inspection-"));
			roots.push(root);
			const store = new WorkerConversationStore();
			if (persisted)
				conversation = store.create({
					agentDir: root,
					parentSessionId: "parent",
					logicalAgentId: "worker",
					cwd: root,
					resourceProfileNames: [],
					contextPointers: [],
				});
			conversation.appendMessage(message);
			conversation.appendMessage({ role: "user", content: "next page", timestamp: 1 });
			if (persisted) {
				const resumeContext = conversation.getResumeContext();
				store.clearCache();
				conversation = store.open({ agentDir: root, resumeContext });
			}
			const options = { maxBytes: 2048, maxMessages: 1, projection: "inspection" as const };
			const page = conversation.getRawTranscriptPage(options);
			expect(page.omittedMessages).toBe(0);
			expect(page.messages).toHaveLength(1);
			const serialized = JSON.stringify(page.messages);
			expect(serialized).toContain("Verified final finding.");
			expect(serialized).toContain("literal argument");
			expect(serialized).not.toContain("opaque");
			expect(page.serializedBytes).toBe(Buffer.byteLength(serialized));
			expect(page.serializedBytes).toBeLessThanOrEqual(2048);
			expect(conversation.getRawTranscriptPage({ ...options, cursor: page.nextCursor }).messages).toMatchObject([
				{ role: "user", content: "next page" },
			]);
			expect(conversation.getRawTranscript()[0]).toEqual(message);
			expect(conversation.getRawTranscriptPage({ maxBytes: 2048, maxMessages: 1 }).omittedMessages).toBe(1);
		},
	);
});
