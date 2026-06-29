import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { Agent } from "@caupulican/pi-agent-core";
import { type AssistantMessage, getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: (usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens?: number;
	}) => usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => ({
		summary: "compacted",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
		details: {},
	}),
	estimateContextTokens: (
		messages: Array<{
			role: string;
			content?: Array<{ type: string; text?: string }>;
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
			stopReason?: string;
		}>,
	) => {
		const estimate = (message: { content?: Array<{ type: string; text?: string }> }) =>
			(message.content || []).reduce((sum, part) => sum + Math.ceil((part.text || "").length / 4), 0);
		// Walk backwards to find last non-error, non-aborted assistant with usage
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted" && msg.usage) {
				const usageTokens =
					msg.usage.totalTokens ?? msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				const trailingTokens = messages.slice(i + 1).reduce((sum, message) => sum + estimate(message), 0);
				return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: i };
			}
		}
		const tokens = messages.reduce((sum, message) => sum + estimate(message), 0);
		return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
	},
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: () => ({ dummy: true }),
	shouldCompact: (
		contextTokens: number,
		contextWindow: number,
		settings: { enabled: boolean; reserveTokens: number },
	) => settings.enabled && contextTokens > contextWindow - settings.reserveTokens,
}));

describe("AgentSession auto-compaction queue resume", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auto-compaction-queue-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		vi.useFakeTimers();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		sessionManager = SessionManager.inMemory();
		settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("should resume after threshold compaction when only agent-level queued messages exist", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		expect(session.pendingMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(true);

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
			}
		)._runAutoCompaction.bind(session);

		await expect(runAutoCompaction("threshold", false)).resolves.toBe(true);

		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("should cap the agent continuation loop using autonomy goal loop rounds", async () => {
		settingsManager.setAutonomySettings({ mode: "full", maxStallTurns: 3 });
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const internals = session as unknown as {
			_runAgentPrompt: (messages: AgentMessage | AgentMessage[]) => Promise<void>;
			_handlePostAgentRun: () => Promise<boolean>;
		};
		vi.spyOn(internals, "_handlePostAgentRun")
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);

		await internals._runAgentPrompt({
			role: "user",
			content: [{ type: "text", text: "keep working" }],
			timestamp: Date.now(),
		});

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(session.agent.maxStallTurns).toBe(3);
		expect(continueSpy).toHaveBeenCalledTimes(2);
	});

	it("should treat zero autonomy max stall turns as unlimited foreground continuations", async () => {
		settingsManager.setAutonomySettings({ mode: "full", maxStallTurns: 0 });
		vi.spyOn(session.agent, "prompt").mockResolvedValue();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const internals = session as unknown as {
			_runAgentPrompt: (messages: AgentMessage | AgentMessage[]) => Promise<void>;
			_handlePostAgentRun: () => Promise<boolean>;
		};
		vi.spyOn(internals, "_handlePostAgentRun")
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);

		await internals._runAgentPrompt({
			role: "user",
			content: [{ type: "text", text: "keep working" }],
			timestamp: Date.now(),
		});

		expect(session.agent.maxStallTurns).toBe(0);
		expect(continueSpy).toHaveBeenCalledTimes(3);
	});

	it("should compact between tool-loop turns before the next provider request", async () => {
		const model = session.model!;
		const at = Date.now();
		const user = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "inspect repo" }],
			timestamp: at,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "large output" } } as any],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: at + 1,
		};
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text" as const, text: "x".repeat(model.contextWindow * 4) }],
			isError: false,
			timestamp: at + 2,
		};

		sessionManager.appendMessage(user);
		sessionManager.appendMessage(assistant);
		sessionManager.appendMessage(toolResult);
		session.agent.state.messages = [user, assistant, toolResult];

		const transformed = await session.agent.transformContext?.([user, assistant, toolResult], undefined);

		expect(transformed).toEqual(session.agent.state.messages);
		expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("should not compact repeatedly after overflow recovery already attempted", async () => {
		const model = session.model!;
		const overflowMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		};

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const events: Array<{ type: string; reason: string; errorMessage?: string }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				events.push({ type: event.type, reason: event.reason, errorMessage: event.errorMessage });
			}
		});

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(overflowMessage);
		await checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual({
			type: "compaction_end",
			reason: "overflow",
			errorMessage:
				"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		});
	});

	it("should ignore stale pre-compaction assistant usage on pre-prompt compaction checks", async () => {
		const model = session.model!;
		const staleAssistantTimestamp = Date.now() - 10_000;
		const staleAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large response before compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 600_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 610_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: staleAssistantTimestamp,
		};

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleAssistantTimestamp - 1000,
		});
		sessionManager.appendMessage(staleAssistant);

		const firstKeptEntryId = sessionManager.getEntries()[0]!.id;
		sessionManager.appendCompaction("summary", firstKeptEntryId, staleAssistant.usage.totalTokens, undefined, false);

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "session recovery payload" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("should trigger threshold compaction for error messages using last successful usage", async () => {
		const model = session.model!;

		// A successful assistant message with high token usage (near context limit)
		const successfulAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "large successful response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 180_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 190_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		// An error message (e.g. 529 overloaded) with no useful usage data
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		};

		// Put both messages into agent state so estimateContextTokens can find the successful one
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "another prompt" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("should ignore stale pre-compaction assistant usage in provider preflight transform", async () => {
		const model = session.model!;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "kept response from before compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 180_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 190_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: preCompactionTimestamp,
		};
		const beforeUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		};
		const afterUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "new small prompt" }],
			timestamp: Date.now(),
		};

		sessionManager.appendMessage(beforeUser);
		sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = sessionManager.getEntries()[0]!.id;
		sessionManager.appendCompaction("summary", firstKeptEntryId, keptAssistant.usage.totalTokens, undefined, false);
		sessionManager.appendMessage(afterUser);
		session.agent.state.messages = [beforeUser, keptAssistant, afterUser];

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const transformed = await session.agent.transformContext?.([beforeUser, keptAssistant, afterUser], undefined);

		expect(transformed).toEqual([beforeUser, keptAssistant, afterUser]);
		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("should not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const model = session.model!;

		// An error message with no prior successful assistant in context
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		};

		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("should not trigger threshold compaction for error messages when only kept pre-compaction usage exists", async () => {
		const model = session.model!;
		const preCompactionTimestamp = Date.now() - 10_000;

		// A "kept" assistant message from before compaction with high usage
		const keptAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "kept response from before compaction" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 180_000,
				output: 10_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 190_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: preCompactionTimestamp,
		};

		// Record the kept assistant in the session and create a compaction after it
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = sessionManager.getEntries()[0]!.id;
		sessionManager.appendCompaction("summary", firstKeptEntryId, keptAssistant.usage.totalTokens, undefined, false);

		// Post-compaction error message
		const errorAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		};

		// Agent state has the kept assistant (pre-compaction) and the error (post-compaction)
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user msg" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const checkCompaction = (
			session as unknown as {
				_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session);

		await checkCompaction(errorAssistant);

		// Should NOT compact because the only usage data is from a kept pre-compaction message
		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});
});
