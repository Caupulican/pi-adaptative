import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(api: Api, provider = "capture-provider"): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider,
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createDoneStream(api: Api) {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function captureStreamOptions(
		api: Api,
		settings: {
			httpIdleTimeoutMs?: number;
			websocketConnectTimeoutMs?: number;
			fastMode?: Record<string, boolean>;
		},
		requestOptions: SimpleStreamOptions = {},
		provider = "capture-provider",
		isChildSession = false,
		sessionOptions: Pick<CreateAgentSessionOptions, "serviceTier"> = {},
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api, provider);
		const settingsManager = SettingsManager.inMemory(settings);

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream(api);
			},
		});

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			...sessionOptions,
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
			isChildSession,
		});

		try {
			await session.agent.streamFn(model, { messages: [] }, requestOptions);
			return capturedOptions;
		} finally {
			await session.disposeAndWait();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("marks a direct foreground SDK request as user-facing", async () => {
		const options = await captureStreamOptions("openai-completions", {});

		expect(options?.interactionMode).toBe("user");
		expect(options?.onInteractiveAuthRecovery).toBeTypeOf("function");
	});

	it("clamps child SDK requests to background mode", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{ interactionMode: "user" },
			"capture-provider",
			true,
		);

		expect(options?.interactionMode).toBe("background");
	});

	it("forwards httpIdleTimeoutMs as timeoutMs for other providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("maps httpIdleTimeoutMs=0 to an effectively disabled SDK timeout", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 0 });

		expect(options?.timeoutMs).toBe(2147483647);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards the session service tier to provider requests", async () => {
		const options = await captureStreamOptions("openai-responses", {}, {}, "capture-provider", false, {
			serviceTier: "priority",
		});

		expect(options?.serviceTier).toBe("priority");
	});

	it("lets a request-specific service tier override the session default", async () => {
		const options = await captureStreamOptions(
			"openai-responses",
			{},
			{ serviceTier: "default" },
			"capture-provider",
			false,
			{ serviceTier: "priority" },
		);

		expect(options?.serviceTier).toBe("default");
	});

	it("lets an explicit null service tier clear the session default", async () => {
		const options = await captureStreamOptions(
			"openai-responses",
			{},
			{ serviceTier: null },
			"capture-provider",
			false,
			{ serviceTier: "priority" },
		);

		expect(options?.serviceTier).toBeNull();
	});

	it("maps a saved Codex fast preference to priority processing", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ fastMode: { "openai-codex": true } },
			{},
			"openai-codex",
		);

		expect(options?.serviceTier).toBe("priority");
	});

	it("maps an explicit Codex fast-off preference to default even over a session tier", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ fastMode: { "openai-codex": false } },
			{},
			"openai-codex",
			false,
			{ serviceTier: "priority" },
		);

		expect(options?.serviceTier).toBe("default");
	});

	it("keeps a request-specific tier authoritative over Codex fast mode", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ fastMode: { "openai-codex": true } },
			{ serviceTier: "flex" },
			"openai-codex",
		);

		expect(options?.serviceTier).toBe("flex");
	});

	it("maps a saved Grok fast preference to priority processing", async () => {
		const options = await captureStreamOptions("openai-responses", { fastMode: { xai: true } }, {}, "xai");

		expect(options?.serviceTier).toBe("priority");
	});

	it("keeps Grok reasoning effort independent from a saved fast preference", async () => {
		const model = createModel("openai-responses", "xai");
		model.reasoning = true;
		model.defaultThinkingLevel = "high";
		const settingsManager = SettingsManager.inMemory({ fastMode: { xai: true } });
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: () => createDoneStream(model.api),
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			expect(session.thinkingLevel).toBe("high");
		} finally {
			await session.disposeAndWait();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("wires OAuth rejection recovery by the Codex provider id rather than its API id", async () => {
		const options = await captureStreamOptions("openai-codex-responses", {}, {}, "openai-codex");

		expect(options?.onAuthRejection).toBeTypeOf("function");
	});
});
