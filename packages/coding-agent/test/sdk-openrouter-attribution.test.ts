import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { resolveProviderRequestAuthOptions } from "@caupulican/pi-agent-core/provider-request-planner";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@caupulican/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { tempDir as createTempDir } from "./temp-dir.ts";

describe("createAgentSession OpenRouter attribution headers", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = createTempDir("pi-sdk-openrouter-test-");
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	function createModel(provider: string, baseUrl: string): Model<Api> {
		return {
			id: `${provider}-test-model`,
			name: `${provider} Test Model`,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createDoneStream() {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
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

	async function captureHeaders(
		model: Model<Api>,
		options: {
			providerHeaders?: Record<string, string>;
			requestHeaders?: Record<string, string>;
			sessionId?: string;
		} = {},
	): Promise<Record<string, string> | undefined> {
		const settingsManager = SettingsManager.create(cwd, agentDir);

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey(model.provider, "test-api-key");
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const registeredProviders = ["capture-provider"];
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider("capture-provider", {
			api: "openai-completions",
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream();
			},
		});

		if (options.providerHeaders) {
			modelRegistry.registerProvider(model.provider, { headers: options.providerHeaders });
			registeredProviders.push(model.provider);
		}

		const sessionManager = SessionManager.inMemory(cwd);
		if (options.sessionId) {
			sessionManager.newSession({ id: options.sessionId });
		}

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
		});

		try {
			const requestOptions = {
				sessionId: session.sessionId,
				...(options.requestHeaders ? { headers: options.requestHeaders } : {}),
			};
			const requestAuth = await resolveProviderRequestAuthOptions({
				model,
				headers: requestOptions.headers,
				getApiKey: session.agent.getApiKey,
				resolveProviderRequestAuth: session.agent.resolveProviderRequestAuth,
			});
			await session.agent.streamFn(model, { messages: [] }, { ...requestOptions, ...requestAuth });
			return capturedOptions?.headers;
		} finally {
			await session.disposeAndWait();
			for (const provider of registeredProviders.reverse()) {
				modelRegistry.unregisterProvider(provider);
			}
		}
	}

	it("adds default attribution headers for OpenRouter models", async () => {
		const headers = await captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"));

		expect(headers?.["HTTP-Referer"]).toBe("https://github.com/Caupulican/pi-adaptative");
		expect(headers?.["X-OpenRouter-Title"]).toBe("pi");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("cli-agent");
	});

	it("adds attribution headers for custom providers routed through OpenRouter", async () => {
		const headers = await captureHeaders(createModel("custom-openrouter", "https://openrouter.ai/api/v1"));

		expect(headers?.["HTTP-Referer"]).toBe("https://github.com/Caupulican/pi-adaptative");
		expect(headers?.["X-OpenRouter-Title"]).toBe("pi");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("cli-agent");
	});

	it("lets provider and request headers override the defaults", async () => {
		const headers = await captureHeaders(createModel("openrouter", "https://openrouter.ai/api/v1"), {
			providerHeaders: {
				"HTTP-Referer": "https://provider.example",
				"X-OpenRouter-Categories": "provider-category",
			},
			requestHeaders: {
				"X-OpenRouter-Title": "request-title",
			},
		});

		expect(headers?.["HTTP-Referer"]).toBe("https://provider.example");
		expect(headers?.["X-OpenRouter-Title"]).toBe("request-title");
		expect(headers?.["X-OpenRouter-Categories"]).toBe("provider-category");
	});

	it("adds OpenCode session headers", async () => {
		const headers = await captureHeaders(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
		});

		expect(headers?.["x-opencode-session"]).toBe("opencode-session");
		expect(headers?.["x-opencode-client"]).toBe("pi");
	});

	it("lets configured OpenCode headers override the defaults", async () => {
		const headers = await captureHeaders(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
			providerHeaders: {
				"x-opencode-session": "configured-session",
				"x-opencode-client": "configured-client",
			},
		});

		expect(headers?.["x-opencode-session"]).toBe("configured-session");
		expect(headers?.["x-opencode-client"]).toBe("configured-client");
	});
});
