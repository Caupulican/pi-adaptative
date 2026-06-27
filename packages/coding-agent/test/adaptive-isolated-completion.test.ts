import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@caupulican/pi-ai";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * R2 prerequisite: AgentSession.runIsolatedCompletion must run a one-shot LLM call FULLY isolated
 * from the main session — the invariant codex's §6(c) audit requires before the native reflection
 * engine can run in-process. We stub streamFn to capture what the primitive sends and assert it
 * mutates nothing.
 */
describe("runIsolatedCompletion isolation invariants", () => {
	let tempDir: string;
	let agentDir: string;

	const newSession = async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-isolated-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns text+usage and leaves session entries, history, and tools untouched", async () => {
		const session = await newSession();

		const fakeReply: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "lesson: prefer X" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let capturedContext: Context | undefined;
		let capturedOptions: SimpleStreamOptions | undefined;
		// Stub the low-level stream: capture what the primitive sends, return our canned reply.
		(session.agent as unknown as { streamFn: unknown }).streamFn = async (
			_model: unknown,
			context: Context,
			options: SimpleStreamOptions,
		) => {
			capturedContext = context;
			capturedOptions = options;
			return { result: async () => fakeReply };
		};

		const entriesBefore = session.sessionManager.getEntries().length;
		const historyBefore = session.state.messages.length;
		const toolsBefore = session.getAllTools().map((t) => t.name);

		const result = await session.runIsolatedCompletion({
			systemPrompt: "You are a reflection engine.",
			messages: [{ role: "user", content: [{ type: "text", text: "What did we learn?" }], timestamp: Date.now() }],
			maxTokens: 64,
		});

		// Result is surfaced.
		expect(result.text).toBe("lesson: prefer X");
		expect(result.usage.cost.total).toBeCloseTo(0.003, 10);
		expect(result.stopReason).toBe("stop");

		// Isolation of the OUTGOING call.
		expect(capturedContext?.tools).toEqual([]);
		expect(capturedOptions?.cacheRetention).toBe("none");
		expect(capturedOptions?.sessionId).toBeUndefined();
		// Main history was NOT used as the context.
		expect(capturedContext?.messages).toHaveLength(1);

		// Isolation of the SESSION state: nothing mutated.
		expect(session.sessionManager.getEntries().length).toBe(entriesBefore);
		expect(session.state.messages.length).toBe(historyBefore);
		expect(session.getAllTools().map((t) => t.name)).toEqual(toolsBefore);

		session.dispose();
	});
});
