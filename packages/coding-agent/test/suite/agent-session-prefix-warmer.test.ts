import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, convertToLlm, type StreamFn } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";

interface StreamCall {
	context: Context;
	options: SimpleStreamOptions | undefined;
}

const LOCAL_MODEL = {
	api: "openai-completions",
	provider: "local-prefix-test",
	id: "local-model",
	name: "Local Prefix Test",
	baseUrl: "http://127.0.0.1:11434/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 1_024,
} as Model<Api>;

const REMOTE_MODEL = {
	...LOCAL_MODEL,
	provider: "remote-prefix-test",
	id: "remote-model",
	name: "Remote Prefix Test",
	baseUrl: "https://example.invalid/v1",
} as Model<Api>;

function assistantMessage(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		timestamp: Date.now(),
	};
}

function loggingStreamFn(calls: StreamCall[]): StreamFn {
	return (model, context, options) => {
		calls.push({ context, options });
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			if (!options?.signal?.aborted) {
				stream.push({ type: "done", reason: "stop", message: assistantMessage(model, "ok") });
			}
		});
		return stream;
	};
}

function registerModel(modelRegistry: ModelRegistry, authStorage: AuthStorage, model: Model<Api>): void {
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "test-key",
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			},
		],
	});
}

function createSession(model: Model<Api>, calls: StreamCall[]): { session: AgentSession; tempDir: string } {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-prefix-warmer-"));
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	registerModel(modelRegistry, authStorage, model);
	const agent = new Agent({
		initialState: { model, systemPrompt: "stable standing prefix", tools: [] },
		convertToLlm,
		streamFn: loggingStreamFn(calls),
	});
	return {
		tempDir,
		session: new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			collectWorkspaceSources: async () => [],
		}),
	};
}

async function waitForWarmTick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setImmediate(resolve));
}

describe("agent session local prefix warmer", () => {
	const sessions: Array<{ session: AgentSession; tempDir: string }> = [];

	afterEach(() => {
		for (const item of sessions.splice(0)) {
			item.session.dispose();
			rmSync(item.tempDir, { recursive: true, force: true });
		}
	});

	it("preloads a loopback OpenAI-compatible model with the standing prefix", async () => {
		const calls: StreamCall[] = [];
		const item = createSession(LOCAL_MODEL, calls);
		sessions.push(item);

		await waitForWarmTick();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.options?.maxTokens).toBe(1);
		expect(calls[0]?.context.messages).toEqual([]);
		expect(calls[0]?.context.systemPrompt?.length).toBeGreaterThan(0);
	});

	it("does not preload non-loopback models", async () => {
		const calls: StreamCall[] = [];
		const item = createSession(REMOTE_MODEL, calls);
		sessions.push(item);

		await waitForWarmTick();

		expect(calls).toEqual([]);
	});

	it("lets a real turn preempt the scheduled warmer", async () => {
		const calls: StreamCall[] = [];
		const item = createSession(LOCAL_MODEL, calls);
		sessions.push(item);

		await item.session.prompt("real prompt");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.options?.maxTokens).not.toBe(1);
		expect(calls[0]?.context.messages).toHaveLength(1);
	});
});
