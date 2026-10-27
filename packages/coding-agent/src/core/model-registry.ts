/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */

import { registerApiProvider, unregisterApiProviders } from "@caupulican/pi-ai/api-registry";
import { getEnvAuthHeaders } from "@caupulican/pi-ai/env-api-keys";
import { getModels, getProviders } from "@caupulican/pi-ai/models";
import { type OAuthProviderInterface, registerOAuthProvider, unregisterOAuthProviders } from "@caupulican/pi-ai/oauth";
import type {
	AnthropicMessagesCompat,
	Api,
	KnownProvider,
	Model,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	SimpleStreamOptions,
} from "@caupulican/pi-ai/types";
import { formatValidationPath } from "@caupulican/pi-ai/validation-path";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { Compile } from "typebox/compile";
import { isDeepStrictEqual } from "util";
import { getAgentDir } from "../config.ts";
import { warnDeprecation } from "../utils/deprecation.ts";
import { stripJsonComments } from "../utils/json.ts";
import { normalizePath } from "../utils/paths.ts";
import type { AuthStatus, AuthStorage, OAuthCredential } from "./auth-storage.ts";
import type {
	ModelRegistryContract,
	ModelRegistryReloadSnapshot,
	ProviderConfigInput,
	ResolvedRequestAuth,
} from "./model-registry-contract.ts";
import {
	type ModelOverride,
	type ModelsConfig,
	ModelsConfigSchema,
	type ProviderOverride,
	type ProviderRequestConfig,
} from "./models-config-schema.ts";
import { resolveProviderAccountKey } from "./provider-admission/account-key.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";
import { hasAuthenticationHeaders, hasUsableRequestAuth } from "./request-auth.ts";
import {
	clearConfigValueCache,
	getCachedConfigValue,
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	isLegacyEnvVarNameConfigValue,
	resolveConfigValue,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";
import { isCredentialSecretKey } from "./secrets/credential-content-mock.ts";

// Schema for custom model definition
const DEFAULT_MODEL_CONTEXT_WINDOW = 128000;
const DEFAULT_MODEL_MAX_TOKENS = 16384;
/**
 * Context window, tool-call transport and output cap of a user-configured model definition. A value
 * the definition does not declare is filled with a default AND marked as such, so lane-worker
 * eligibility can tell a declared window / tool-call path from a placeholder.
 */
function resolveModelLimitsAndToolCalling(modelDef: {
	contextWindow?: number;
	textToolCallProtocol?: boolean;
	maxTokens?: number;
}): Pick<
	Model<Api>,
	"contextWindow" | "contextWindowDefaulted" | "textToolCallProtocol" | "toolCallingUndeclared" | "maxTokens"
> {
	return {
		contextWindow: modelDef.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
		...(modelDef.contextWindow === undefined ? { contextWindowDefaulted: true } : {}),
		textToolCallProtocol: modelDef.textToolCallProtocol,
		...(modelDef.textToolCallProtocol === undefined ? { toolCallingUndeclared: true } : {}),
		maxTokens: modelDef.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
	};
}
const validateModelsConfig = Compile(ModelsConfigSchema);

function migrateLegacyRegisterProviderConfigValue(providerName: string, field: string, value: string): string {
	if (!isLegacyEnvVarNameConfigValue(value)) return value;
	warnDeprecation(
		`registerProvider("${providerName}") ${field} value "${value}" is treated as a legacy environment variable reference. This will no longer be detected as an environment variable reference in a future release. Pass "$${value}" instead.`,
	);
	return `$${value}`;
}

function migrateLegacyRegisterProviderHeaders(
	providerName: string,
	field: string,
	headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	let migratedHeaders: Record<string, string> | undefined;
	for (const [key, value] of Object.entries(headers)) {
		const migratedValue = migrateLegacyRegisterProviderConfigValue(providerName, `${field} header "${key}"`, value);
		if (migratedValue === value) continue;
		migratedHeaders ??= { ...headers };
		migratedHeaders[key] = migratedValue;
	}
	return migratedHeaders ?? headers;
}

function migrateLegacyRegisterProviderConfigValues(
	providerName: string,
	config: ProviderConfigInput,
): ProviderConfigInput {
	let migratedConfig: ProviderConfigInput | undefined;

	const setMigratedConfigValue = <TKey extends keyof ProviderConfigInput>(
		key: TKey,
		value: ProviderConfigInput[TKey],
	) => {
		migratedConfig ??= { ...config };
		migratedConfig[key] = value;
	};

	if (config.apiKey) {
		const apiKey = migrateLegacyRegisterProviderConfigValue(providerName, "apiKey", config.apiKey);
		if (apiKey !== config.apiKey) {
			setMigratedConfigValue("apiKey", apiKey);
		}
	}

	const headers = migrateLegacyRegisterProviderHeaders(providerName, "headers", config.headers);
	if (headers !== config.headers) {
		setMigratedConfigValue("headers", headers);
	}

	if (config.models) {
		let models: ProviderConfigInput["models"] | undefined;
		for (let index = 0; index < config.models.length; index++) {
			const model = config.models[index];
			const modelHeaders = migrateLegacyRegisterProviderHeaders(
				providerName,
				`model "${model.id}" headers`,
				model.headers,
			);
			if (modelHeaders === model.headers) continue;
			models ??= [...config.models];
			models[index] = { ...model, headers: modelHeaders };
		}
		if (models) {
			setMigratedConfigValue("models", models);
		}
	}

	return migratedConfig ?? config;
}

/** Result of loading custom models from models.json */
interface CustomModelsResult {
	models: Model<Api>[];
	/** Providers with baseUrl/headers/apiKey overrides for built-in models */
	overrides: Map<string, ProviderOverride>;
	/** Per-model overrides: provider -> modelId -> override */
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	error: string | undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
	return { models: [], overrides: new Map(), modelOverrides: new Map(), error };
}

function mergeCompat(
	baseCompat: Model<Api>["compat"],
	overrideCompat: ModelOverride["compat"],
): Model<Api>["compat"] | undefined {
	if (!overrideCompat) return baseCompat;

	const base = baseCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat | undefined;
	const override = overrideCompat as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
	const merged = { ...base, ...override } as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;

	const baseCompletions = base as OpenAICompletionsCompat | undefined;
	const overrideCompletions = override as OpenAICompletionsCompat;
	const mergedCompletions = merged as OpenAICompletionsCompat;

	if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
		mergedCompletions.openRouterRouting = {
			...baseCompletions?.openRouterRouting,
			...overrideCompletions.openRouterRouting,
		};
	}

	if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
		mergedCompletions.vercelGatewayRouting = {
			...baseCompletions?.vercelGatewayRouting,
			...overrideCompletions.vercelGatewayRouting,
		};
	}

	return merged as Model<Api>["compat"];
}

