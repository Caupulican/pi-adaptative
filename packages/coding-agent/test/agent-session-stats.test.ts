import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { type AssistantMessage, getModel, type Usage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function createAssistantMessage(text: string, totalTokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

function createUserMessage(text: string, timestamp: number) {
	return {
		role: "user" as const,
		content: text,
		timestamp,
	};
}

function createSession() {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});

	return { session, sessionManager };
}

function syncAgentMessages(session: AgentSession, sessionManager: SessionManager): void {
	session.agent.state.messages = sessionManager.buildSessionContext().messages;
}

describe("AgentSession.getSessionStats", () => {
	it("aggregates tool argument validation telemetry", async () => {
		const { session, sessionManager } = createSession();

		try {
			session.agent.onToolArgumentValidation?.({
				outcome: "clean",
				model: "claude-sonnet-4-5",
				provider: "anthropic",
				tool: "read",
				failureModes: [],
				repairsApplied: [],
				taught: "none",
				executionOutcome: "succeeded",
			});
			session.agent.onToolArgumentValidation?.({
				outcome: "repaired",
				model: "claude-sonnet-4-5",
				provider: "anthropic",
				tool: "edit",
				failureModes: ["jsonStringParse"],
				repairsApplied: ["jsonStringParse"],
				taught: "note",
				executionOutcome: "succeeded",
			});
			session.agent.onToolArgumentValidation?.({
				outcome: "bounced",
				model: "claude-sonnet-4-5",
				provider: "anthropic",
				tool: "bash",
				failureModes: ["bashCommandUnwrap"],
				repairsApplied: [],
				taught: "none",
				executionOutcome: "not_run",
			});

			expect(session.getSessionStats().toolArgumentValidation).toEqual({
				clean: 0,
				repaired: 1,
				bounced: 1,
				failureModes: { jsonStringParse: 1, bashCommandUnwrap: 1 },
				repairsApplied: { jsonStringParse: 1 },
				taught: { none: 1, note: 1, rule: 0 },
				executionOutcome: { not_run: 1, succeeded: 1, failed: 0 },
				teachEfficacy: {
					"anthropic/claude-sonnet-4-5:bashCommandUnwrap": {
						recurrenceBefore: 1,
						recurrenceAfter: 0,
						repairedThenSucceeded: 0,
						repairedThenFailed: 0,
						repairedThenNotRun: 0,
					},
					"anthropic/claude-sonnet-4-5:jsonStringParse": {
						recurrenceBefore: 0,
						recurrenceAfter: 1,
						repairedThenSucceeded: 1,
						repairedThenFailed: 0,
						repairedThenNotRun: 0,
					},
				},
			});
			expect(sessionManager.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(0);
		} finally {
			await session.disposeAndWait();
		}
	});

	it("aggregates persisted compaction gate failure telemetry", async () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 2));
			sessionManager.appendCompaction("summary", keptUserId, 1000, {
				readFiles: [],
				modifiedFiles: [],
				verificationGateFailures: 2,
				deterministicGapFills: 1,
				verificationGateChecks: {
					"open-errors-recall": {
						failures: 2,
						minScore: 0.09,
						maxScore: 0.43,
						threshold: 0.7,
						comparator: "minimum",
					},
				},
			});
			sessionManager.appendCompaction("summary 2", keptUserId, 800, {
				readFiles: [],
				modifiedFiles: [],
				verificationGateFailures: 0,
				deterministicGapFills: 0,
			});
			syncAgentMessages(session, sessionManager);

			expect(session.getSessionStats().compactionGates).toEqual({
				gateFailures: 2,
				deterministicGapFills: 1,
				compactionsWithGateFailures: 1,
				checks: {
					"open-errors-recall": {
						failures: 2,
						minScore: 0.09,
						maxScore: 0.43,
						threshold: 0.7,
						comparator: "minimum",
					},
				},
			});
		} finally {
			await session.disposeAndWait();
		}
	});

	it("exposes the current context usage alongside token totals", async () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("hello", 1));
			sessionManager.appendMessage(createAssistantMessage("hi", 200, 2));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toEqual(session.getContextUsage());
			expect(stats.contextUsage?.tokens).toBe(200);
			expect(stats.contextUsage?.contextWindow).toBe(model.contextWindow);
			expect(stats.contextUsage?.percent).toBe((200 / model.contextWindow) * 100);
		} finally {
			await session.disposeAndWait();
		}
	});

	it("reports unknown current context usage immediately after compaction", async () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			sessionManager.appendMessage(createUserMessage("third", 5));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.tokens.input).toBe(375_000);
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBeNull();
			expect(stats.contextUsage?.percent).toBeNull();
		} finally {
			await session.disposeAndWait();
		}
	});

	it("checks post-compaction usage without rebuilding the full session branch", async () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 2));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			const postCompactionTimestamp = Date.now() + 1_000;
			sessionManager.appendMessage(createUserMessage("third", postCompactionTimestamp));
			sessionManager.appendMessage(createAssistantMessage("response", 25_000, postCompactionTimestamp + 1));
			syncAgentMessages(session, sessionManager);
			const getBranch = vi.spyOn(sessionManager, "getBranch");

			expect(session.getContextUsage()?.tokens).toBe(25_000);
			expect(getBranch).not.toHaveBeenCalled();
		} finally {
			await session.disposeAndWait();
		}
	});

	it("updates context usage from only newly appended branch entries", async () => {
		const { session, sessionManager } = createSession();

		try {
			for (let index = 0; index < 100; index++) {
				sessionManager.appendMessage(createUserMessage(`user-${index}`, index * 2 + 1));
				sessionManager.appendMessage(createAssistantMessage(`assistant-${index}`, index + 1, index * 2 + 2));
			}
			syncAgentMessages(session, sessionManager);
			session.getContextUsage();
			const getEntry = vi.spyOn(sessionManager, "getEntry");
			const userId = sessionManager.appendMessage(createUserMessage("latest", 1000));
			sessionManager.appendMessage(createAssistantMessage("latest response", 500, 1001));
			syncAgentMessages(session, sessionManager);
			getEntry.mockClear();

			expect(session.getContextUsage()?.tokens).toBe(500);
			expect(getEntry.mock.calls.length).toBeLessThanOrEqual(2);
			expect(sessionManager.getEntry(userId)).toBeDefined();
		} finally {
			await session.disposeAndWait();
		}
	});

	it("uses post-compaction usage for current context instead of stale kept usage", async () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			const postCompactionTimestamp = Date.now() + 1_000;
			sessionManager.appendMessage(createUserMessage("third", postCompactionTimestamp));
			sessionManager.appendMessage(createAssistantMessage("response3", 25_000, postCompactionTimestamp + 1));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.tokens.input).toBe(400_000);
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBe(25_000);
			expect(stats.contextUsage?.percent).toBe((25_000 / model.contextWindow) * 100);
		} finally {
			await session.disposeAndWait();
		}
	});
});
