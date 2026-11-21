import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	createEmptyUsage,
	type Model,
} from "@caupulican/pi-ai";
import { expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ForegroundRecoveryController } from "../src/core/foreground-recovery-controller.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { AccountModelCatalog } from "../src/core/model-router/account-models.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type FailureCase = {
	label: string;
	failure: "unsupported" | "billing";
	remove?: boolean;
	differentProvider?: boolean;
	matching?: boolean;
	subscription?: boolean;
	opaqueMiddleware?: boolean;
	changeOnFallback?: "account" | "model";
	enableHeaderHook?: boolean;
};
const cases: FailureCase[] = [
	{ label: "registered refused model", failure: "unsupported" },
	{
		label: "header hook installed after a real refusal",
		failure: "unsupported",
		matching: true,
		enableHeaderHook: true,
	},
	{ label: "unverified middleware error", failure: "unsupported", opaqueMiddleware: true },
	{ label: "account changed by model_select", failure: "unsupported", matching: true, changeOnFallback: "account" },
	{ label: "model changed by model_select", failure: "unsupported", matching: true, changeOnFallback: "model" },
	{ label: "removed refused model", failure: "unsupported", remove: true },
	{ label: "removed refused current model", failure: "unsupported", remove: true, matching: true },
	{
		label: "removed refused provider with same model id",
		failure: "unsupported",
		remove: true,
		differentProvider: true,
	},
	{ label: "registered refused provider with same model id", failure: "unsupported", differentProvider: true },
	{ label: "registered quota failure after selection", failure: "billing", subscription: true },
	{ label: "removed quota failure after selection", failure: "billing", remove: true },
	{ label: "current subscription quota failure", failure: "billing", subscription: true, matching: true },
];
const providerA = "late-failure-fixture-a";
const providerB = "late-failure-fixture-b";
const modelIdA = "shared-model";
const fallbackId = "fallback-model";
const definition = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text" as const],
	contextWindow: 131072,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const modelRef = (model: Model<Api>) => `${model.provider}/${model.id}`;