/**
 * Deep merge a model override into a model.
 * Handles nested objects (cost, compat) by merging rather than replacing.
 */
function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	const result = { ...model };

	// Simple field overrides
	if (override.name !== undefined) result.name = override.name;
	if (override.reasoning !== undefined) result.reasoning = override.reasoning;
	if (override.defaultThinkingLevel !== undefined) result.defaultThinkingLevel = override.defaultThinkingLevel;
	if (override.thinkingLevelMap !== undefined) {
		result.thinkingLevelMap = { ...model.thinkingLevelMap, ...override.thinkingLevelMap };
	}
	if (override.input !== undefined) result.input = override.input as ("text" | "image")[];
	if (override.contextWindow !== undefined) {
		result.contextWindow = override.contextWindow;
		delete result.contextWindowDefaulted;
	}
	if (override.textToolCallProtocol !== undefined) {
		result.textToolCallProtocol = override.textToolCallProtocol;
		delete result.toolCallingUndeclared;
	}
	if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;
	if (override.samplingParams !== undefined) {
		result.samplingParams = { ...model.samplingParams, ...override.samplingParams };
	}

	// Merge cost (partial override)
	if (override.cost) {
		result.cost = {
			input: override.cost.input ?? model.cost.input,
			output: override.cost.output ?? model.cost.output,
			cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
			cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
			tiers: override.cost.tiers ?? model.cost.tiers,
		};
	}

	// Deep merge compat
	result.compat = mergeCompat(model.compat, override.compat);

	return result;
}

/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;
let nextModelRegistryId = 1;

/**
 * Resolves a renamed `:free` catalog model ID when upstream changes a vendor family's free-tier
 * variant suffix (e.g. `inclusionai/ling-3.0-flash-fin:free` -> `inclusionai/ling-3.0-flash-sante:free`).
 * Only activates for `:free` references and only resolves to another `:free` model in the same family.
 */
