// @isolated: uses a session harness and mutable credential-state transitions
// @guards packages/coding-agent/src/core/sdk.ts packages/coding-agent/src/core/agent-session.ts packages/coding-agent/src/core/tool-protocol-controller.ts packages/coding-agent/src/core/compaction-support.ts packages/coding-agent/src/core/compaction-controller.ts packages/agent/src

import { startPlannedAgentProviderRequest } from "@caupulican/pi-agent-core/provider-request-planner";
import { type Api, createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CompactionSupport } from "../src/core/compaction-support.ts";
import { ForegroundLifecycleAdapter } from "../src/core/foreground-lifecycle-adapter.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { ModelRouterController } from "../src/core/model-router-controller.ts";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import {
	fenceRecoveredProviderApiKey,
	providerAccountKey,
	resolveProviderAccountKey,
} from "../src/core/provider-admission/account-key.ts";
import { withProviderAdmission } from "../src/core/provider-admission/gate.ts";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";
import { ProviderLimitStore } from "../src/core/provider-admission/limit-state.ts";
import { ToolProtocolController } from "../src/core/tool-protocol-controller.ts";
import { createHarness, fauxModel } from "./test-harness.ts";

describe("foreground retry provider limits", () => {
	it("publishes retry cooldown under the same credential-scoped key admission reads", async () => {
		const harness = createHarness();
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
		try {
			let activeAccount = "account-a";
			const limits = new ProviderLimitStore(harness.tempDir, { now: () => 1_000 });
			const lifecycle = new ForegroundLifecycleAdapter(
				harness.agent,
				harness.sessionManager,
				{ commitSessionBufferPrefix: () => new Map() } as ModelRouterController,
				undefined,
				undefined,
				limits,
			);
			lifecycle.install();
			await harness.agent.onProviderRequestSnapshot?.(
				{
					requestId: "credential-scoped-retry",
					model: { api: "faux", provider: "faux", id: "faux-1" },
					reasoning: "off",
					maxTokens: 128,
					attempt: 0,
					context: { systemPrompt: "", tools: [], messages: [] },
					providerAccountKey: `faux#${activeAccount}`,
				} as never,
				undefined,
			);
			activeAccount = "account-b";

			lifecycle.recordRetryEvent({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 2_000,
				errorMessage: "429 rate limit",
			});

			expect(limits.read("faux#account-a")).toMatchObject({
				provider: "faux#account-a",
				limitedUntil: 3_000,
				reason: "rate_limit",
			});
			expect(limits.read("faux")).toBeUndefined();
			expect(limits.read("faux#account-b")).toBeUndefined();
		} finally {
			clock.mockRestore();
			await harness.cleanup();
		}
	});

	it("keys an effective runtime override by the credential transport actually uses", () => {
		const storage = AuthStorage.inMemory({
			faux: {
				type: "oauth",
				access: "stored-access",
				refresh: "stored-refresh",
				expires: Date.now() + 60_000,
				accountId: "stored-account",
			},
		});
		storage.setRuntimeApiKey("faux", "runtime-override");
		expect(resolveProviderAccountKey(storage, "faux", "runtime-override")).toBe(
			providerAccountKey("faux", { type: "api_key", key: "runtime-override" }),
		);
		expect(resolveProviderAccountKey(storage, "faux")).toBe("faux#stored-account");
	});

	it("freezes subscription routing headers and account identity for cloud compaction", async () => {
		const provider = "openai-codex";
		const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-a" } })).toString("base64url")}.signature`;
		const storage = AuthStorage.inMemory({
			[provider]: {
				type: "oauth",
				access,
				refresh: "refresh-a",
				expires: Date.now() + 60_000,
				accountId: "account-a",
				chatgptAccountIsFedramp: true,
			},
		});
		const registry = ModelRegistry.create(storage);
		const model = {
			...fauxModel,
			api: "openai-codex-responses",
			provider,
			id: "gpt-fixture",
		} as Model<Api>;
		const support = new CompactionSupport({
			getModel: () => model,
			getSettingsManager: () => {
				throw new Error("not used by auth resolution");
			},
			getModelRegistry: () => registry,
			isRawStream: () => false,
			getRequiredRequestAuth: async () => ({ apiKey: access }),
			isModelExhausted: () => false,
			getStoredFitnessReport: () => undefined,
			estimateSummarizationInputTokens: () => 1,
			emitWarning: () => {},
			ensureModelReady: async () => {},
		});

		const resolved = await support.resolveModelAndAuth(model, model);
		expect(resolved.apiKey).toBe(access);
		expect(resolved.credentialHeaders).toEqual({ "X-OpenAI-Fedramp": "true" });
		expect(resolved.providerAccountKey).toBe(`${provider}#account-a`);
	});

	it("returns account identity in the same registry projection as the transport credential", async () => {
		const provider = "openai-codex";
		const credentialA = {
			type: "oauth" as const,
			access: "access-a",
			refresh: "refresh-a",
			expires: Date.now() + 60_000,
			accountId: "account-a",
		};
		const storage = AuthStorage.inMemory({ [provider]: credentialA });
		const registry = ModelRegistry.create(storage);
		const model = { ...fauxModel, provider, id: "gpt-fixture" } as Model<Api>;

		const resolved = await registry.getApiKeyAndHeaders(model);
		storage.set(provider, { ...credentialA, access: "access-b", refresh: "refresh-b", accountId: "account-b" });

		expect(resolved).toMatchObject({
			ok: true,
			apiKey: "access-a",
			providerAccountKey: `${provider}#account-a`,
		});
	});

	it("keeps admission on the request-frozen account when live auth changes before dispatch", async () => {
		const harness = createHarness();
		const model = { api: "faux", provider: "faux", id: "faux-1" } as Model<Api>;
		const accountA = "faux#account-a";
		const accountB = "faux#account-b";
		const ledger = new ProviderAdmissionLedger(harness.tempDir);
		const inner = createAssistantMessageEventStream();
		const wrapped = withProviderAdmission(
			() => {
				expect(ledger.countInflight(accountA).total).toBe(1);
				expect(ledger.countInflight(accountB).total).toBe(0);
				inner.end(fauxAssistantMessage("done"));
				return inner;
			},
			{
				ledger,
				getAccountKey: () => accountB,
				getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 1_000, foregroundLimitWaitMs: 1_000 }),
			},
		);

		try {
			const options = { providerAccountKey: accountA };
			const stream = await wrapped(model, { messages: [] }, options);
			await stream.result();
		} finally {
			ledger.releaseAll();
			await harness.cleanup();
		}
	});

	it("carries one frozen account scope from accepted snapshot through stream admission", async () => {
		const harness = createHarness();
		const model = {
			api: "faux",
			provider: "faux",
			id: "faux-1",
			maxTokens: 128,
		} as Model<Api>;
		let activeAccount = "account-a";
		let activeCredentialHeader = "header-a";
		const accountA = "faux#account-a";
		const accountB = "faux#account-b";
		const ledger = new ProviderAdmissionLedger(harness.tempDir);
		const wrapped = withProviderAdmission(
			(_requestModel, _context, options) => {
				expect(ledger.countInflight(accountA).total).toBe(1);
				expect(ledger.countInflight(accountB).total).toBe(0);
				expect(options?.apiKey).toBe("credential-a");
				expect(options?.headers).toEqual({ Authorization: "Bearer credential-a" });
				expect(options?.credentialHeaders).toEqual({ "x-account-route": "header-a" });
				const stream = createAssistantMessageEventStream();
				stream.end(fauxAssistantMessage("done"));
				return stream;
			},
			{
				ledger,
				getAccountKey: (provider) => `${provider}#${activeAccount}`,
				getPolicy: () => ({ enabled: true, limits: {}, maxWaitMs: 1_000, foregroundLimitWaitMs: 1_000 }),
			},
		);

		try {
			const stream = await startPlannedAgentProviderRequest(
				{
					systemPrompt: "",
					messages: [{ role: "user", content: "hello", timestamp: 1 }],
				},
				{
					model,
					convertToLlm: harness.agent.convertToLlm,
					resolveProviderRequestAuth: (requestModel) => ({
						apiKey: "credential-a",
						headers: { Authorization: "Bearer credential-a" },
						credentialHeaders: { "x-account-route": activeCredentialHeader },
						providerAccountKey: `${requestModel.provider}#${activeAccount}`,
					}),
					onProviderRequestSnapshot: (request) => {
						expect(request.providerAccountKey).toBe(accountA);
						activeAccount = "account-b";
						activeCredentialHeader = "header-b";
					},
				},
				undefined,
				wrapped,
			);
			await stream.result();
		} finally {
			ledger.releaseAll();
			await harness.cleanup();
		}
	});

	it("gives direct tool probes the same frozen auth projection as planned requests", async () => {
		const harness = createHarness();
		const captured: Array<{
			apiKey?: string;
			headers?: Record<string, string>;
			credentialHeaders?: Record<string, string>;
			providerAccountKey?: string;
		}> = [];
		harness.agent.resolveProviderRequestAuth = () => ({
			apiKey: "credential-a",
			headers: { Authorization: "Bearer credential-a" },
			credentialHeaders: { "x-account-route": "header-a" },
			providerAccountKey: "faux#account-a",
		});
		harness.agent.streamFn = (_model, context, options) => {
			captured.push(options ?? {});
			const path = /path exactly "([^"]+)"/.exec(context.systemPrompt ?? "")?.[1];
			if (!path) throw new Error("native probe path missing");
			const stream = createAssistantMessageEventStream();
			stream.end({
				...fauxAssistantMessage(""),
				content: [{ type: "toolCall", id: "probe", name: "read", arguments: { path } }],
				stopReason: "toolUse",
			});
			return stream;
		};
		const controller = new ToolProtocolController({
			agent: harness.agent,
			agentDir: harness.tempDir,
			settingsManager: harness.settingsManager,
			getModelRegistry: () => harness.session.modelRegistry,
			adaptationStore: ModelAdaptationStore.forAgentDir(harness.tempDir),
			isRawStreamSimple: () => false,
			getRequiredRequestAuth: async () => ({ apiKey: "live-credential-b" }),
			addSpawnedUsage: () => undefined,
			emitWarning: () => {},
			sendCorrectiveSteer: async () => {},
			findLastAssistantMessage: () => undefined,
			buildToolFreeSystemPrompt: (suffix) => suffix,
			isDisposed: () => false,
			probeForAuto: async () => ({ model: "faux/faux-1", verdict: "inconclusive" }),
		});

		try {
			expect(await controller.probeToolCallingForModel(fauxModel)).toMatchObject({ verdict: "native" });
			expect(captured[0]).toMatchObject({
				apiKey: "credential-a",
				headers: { Authorization: "Bearer credential-a" },
				credentialHeaders: { "x-account-route": "header-a" },
				providerAccountKey: "faux#account-a",
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("refuses OAuth recovery that crosses the request-frozen account", () => {
		const provider = "openai-codex";
		const accountA = `${provider}#account-a`;
		const sameAccount = AuthStorage.inMemory({
			[provider]: {
				type: "oauth",
				access: "rotated-a",
				refresh: "refresh-a",
				expires: Date.now() + 60_000,
				accountId: "account-a",
			},
		});
		const otherAccount = AuthStorage.inMemory({
			[provider]: {
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 60_000,
				accountId: "account-b",
			},
		});
		expect(fenceRecoveredProviderApiKey(sameAccount, provider, "rotated-a", accountA)).toBe("rotated-a");
		expect(fenceRecoveredProviderApiKey(otherAccount, provider, "access-b", accountA)).toBeUndefined();
	});
});