it.each(cases)(
	"keeps foreground failure identity for $label",
	async (testCase) => {
		const root = mkdtempSync(join(tmpdir(), "pi-foreground-late-failure-"));
		const agentDir = join(root, "agent");
		const network = vi.fn(async () => {
			throw new Error("Offline model failure fixture has no transport");
		});
		vi.stubGlobal("fetch", network);
		const authStorage = AuthStorage.inMemory();
		if (testCase.subscription)
			authStorage.set(providerA, {
				type: "oauth",
				access: "synthetic-subscription-access",
				refresh: "synthetic-subscription-refresh",
				expires: Date.now() + 86_400_000,
			});
		const registry = ModelRegistry.create(authStorage, join(root, "models.json"));
		let dispatch: (model: Model<Api>) => AssistantMessageEventStream;
		const config = (ids: string[]) => ({
			baseUrl: "https://late-failure.invalid/v1",
			api: "openai-completions" as const,
			apiKey: "synthetic-never-dispatched",
			models: ids.map(definition),
			streamSimple: (model: Model<Api>) => dispatch(model),
			...(testCase.subscription
				? {
						oauth: {
							name: "Inert offline subscription",
							isSubscription: true,
							login: async () => {
								throw new Error("No login in offline fixture");
							},
							refreshToken: async () => {
								throw new Error("No token refresh in offline fixture");
							},
							getApiKey: (stored: { access: string }) => stored.access,
						},
					}
				: {}),
		});
		registry.registerProvider(providerA, config([modelIdA, "selected-model", fallbackId]));
		if (testCase.differentProvider) registry.registerProvider(providerB, config([modelIdA]));
		const requestModel = registry.find(providerA, modelIdA)!;
		const selectedModel: Model<Api> = {
			...(testCase.matching
				? requestModel
				: registry.find(
						testCase.differentProvider ? providerB : providerA,
						testCase.differentProvider ? modelIdA : "selected-model",
					)!),
			serviceTiers: [{ id: "fast", name: "Fast", description: "Synthetic advertised tier" }],
		};
		const settingsManager = SettingsManager.inMemory({
			modelFavorites: registry
				.getAll()
				.filter((model) => model.provider === providerA || model.provider === providerB)
				.map((model) => ({ provider: model.provider, modelId: model.id })),
			memorySystem: "okf",
			contextPolicy: { memory: { enabled: false, includeInPrompt: false } },
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
			systemOne: { enabled: false },
			modelCapability: { mode: "off" },
			failover: { subscriptionHop: true },
			modelRouter: { enabled: false, selectionMode: "manual", expensiveModel: `${providerA}/${fallbackId}` },
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
		});
		let onFallback: (() => Promise<void>) | undefined;
		let installHeaderHook: (() => void) | undefined;
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			installMissingPackages: false,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => {
					if (testCase.changeOnFallback)
						pi.on("model_select", (event) => (event.model.id === fallbackId ? onFallback?.() : undefined));
					if (testCase.enableHeaderHook)
						installHeaderHook = () =>
							pi.on("before_provider_headers", (event) => {
								event.headers.Authorization = "Bearer synthetic-alternate-key";
							});
				},
			],
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			settingsManager,
			resourceLoader: loader,
			authStorage,
			modelRegistry: registry,
			model: requestModel,
			isExplicitModel: true,
			systemOneEnabled: false,
			noTools: "all",
			tools: [],
			routerPool: {
				source: "sdk_models",
				models: registry
					.getAll()
					.filter((model) => model.provider === providerA || model.provider === providerB)
					.map((model) => ({ model })),
			},
		});
		const reached = Promise.withResolvers<void>();
		const calls: string[] = [];
		let finish: (() => void) | undefined;
		const provider = (used: Model<Api>) => {
			calls.push(modelRef(used));
			const message: AssistantMessage = {
				role: "assistant",
				api: used.api,
				provider: used.provider,
				model: used.id,
				content: [],
				stopReason: "error",
				timestamp: Date.now(),
				usage: createEmptyUsage(),
				errorMessage: testCase.failure === "unsupported" ? "model_not_supported" : "quota exceeded",
			};
			const stream = new AssistantMessageEventStream();
			if (calls.length > 1) {
				const final: AssistantMessage = {
					...message,
					content: [{ type: "text", text: "Synthetic fallback answer" }],
					stopReason: "stop",
					errorMessage: undefined,
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: final });
					stream.push({ type: "done", reason: "stop", message: final });
					stream.end();
				});
			} else {
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					reached.resolve();
				});
				finish = () => {
					stream.push({ type: "error", reason: "error", error: message });
					stream.end();
				};
			}
			return stream;
		};
		dispatch = provider;
		if (testCase.opaqueMiddleware) session.agent.streamFn = provider;
		const catalog = Object.getOwnPropertyDescriptor(session, "_accountModels")!.value as AccountModelCatalog;
		let observedSwitches = 0;
		const ownerModel = registry.find(providerA, "selected-model")!;
		const fallback = registry.find(providerA, fallbackId)!;
		if (testCase.changeOnFallback) {
			vi.spyOn(catalog, "accountDefault").mockReturnValue(fallback);
			onFallback = async () => {
				observedSwitches++;
				if (testCase.changeOnFallback === "model") await session.setModel(ownerModel, { persistSettings: false });
				else {
					authStorage.setRuntimeApiKey(providerA, "synthetic-new-account");
					await session.refreshModelsAfterAuthChange(providerA);
				}
			};
		}
		if (testCase.changeOnFallback || testCase.enableHeaderHook) await session.bindExtensions({});
		const foreground = Object.getOwnPropertyDescriptor(session, "_foregroundRecovery")!
			.value as ForegroundRecoveryController;
		let promptDone = false;
		const pending = session.prompt("Return the synthetic failure witness.").finally(() => {
			promptDone = true;
		});
		try {
			await reached.promise;
			await session.setModel(selectedModel, { persistSettings: false });
			await nextTurn();
			expect(promptDone).toBe(false);
			expect(modelRef(session.model!)).toBe(modelRef(selectedModel));
			if (testCase.remove) registry.registerProvider(providerA, config(["selected-model", fallbackId]));
			expect(Boolean(registry.find(providerA, modelIdA))).toBe(!testCase.remove);
			finish!();
			finish = undefined;
			await pending;
			await session.waitForForegroundIdle();
			if (testCase.changeOnFallback) {
				expect(observedSwitches).toBe(1);
				expect(modelRef(session.model!)).toBe(
					modelRef(testCase.changeOnFallback === "model" ? ownerModel : fallback),
				);
				expect(calls).toEqual([modelRef(requestModel)]);
			} else if (testCase.failure === "unsupported") {
				expect(catalog.unavailableCause(requestModel)).toBe(
					testCase.opaqueMiddleware || testCase.remove ? undefined : "model_account_refused",
				);
				expect(catalog.unavailableCause(selectedModel)).toBe(
					testCase.matching && !testCase.remove ? "model_account_refused" : undefined,
				);
				expect(modelRef(session.model!)).toBe(modelRef(selectedModel));
				expect(calls).toEqual([modelRef(requestModel)]);
				expect(session.getFastModeCatalog(selectedModel).tiers).toEqual(
					testCase.matching && !testCase.remove ? [] : selectedModel.serviceTiers,
				);
				if (testCase.remove) {
					registry.registerProvider(providerA, config([modelIdA, "selected-model", fallbackId]));
					await session.refreshModelsAfterAuthChange(providerA);
					expect(catalog.unavailableCause(registry.find(providerA, modelIdA)!)).toBe("model_account_refused");
				}
				if (testCase.enableHeaderHook) {
					expect(installHeaderHook).toBeTypeOf("function");
					installHeaderHook!();
					expect(catalog.unavailableCause(requestModel)).toBeUndefined();
					expect(session.getFastModeCatalog(selectedModel).tiers).toEqual(selectedModel.serviceTiers);
					await session.prompt("Try the newly configured request.");
					expect(calls).toEqual([modelRef(requestModel), modelRef(requestModel)]);
				}
			} else {
				expect(foreground.isModelExhausted(modelRef(requestModel))).toBe(true);
				expect(foreground.isModelExhausted(modelRef(selectedModel))).toBe(Boolean(testCase.matching));
				expect(modelRef(session.model!)).toBe(
					testCase.matching ? `${providerA}/${fallbackId}` : modelRef(selectedModel),
				);
				if (!testCase.matching) expect(calls).toEqual([modelRef(requestModel)]);
				else expect(calls).toContain(`${providerA}/${fallbackId}`);
			}
			expect(network).not.toHaveBeenCalled();
		} finally {
			finish?.();
			await session.abort("offline foreground failure fixture closes", { ordinaryWork: "preserve" });
			await session.disposeAndWait();
			registry.unregisterProviders([providerA, providerB]);
			rmSync(root, { recursive: true, force: true });
			vi.unstubAllGlobals();
		}
	},
	30_000,
);