export function findRenamedFreeTierModel(
	models: readonly Model<Api>[],
	provider: string | undefined,
	modelId: string,
): Model<Api> | undefined {
	const normalizedId = modelId.trim().toLowerCase();
	if (!normalizedId.endsWith(":free")) return undefined;
	const baseId = normalizedId.slice(0, -":free".length);
	if (!baseId) return undefined;
	const lastSlashIndex = baseId.lastIndexOf("/");
	const lastDashIndex = baseId.lastIndexOf("-");
	if (lastDashIndex <= lastSlashIndex + 1) return undefined;
	const familyPrefix = baseId.slice(0, lastDashIndex + 1);
	const providerNorm = provider?.trim().toLowerCase();
	const candidates = providerNorm
		? models.filter((m) => m.kind !== "judge" && m.provider.toLowerCase() === providerNorm)
		: models.filter((m) => m.kind !== "judge");
	const siblingFree = candidates.filter((m) => {
		const id = m.id.toLowerCase();
		if (!id.startsWith(familyPrefix) || !id.endsWith(":free")) return false;
		const variantSuffix = id.slice(familyPrefix.length, -":free".length);
		return variantSuffix.length > 0 && !variantSuffix.includes("/");
	});
	return siblingFree.length === 1 ? siblingFree[0] : undefined;
}

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry implements ModelRegistryContract {
	private readonly integrationSourcePrefix = `model-registry:${nextModelRegistryId++}:`;
	private readonly integrationSources = new Set<string>();
	private readonly oauthIntegrationProviders = new Set<string>();
	private baseModels: Model<Api>[] = [];
	private models: Model<Api>[] = [];
	private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
	private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
	private registeredProviders: Map<string, ProviderConfigInput> = new Map();
	private providerModelScopes: Map<string, Set<string>> = new Map();
	private syncedOAuthCredentials: Map<string, OAuthCredential | undefined> = new Map();
	private loadError: string | undefined = undefined;
	readonly authStorage: AuthStorage;
	private modelsJsonPath: string | undefined;

	private constructor(authStorage: AuthStorage, modelsJsonPath: string | undefined) {
		this.authStorage = authStorage;
		this.modelsJsonPath = modelsJsonPath ? normalizePath(modelsJsonPath) : undefined;
		this.loadModels();
	}

	static create(authStorage: AuthStorage, modelsJsonPath: string = join(getAgentDir(), "models.json")): ModelRegistry {
		return new ModelRegistry(authStorage, modelsJsonPath);
	}

	static inMemory(authStorage: AuthStorage): ModelRegistry {
		return new ModelRegistry(authStorage, undefined);
	}

	/**
	 * Reload models from disk (built-in + custom from models.json).
	 */
	refresh(): void {
		this.providerRequestConfigs.clear();
		this.modelRequestHeaders.clear();
		this.loadError = undefined;

		this.clearOwnedIntegrations();

		this.loadBaseModels();

		for (const [providerName, config] of this.registeredProviders.entries()) {
			this.applyProviderRequestConfig(providerName, config);
		}

		this.recomputeModels();
	}

	/**
	 * Get any error from loading models.json (undefined if no error).
	 */
	getError(): string | undefined {
		return this.loadError;
	}

	private loadModels(): void {
		this.loadBaseModels();
		this.recomputeModels();
	}

	private loadBaseModels(): void {
		// Load custom models and overrides from models.json
		const {
			models: customModels,
			overrides,
			modelOverrides,
			error,
		} = this.modelsJsonPath ? this.loadCustomModels(this.modelsJsonPath) : emptyCustomModelsResult();

		if (error) {
			this.loadError = error;
			// Keep built-in models even if custom models failed to load
		}

		const builtInModels = this.loadBuiltInModels(overrides, modelOverrides);
		this.baseModels = this.mergeCustomModels(builtInModels, customModels);
	}

	private computeModels(registeredProviders: ReadonlyMap<string, ProviderConfigInput>): {
		models: Model<Api>[];
		synced: Map<string, OAuthCredential | undefined>;
	} {
		let models = cloneModels(this.baseModels);
		const synced = new Map<string, OAuthCredential | undefined>();
		for (const oauthProvider of this.authStorage.getOAuthProviders()) {
			if (!oauthProvider.modifyModels) continue;
			if (
				this.oauthIntegrationProviders.has(oauthProvider.id) ||
				registeredProviders.get(oauthProvider.id)?.oauth !== undefined
			) {
				continue;
			}
			const cred = this.authStorage.get(oauthProvider.id);
			const oauthCred = cred?.type === "oauth" ? cred : undefined;
			const clonedCred = oauthCred ? structuredClone(oauthCred) : undefined;
			if (clonedCred) {
				models = cloneModels(oauthProvider.modifyModels(cloneModels(models), structuredClone(clonedCred)));
			}
			synced.set(oauthProvider.id, clonedCred);
		}
		for (const [providerName, config] of registeredProviders.entries()) {
			models = this.applyRegisteredProviderModels(models, providerName, config, synced);
		}
		return { models, synced };
	}

	private recomputeModels(): void {
		const { models, synced } = this.computeModels(this.registeredProviders);
		this.models = models;
		this.syncedOAuthCredentials = synced;
	}

	private isProviderOAuthUnsynced(providerId: string, activeModifierIds: Set<string>): boolean {
		activeModifierIds.add(providerId);
		const cred = this.authStorage.get(providerId);
		const oauthCred = cred?.type === "oauth" ? cred : undefined;
		if (!this.syncedOAuthCredentials.has(providerId)) {
			return oauthCred !== undefined;
		}
		return !isDeepStrictEqual(this.syncedOAuthCredentials.get(providerId), oauthCred);
	}

	private hasUnsyncedOAuthModels(): boolean {
		const activeModifierIds = new Set<string>();
		for (const oauthProvider of this.authStorage.getOAuthProviders()) {
			if (!oauthProvider.modifyModels) continue;
			if (
				this.oauthIntegrationProviders.has(oauthProvider.id) ||
				this.registeredProviders.get(oauthProvider.id)?.oauth !== undefined
			) {
				continue;
			}
			if (this.isProviderOAuthUnsynced(oauthProvider.id, activeModifierIds)) return true;
		}
		for (const [providerName, config] of this.registeredProviders.entries()) {
			if (!config.oauth?.modifyModels) continue;
			if (this.isProviderOAuthUnsynced(providerName, activeModifierIds)) return true;
		}
		for (const [providerId, syncedCred] of this.syncedOAuthCredentials.entries()) {
			if (!activeModifierIds.has(providerId) && syncedCred !== undefined) {
				return true;
			}
		}
		return false;
	}

	/** Keep provider models in sync when AuthStorage refreshes or replaces OAuth credentials. */
	private syncOAuthModels(): void {
		if (!this.hasUnsyncedOAuthModels()) return;
		this.recomputeModels();
	}

	/** Load built-in models and apply provider/model overrides */
	private loadBuiltInModels(
		overrides: Map<string, ProviderOverride>,
		modelOverrides: Map<string, Map<string, ModelOverride>>,
	): Model<Api>[] {
		return getProviders().flatMap((provider) => {
			const models = getModels(provider as KnownProvider) as Model<Api>[];
			const providerOverride = overrides.get(provider);
			const perModelOverrides = modelOverrides.get(provider);

			return models.map((m) => {
				let model = m;

				// Apply provider-level baseUrl/headers/compat override
				if (providerOverride) {
					model = {
						...model,
						baseUrl: providerOverride.baseUrl ?? model.baseUrl,
						compat: mergeCompat(model.compat, providerOverride.compat),
					};
				}

				// Apply per-model override
				const modelOverride = perModelOverrides?.get(m.id);
				if (modelOverride) {
					model = applyModelOverride(model, modelOverride);
				}

				return model;
			});
		});
	}

	/** Merge custom models into built-in list by provider+id (custom wins on conflicts). */
	private mergeCustomModels(builtInModels: Model<Api>[], customModels: Model<Api>[]): Model<Api>[] {
		const merged = [...builtInModels];
		for (const customModel of customModels) {
			const existingIndex = merged.findIndex((m) => m.provider === customModel.provider && m.id === customModel.id);
			if (existingIndex >= 0) {
				merged[existingIndex] = customModel;
			} else {
				merged.push(customModel);
			}
		}
		return merged;
	}

	private loadCustomModels(modelsJsonPath: string): CustomModelsResult {
		if (!existsSync(modelsJsonPath)) {
			return emptyCustomModelsResult();
		}

		try {
			const content = readFileSync(modelsJsonPath, "utf-8");
			const parsed = JSON.parse(stripJsonComments(content)) as unknown;

			if (!validateModelsConfig.Check(parsed)) {
				const errors =
					validateModelsConfig
						.Errors(parsed)
						.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
						.join("\n") || "Unknown schema error";
				return emptyCustomModelsResult(`Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`);
			}

			const config = parsed as ModelsConfig;

			// Additional validation
			this.validateConfig(config);

			const overrides = new Map<string, ProviderOverride>();
			const modelOverrides = new Map<string, Map<string, ModelOverride>>();

			for (const [providerName, providerConfig] of Object.entries(config.providers)) {
				if (providerConfig.baseUrl || providerConfig.compat) {
					overrides.set(providerName, {
						baseUrl: providerConfig.baseUrl,
						compat: providerConfig.compat,
					});
				}

				this.storeProviderRequestConfig(providerName, providerConfig);

				if (providerConfig.modelOverrides) {
					modelOverrides.set(providerName, new Map(Object.entries(providerConfig.modelOverrides)));
					for (const [modelId, modelOverride] of Object.entries(providerConfig.modelOverrides)) {
						this.storeModelHeaders(providerName, modelId, modelOverride.headers);
					}
				}
			}

			return { models: this.parseModels(config), overrides, modelOverrides, error: undefined };
		} catch (error) {
			if (error instanceof SyntaxError) {
				return emptyCustomModelsResult(`Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`);
			}
			return emptyCustomModelsResult(
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`,
			);
		}
	}

	private validateConfig(config: ModelsConfig): void {
		const builtInProviders = new Set<string>(getProviders());

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const isBuiltIn = builtInProviders.has(providerName);
			const hasProviderApi = !!providerConfig.api;
			const models = providerConfig.models ?? [];
			const hasModelOverrides =
				providerConfig.modelOverrides && Object.keys(providerConfig.modelOverrides).length > 0;

			if (models.length === 0) {
				// Override-only config: needs baseUrl, headers, compat, modelOverrides, or some combination.
				if (!providerConfig.baseUrl && !providerConfig.headers && !providerConfig.compat && !hasModelOverrides) {
					throw new Error(
						`Provider ${providerName}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
					);
				}
			} else if (!isBuiltIn) {
				// Non-built-in providers with custom models require endpoint + auth.
				if (!providerConfig.baseUrl) {
					throw new Error(`Provider ${providerName}: "baseUrl" is required when defining custom models.`);
				}
				if (!providerConfig.apiKey) {
					throw new Error(`Provider ${providerName}: "apiKey" is required when defining custom models.`);
				}
			}
			// Built-in providers with custom models: baseUrl/apiKey/api are optional,
			// inherited from built-in models. Auth comes from env vars / auth storage.

			for (const modelDef of models) {
				const hasModelApi = !!modelDef.api;

				if (!hasProviderApi && !hasModelApi && !isBuiltIn) {
					throw new Error(
						`Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
					);
				}
				// For built-in providers, api is optional — inherited from built-in models.

				if (!modelDef.id) throw new Error(`Provider ${providerName}: model missing "id"`);
				// Validate contextWindow/maxTokens only if provided (they have defaults)
				if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0)
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
				if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0)
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
			}
		}
	}

	private parseModels(config: ModelsConfig): Model<Api>[] {
		const models: Model<Api>[] = [];
		const builtInProviders = new Set<string>(getProviders());

		// Cache built-in defaults (api, baseUrl) per provider, extracted from first model.
		const builtInDefaultsCache = new Map<string, { api: string; baseUrl: string }>();
		const getBuiltInDefaults = (providerName: string): { api: string; baseUrl: string } | undefined => {
			if (!builtInProviders.has(providerName)) return undefined;
			if (builtInDefaultsCache.has(providerName)) return builtInDefaultsCache.get(providerName);
			const builtIn = getModels(providerName as KnownProvider) as Model<Api>[];
			if (builtIn.length === 0) return undefined;
			const defaults = { api: builtIn[0].api, baseUrl: builtIn[0].baseUrl };
			builtInDefaultsCache.set(providerName, defaults);
			return defaults;
		};

		for (const [providerName, providerConfig] of Object.entries(config.providers)) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models

			const builtInDefaults = getBuiltInDefaults(providerName);

			for (const modelDef of modelDefs) {
				const api = modelDef.api ?? providerConfig.api ?? builtInDefaults?.api;
				if (!api) continue;

				const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInDefaults?.baseUrl;
				if (!baseUrl) continue;

				const compat = mergeCompat(providerConfig.compat, modelDef.compat);
				this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

				const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
				models.push({
					id: modelDef.id,
					name: modelDef.name ?? modelDef.id,
					api: api as Api,
					provider: providerName,
					baseUrl,
					reasoning: modelDef.reasoning ?? false,
					defaultThinkingLevel: modelDef.defaultThinkingLevel,
					thinkingLevelMap: modelDef.thinkingLevelMap,
					input: (modelDef.input ?? ["text"]) as ("text" | "image")[],
					cost: modelDef.cost ?? defaultCost,
					...resolveModelLimitsAndToolCalling(modelDef),
					samplingParams: modelDef.samplingParams,
					headers: undefined,
					compat,
				} as Model<Api>);
			}
		}

		return models;
	}

	/**
	 * Get all conversational models (built-in + custom). System One engines (`kind: "judge"`) are not
	 * listed: nothing may allocate a conversation to one, and `find` still resolves them by id.
	 * If models.json had errors, returns only built-in models.
	 */
	getAll(): Model<Api>[] {
		this.syncOAuthModels();
		return this.models.filter((m) => m.kind !== "judge");
	}

	/** Known request credentials for the exposure boundary, without refreshing providers or running commands. */
	getKnownCredentialValues(): string[] {
		try {
			this.syncOAuthModels();
		} catch {}
		const providers = new Set([
			...this.models.map((model) => model.provider),
			...this.registeredProviders.keys(),
			...this.providerRequestConfigs.keys(),
		]);
		const values = new Set(this.authStorage.getKnownCredentialValues(providers));
		const addConfigValue = (configured: string | undefined): string | undefined => {
			if (!configured) return undefined;
			const resolved = isCommandConfigValue(configured)
				? getCachedConfigValue(configured)
				: resolveConfigValue(configured);
			if (resolved) values.add(resolved);
			return resolved;
		};
		const addHeaders = (headers: Record<string, string> | undefined): void => {
			if (!headers) return;
			for (const [name, value] of Object.entries(headers)) {
				if (!isCredentialSecretKey(name)) continue;
				const resolved = addConfigValue(value);
				const bearer = /^Bearer\s+(.+)$/iu.exec(resolved ?? "")?.[1];
				if (bearer) values.add(bearer);
			}
		};
		for (const config of this.providerRequestConfigs.values()) {
			addConfigValue(config.apiKey);
			addHeaders(config.headers);
		}
		for (const headers of this.modelRequestHeaders.values()) addHeaders(headers);
		for (const model of this.models) addHeaders(model.headers);
		return [...values];
	}

	/**
	 * Get only conversational models that have auth configured.
	 * This is a fast check that doesn't refresh OAuth tokens.
	 */
	getAvailable(): Model<Api>[] {
		return this.getAll().filter((m) => this.hasConfiguredAuth(m));
	}

	/** Restrict one provider to an exact, externally verified set of model IDs. */
	setProviderModelScope(provider: string, modelIds: Iterable<string> | undefined): void {
		if (modelIds === undefined) {
			this.providerModelScopes.delete(provider);
			return;
		}
		this.providerModelScopes.set(
			provider,
			new Set([...modelIds].map((id) => id.trim()).filter((id) => id.length > 0)),
		);
	}

	getProviderModelScope(provider: string): string[] | undefined {
		const scope = this.providerModelScopes.get(provider);
		return scope ? [...scope] : undefined;
	}

	/**
	 * Find a model by provider and ID, self-healing renamed `:free` catalog variants.
	 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		this.syncOAuthModels();
		const exact = this.models.find((m) => m.provider === provider && m.id === modelId);
		if (exact) return exact;
		return findRenamedFreeTierModel(this.models, provider, modelId);
	}

	/** Whether the provider's verified model scope, when one is set, offers this model. */
	isModelInProviderScope(model: Model<Api>): boolean {
		const scope = this.providerModelScopes.get(model.provider);
		return !scope || scope.has(model.id);
	}

	/**
	 * Get API key for a model.
	 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		if (!this.isModelInProviderScope(model)) return false;
		if (model.provider === "llama-cpp") {
			return true;
		}
		return this.hasCredential(model);
	}

	private hasCredential(model: Model<Api>): boolean {
		const providerApiKey = this.providerRequestConfigs.get(model.provider)?.apiKey;
		return (
			this.authStorage.hasAuth(model.provider) ||
			(providerApiKey !== undefined && isConfigValueConfigured(providerApiKey)) ||
			hasAuthenticationHeaders(model.headers)
		);
	}

	getAuthenticatedProviders(): string[] {
		this.syncOAuthModels();
		const providers = new Set<string>();
		for (const model of this.models) {
			if (!providers.has(model.provider) && this.hasCredential(model)) providers.add(model.provider);
		}
		return [...providers].sort((left, right) => left.localeCompare(right));
	}

	canUseResolvedRequestAuth(
		model: Model<Api>,
		auth: ResolvedRequestAuth,
	): auth is Extract<ResolvedRequestAuth, { ok: true }> {
		return auth.ok && (hasUsableRequestAuth(auth) || (!this.isUsingOAuth(model) && this.hasConfiguredAuth(model)));
	}

	private getModelRequestKey(provider: string, modelId: string): string {
		return `${provider}:${modelId}`;
	}

	private storeProviderRequestConfig(
		providerName: string,
		config: {
			apiKey?: string;
			headers?: Record<string, string>;
			authHeader?: boolean;
		},
	): void {
		if (!config.apiKey && !config.headers && !config.authHeader) {
			return;
		}

		this.providerRequestConfigs.set(providerName, {
			apiKey: config.apiKey,
			headers: config.headers,
			authHeader: config.authHeader,
		});
	}

	private storeModelHeaders(providerName: string, modelId: string, headers?: Record<string, string>): void {
		const key = this.getModelRequestKey(providerName, modelId);
		if (!headers || Object.keys(headers).length === 0) {
			this.modelRequestHeaders.delete(key);
			return;
		}
		this.modelRequestHeaders.set(key, headers);
	}

	/**
	 * Get API key and request headers for a model.
	 */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const providerConfig = this.providerRequestConfigs.get(model.provider);
			const apiKeyFromAuthStorage = await this.authStorage.getApiKey(model.provider, { includeFallback: false });
			try {
				this.syncOAuthModels();
			} catch {}
			const apiKey =
				apiKeyFromAuthStorage ??
				(providerConfig?.apiKey
					? resolveConfigValueOrThrow(providerConfig.apiKey, `API key for provider "${model.provider}"`)
					: undefined);

			const providerHeaders = resolveHeadersOrThrow(providerConfig?.headers, `provider "${model.provider}"`);
			const modelHeaders = resolveHeadersOrThrow(
				this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
				`model "${model.provider}/${model.id}"`,
			);

			const envAuthHeaders = getEnvAuthHeaders(model.provider);
			const hasSyncedOAuthModifier = this.syncedOAuthCredentials.has(model.provider);
			const syncedModel = hasSyncedOAuthModifier
				? this.models.find((m) => m.provider === model.provider && m.id === model.id)
				: undefined;
			const effectiveModelHeaders = hasSyncedOAuthModifier ? syncedModel?.headers : model.headers;
			let headers =
				envAuthHeaders || effectiveModelHeaders || providerHeaders || modelHeaders
					? { ...envAuthHeaders, ...effectiveModelHeaders, ...providerHeaders, ...modelHeaders }
					: undefined;

			if (providerConfig?.authHeader) {
				if (!apiKey) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				headers = { ...headers, Authorization: `Bearer ${apiKey}` };
			}

			const credentialHeaders = apiKeyFromAuthStorage
				? this.authStorage.getOAuthRequestHeaders(model.provider, apiKeyFromAuthStorage)
				: undefined;
			return {
				ok: true,
				apiKey,
				headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
				...(credentialHeaders ? { credentialHeaders } : {}),
				providerAccountKey: resolveProviderAccountKey(this.authStorage, model.provider, apiKey),
			};
		} catch (error) {
			try {
				this.syncOAuthModels();
			} catch {}
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/** Recover a locally stored OAuth credential rejected by the provider. */
	async recoverRejectedOAuthApiKey(providerId: string, rejectedApiKey: string): Promise<string | undefined> {
		try {
			const recovered = await this.authStorage.recoverRejectedOAuthApiKey(providerId, rejectedApiKey);
			try {
				this.syncOAuthModels();
			} catch {}
			return recovered;
		} catch (error) {
			try {
				this.syncOAuthModels();
			} catch {}
			throw error;
		}
	}

	/**
	 * Return auth status for a provider, including request auth configured in models.json.
	 * This intentionally does not execute command-backed config values.
	 */
	getProviderAuthStatus(provider: string): AuthStatus {
		const authStatus = this.authStorage.getAuthStatus(provider);
		if (authStatus.source) {
			return authStatus;
		}

		if (provider === "llama-cpp") {
			return { configured: true, source: "runtime", label: "no API key required" };
		}

		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		if (!providerApiKey) {
			return authStatus;
		}

		if (isCommandConfigValue(providerApiKey)) {
			return { configured: true, source: "models_json_command" };
		}

		const envVarNames = getConfigValueEnvVarNames(providerApiKey);
		if (envVarNames.length > 0) {
			return isConfigValueConfigured(providerApiKey)
				? { configured: true, source: "environment", label: envVarNames.join(", ") }
				: { configured: false };
		}

		return { configured: true, source: "models_json_key" };
	}

	/**
	 * Get display name for a provider.
	 */
	getProviderDisplayName(provider: string): string {
		const registeredProvider = this.registeredProviders.get(provider);
		const oauthProvider = this.authStorage.getOAuthProviders().find((p) => p.id === provider);

		return (
			registeredProvider?.name ??
			registeredProvider?.oauth?.name ??
			oauthProvider?.name ??
			BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ??
			provider
		);
	}

	/**
	 * Get API key for a provider.
	 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		if (provider === "llama-cpp") {
			return undefined;
		}
		let apiKey: string | undefined;
		try {
			apiKey = await this.authStorage.getApiKey(provider, { includeFallback: false });
		} catch (error) {
			try {
				this.syncOAuthModels();
			} catch {}
			throw error;
		}
		try {
			this.syncOAuthModels();
		} catch {}
		if (apiKey !== undefined) {
			return apiKey;
		}

		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		return providerApiKey ? resolveConfigValueUncached(providerApiKey) : undefined;
	}

	/**
	 * Check if a model is using OAuth credentials (subscription).
	 */
	isUsingOAuth(model: Model<Api>): boolean {
		const cred = this.authStorage.get(model.provider);
		return cred?.type === "oauth";
	}

	/**
	 * Check if a model is using OAuth credentials backed by an actual provider subscription
	 * (as opposed to OAuth that merely mints a permanent API key, e.g. OpenRouter).
	 */
	isUsingSubscription(model: Model<Api>): boolean {
		if (!this.isUsingOAuth(model)) return false;
		const oauthProvider = this.authStorage.getOAuthProviders().find((p) => p.id === model.provider);
		return oauthProvider?.isSubscription === true;
	}

	/**
	 * Register a provider dynamically (from extensions).
	 *
	 * If provider has models: replaces all existing models for this provider.
	 * If provider has only baseUrl/headers: overrides existing models' URLs.
	 * If provider has oauth: registers OAuth provider for /login support.
	 */
	registerProvider(providerName: string, config: ProviderConfigInput): void {
		const migratedConfig = migrateLegacyRegisterProviderConfigValues(providerName, config);
		this.validateProviderConfig(providerName, migratedConfig);
		const existing = this.registeredProviders.get(providerName);
		const mergedConfig = this.mergeRegisteredProviderConfig(providerName, migratedConfig);
		const nextRegisteredProviders = new Map(this.registeredProviders);
		nextRegisteredProviders.set(providerName, mergedConfig);
		const { models: nextModels, synced: nextSynced } = this.computeModels(nextRegisteredProviders);
		if (migratedConfig.models && migratedConfig.models.length > 0 && existing?.models) {
			for (const oldModel of existing.models) {
				if (!existing.modelOverrides?.[oldModel.id]?.headers) {
					this.storeModelHeaders(providerName, oldModel.id, undefined);
				}
			}
		}
		this.applyProviderRequestConfig(providerName, mergedConfig);
		this.registeredProviders = nextRegisteredProviders;
		this.models = nextModels;
		this.syncedOAuthCredentials = nextSynced;
	}

	/** Capture all mutable registry state before a runtime generation is rebuilt. */
	createReloadSnapshot(): ModelRegistryReloadSnapshot {
		return {
			baseModels: cloneModels(this.baseModels),
			models: cloneModels(this.models),
			providerRequestConfigs: new Map(
				Array.from(this.providerRequestConfigs, ([name, config]) => [name, { ...config }]),
			),
			modelRequestHeaders: new Map(Array.from(this.modelRequestHeaders, ([key, headers]) => [key, { ...headers }])),
			registeredProviders: new Map(
				Array.from(this.registeredProviders, ([name, config]) => [name, cloneProviderConfigInput(config)]),
			),
			providerModelScopes: new Map(
				Array.from(this.providerModelScopes, ([name, modelIds]) => [name, new Set(modelIds)]),
			),
			syncedOAuthCredentials: new Map(
				Array.from(this.syncedOAuthCredentials, ([name, cred]) => [name, cred ? structuredClone(cred) : undefined]),
			),
			loadError: this.loadError,
		};
	}

	/** Restore a captured generation, including global API/OAuth registrations. */
	restoreReloadSnapshot(snapshot: ModelRegistryReloadSnapshot): void {
		this.baseModels = cloneModels(snapshot.baseModels);
		this.models = cloneModels(snapshot.models);
		this.providerRequestConfigs = new Map(
			Array.from(snapshot.providerRequestConfigs, ([name, config]) => [name, { ...config }]),
		);
		this.modelRequestHeaders = new Map(
			Array.from(snapshot.modelRequestHeaders, ([key, headers]) => [key, { ...headers }]),
		);
		this.registeredProviders = new Map(
			Array.from(snapshot.registeredProviders, ([name, config]) => [name, cloneProviderConfigInput(config)]),
		);
		this.providerModelScopes = new Map(
			Array.from(snapshot.providerModelScopes, ([name, modelIds]) => [name, new Set(modelIds)]),
		);
		this.loadError = snapshot.loadError;

		this.clearOwnedIntegrations();
		for (const [providerName, config] of this.registeredProviders) {
			this.registerProviderIntegrations(providerName, config);
		}
		this.syncedOAuthCredentials = new Map(
			Array.from(snapshot.syncedOAuthCredentials, ([name, cred]) => [
				name,
				cred ? structuredClone(cred) : undefined,
			]),
		);
		this.syncOAuthModels();
	}

	/**
	 * Unregister a previously registered provider.
	 *
	 * Removes the provider from the registry and reloads models from disk so that
	 * built-in models overridden by this provider are restored to their original state.
	 * Also resets dynamic OAuth and API stream registrations before reapplying
	 * remaining dynamic providers.
	 * Has no effect if the provider was never registered.
	 */
	unregisterProvider(providerName: string): void {
		this.unregisterProviders([providerName]);
	}

	/** Remove a provider generation in one refresh so surviving dynamic streams remain registered. */
	unregisterProviders(providerNames: Iterable<string>): void {
		let changed = false;
		for (const providerName of providerNames) {
			changed = this.registeredProviders.delete(providerName) || changed;
		}
		if (changed) this.refresh();
	}

	/**
	 * Merge a provider config with any existing registered config for the same provider.
	 * Defined values in the incoming config override existing ones; undefined values are
	 * preserved from the stored config.
	 */
	private mergeRegisteredProviderConfig(providerName: string, config: ProviderConfigInput): ProviderConfigInput {
		const existing = this.registeredProviders.get(providerName);
		if (!existing) {
			return cloneProviderConfigInput(config);
		}
		const merged = cloneProviderConfigInput(existing);
		for (const k of Object.keys(config) as (keyof ProviderConfigInput)[]) {
			if (config[k] !== undefined) {
				(merged as Record<string, unknown>)[k] = config[k];
			}
		}
		if (config.models === undefined && config.baseUrl !== undefined && merged.models) {
			merged.models = merged.models.map((model) => ({ ...model, baseUrl: config.baseUrl }));
		}
		return cloneProviderConfigInput(merged);
	}

	private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		if (!config.models || config.models.length === 0) {
			return;
		}

		if (!config.baseUrl) {
			throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
		}
		if (!config.apiKey && !config.oauth) {
			throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
		}

		for (const modelDef of config.models) {
			const api = modelDef.api || config.api;
			if (!api) {
				throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
			}
		}
	}

	private clearOwnedIntegrations(): void {
		for (const source of this.integrationSources) {
			unregisterApiProviders(source);
			unregisterOAuthProviders(source);
		}
		this.integrationSources.clear();
		this.oauthIntegrationProviders.clear();
	}

	private registerProviderIntegrations(providerName: string, config: ProviderConfigInput): void {
		const source = `${this.integrationSourcePrefix}${providerName}`;
		if (config.oauth || config.streamSimple) this.integrationSources.add(source);
		// Register OAuth provider if provided
		if (config.oauth) {
			this.oauthIntegrationProviders.add(providerName);
			unregisterOAuthProviders(source);
			// Ensure the OAuth provider ID matches the provider name
			const oauthProvider: OAuthProviderInterface = {
				...config.oauth,
				id: providerName,
			};
			registerOAuthProvider(oauthProvider, source);
		}

		if (config.streamSimple) {
			unregisterApiProviders(source);
			const streamSimple = config.streamSimple;
			registerApiProvider(
				{
					api: config.api!,
					stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
					streamSimple,
				},
				source,
			);
		}
	}

	private applyProviderRequestConfig(providerName: string, config: ProviderConfigInput): void {
		this.registerProviderIntegrations(providerName, config);

		this.storeProviderRequestConfig(providerName, config);
		if (config.modelOverrides) {
			for (const [modelId, modelOverride] of Object.entries(config.modelOverrides)) {
				this.storeModelHeaders(providerName, modelId, modelOverride.headers);
			}
		}
		if (config.models && config.models.length > 0) {
			for (const modelDef of config.models) {
				this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);
			}
		}
	}

	private applyRegisteredProviderModels(
		models: Model<Api>[],
		providerName: string,
		config: ProviderConfigInput,
		syncedOAuthCredentials: Map<string, OAuthCredential | undefined>,
	): Model<Api>[] {
		const modelOverrides = config.modelOverrides ? new Map(Object.entries(config.modelOverrides)) : undefined;
		let nextModels = cloneModels(models);

		if (config.models && config.models.length > 0) {
			// Full replacement: remove existing models for this provider
			nextModels = nextModels.filter((m) => m.provider !== providerName);

			// Parse and add new models
			for (const modelDef of config.models) {
				const api = modelDef.api || config.api;

				const model = {
					id: modelDef.id,
					name: modelDef.name,
					api: api as Api,
					provider: providerName,
					baseUrl: modelDef.baseUrl ?? config.baseUrl!,
					reasoning: modelDef.reasoning,
					defaultThinkingLevel: modelDef.defaultThinkingLevel,
					thinkingLevelMap: modelDef.thinkingLevelMap,
					input: modelDef.input as ("text" | "image")[],
					cost: modelDef.cost,
					...resolveModelLimitsAndToolCalling(modelDef),
					headers: undefined,
					compat: modelDef.compat,
				} as Model<Api>;
				const modelOverride = modelOverrides?.get(model.id);
				nextModels.push(structuredClone(modelOverride ? applyModelOverride(model, modelOverride) : model));
			}
		} else if (config.baseUrl || config.headers || modelOverrides) {
			// Override-only: update concrete existing models. Request headers are resolved per request.
			nextModels = nextModels.map((m) => {
				if (m.provider !== providerName) return m;
				const updated = {
					...m,
					baseUrl: config.baseUrl ?? m.baseUrl,
				};
				const modelOverride = modelOverrides?.get(m.id);
				return structuredClone(modelOverride ? applyModelOverride(updated, modelOverride) : updated);
			});
		}

		// Apply OAuth modifyModels if credentials exist (e.g., to update baseUrl)
		if (config.oauth?.modifyModels) {
			const cred = this.authStorage.get(providerName);
			const oauthCred = cred?.type === "oauth" ? cred : undefined;
			const clonedCred = oauthCred ? structuredClone(oauthCred) : undefined;
			if (clonedCred) {
				nextModels = cloneModels(config.oauth.modifyModels(cloneModels(nextModels), structuredClone(clonedCred)));
			}
			syncedOAuthCredentials.set(providerName, clonedCred);
		}

		return nextModels;
	}
}

function cloneModels(models: readonly Model<Api>[]): Model<Api>[] {
	return models.map((model) => structuredClone(model));
}

function cloneProviderConfigInput(config: ProviderConfigInput): ProviderConfigInput {
	return {
		...config,
		headers: config.headers ? { ...config.headers } : undefined,
		oauth: config.oauth ? { ...config.oauth } : undefined,
		models: config.models?.map((model) => ({
			...model,
			thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
			input: [...model.input],
			cost: { ...model.cost },
			headers: model.headers ? { ...model.headers } : undefined,
			compat: model.compat ? { ...model.compat } : undefined,
		})),
		modelOverrides: config.modelOverrides
			? Object.fromEntries(
					Object.entries(config.modelOverrides).map(([modelId, override]) => [
						modelId,
						{
							...override,
							thinkingLevelMap: override.thinkingLevelMap ? { ...override.thinkingLevelMap } : undefined,
							input: override.input ? [...override.input] : undefined,
							cost: override.cost ? { ...override.cost } : undefined,
							headers: override.headers ? { ...override.headers } : undefined,
							compat: override.compat ? { ...override.compat } : undefined,
						},
					]),
				)
			: undefined,
	};
}
