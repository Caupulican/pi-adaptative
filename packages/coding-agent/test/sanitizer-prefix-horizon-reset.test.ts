/**
 * Coverage for the turn-economics reset-wiring task: `Agent.resetSanitizerPrefixHorizon()` must be
 * called at genuine lineage changes (session load, branch switch) and must NOT be called by
 * compaction's own within-lineage trim/summary-append -- see the "Compaction and Long Sessions"
 * entry in the repo-root AGENTS.md and `Agent.resetSanitizerPrefixHorizon`'s doc comment
 * (packages/agent/src/agent.ts) for the full rationale. This spies on the real method rather than
 * reaching into `Agent`'s private `sanitizerSentPrefixCount` field, so it tests the WIRING
 * (coding-agent's call sites) rather than re-testing packages/agent's own mark semantics.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@caupulican/pi-agent-core/agent";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import type { AssistantMessage, Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

// Real compaction summarization needs a real model call; fake it exactly like
// agent-session-auto-compaction-queue.test.ts does, so `session.compact()` runs its full local
// orchestration (including the `_refreshAfterCompaction` resync) without any network access.
vi.mock("@caupulican/pi-agent-core/compaction/compaction", async (importOriginal) => {
	const original = await importOriginal<typeof import("@caupulican/pi-agent-core/compaction/compaction")>();
	return {
		...original,
		compact: async (preparation: Parameters<typeof original.compact>[0]) => ({
			summary: "compacted",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}),
		collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
		generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	};
});

const model: Model<any> = {
	id: "claude-sonnet-4-5",
	name: "claude-sonnet-4-5",
	provider: "anthropic",
	api: "messages",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

function createTempDir(label: string): string {
	const dir = join(tmpdir(), `pi-sanitizer-horizon-${label}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("sanitizer prefix horizon reset wiring", () => {
	let tempDir: string;

	afterEach(() => {
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("resets on session load (AgentSession construction restores state.messages from durable storage)", () => {
		tempDir = createTempDir("load");
		const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [] } });
		const resetSpy = vi.spyOn(agent, "resetSanitizerPrefixHorizon");

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "prior session message" }],
			timestamp: Date.now() - 1000,
		});
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		try {
			// Constructor already ran by this point -- the assertion is on the call that already
			// happened, not on triggering a new one.
			expect(resetSpy).toHaveBeenCalledTimes(1);
		} finally {
			session.dispose();
		}
	});

	it("resets on a branch switch (navigateTree replaces state.messages with a different lineage)", async () => {
		tempDir = createTempDir("branch");
		const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [] } });

		const sessionManager = SessionManager.inMemory();
		const rootUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "First message" }],
			timestamp: Date.now() - 3000,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "First reply" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 2000,
		};
		const secondUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "Second message" }],
			timestamp: Date.now() - 1000,
		};
		const rootEntryId = sessionManager.appendMessage(rootUser);
		sessionManager.appendMessage(assistant);
		sessionManager.appendMessage(secondUser);
		agent.state.messages = [rootUser, assistant, secondUser];

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		try {
			// Spy only after construction so the constructor's own (already-covered) call doesn't
			// pollute this assertion.
			const resetSpy = vi.spyOn(agent, "resetSanitizerPrefixHorizon");
			const result = await session.navigateTree(rootEntryId, { summarize: false });
			expect(result.cancelled).toBe(false);
			expect(resetSpy).toHaveBeenCalledTimes(1);
		} finally {
			session.dispose();
		}
	});

	it("does NOT reset for a compaction pass (within-lineage trim + summary append)", async () => {
		tempDir = createTempDir("compaction");
		const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [] } });

		const sessionManager = SessionManager.inMemory();
		const user = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "Old message to be compacted" }],
			timestamp: Date.now() - 2000,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Old reply" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 1000,
		};
		sessionManager.appendMessage(user);
		sessionManager.appendMessage(assistant);
		agent.state.messages = [user, assistant];

		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		try {
			const resetSpy = vi.spyOn(agent, "resetSanitizerPrefixHorizon");
			await session.compact();
			// Confirm compaction actually ran (not silently skipped) before trusting the negative
			// assertion below.
			expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
			expect(resetSpy).not.toHaveBeenCalled();
		} finally {
			session.dispose();
		}
	});
});
