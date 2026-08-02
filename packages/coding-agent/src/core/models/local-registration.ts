import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { configFile } from "../agent-paths.ts";

/**
 * Persistent registration for pulled local models: merges an "ollama" provider entry into the
 * user's `<agentDir>/models.json` — the exact file ModelRegistry loads at startup — so a pulled
 * model resolves as `ollama/<ref>` immediately AND across sessions (usable as session model,
 * lane model, judge, or curator).
 *
 * Non-destructive contract: the file is parsed with STRICT JSON first; a file that only parses
 * with comments/relaxed syntax is the user's hand-authored config and is never rewritten — the
 * caller gets `manualSnippet` to show instead.
 */

interface ModelsJsonModel {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	contextWindow?: number;
	/** Measured by the local capacity probe; compaction uses min(contextWindow, servedContextWindow). */
	servedContextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	textToolCallProtocol?: boolean;
	input?: string[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	compat?: Record<string, unknown>;
}

interface ModelsJsonProvider {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models?: ModelsJsonModel[];
	[key: string]: unknown;
}

interface ModelsJson {
	providers: Record<string, ModelsJsonProvider>;
	[key: string]: unknown;
}

export interface LocalRegistrationResult {
	ok: boolean;
	modelsJsonPath: string;
	reason?: string;
	/** When the file cannot be safely rewritten: the entry the user should add by hand. */
	manualSnippet?: string;
}

/** Provider name pi registers pulled local models under (see registerLocalModel below). */
export const OLLAMA_PROVIDER = "ollama";
/** Provider name for pi-managed Hugging Face Transformers sidecar models. */
export const HF_TRANSFORMERS_PROVIDER = "pi-hf-transformers";
/**
 * Provider name for pi-managed prism llama.cpp models (Bonsai-27B and future curated prism-ml
 * models). This is the built-in `KnownProvider` "llama-cpp" (see packages/ai/src/types.ts and the
 * static `llama-cpp/local` catalog entry in models.generated.ts for a user-run server on the
 * conventional port 8080) — model-registry.ts already treats it as auth-exempt, so registration
 * here never needs a synthetic apiKey the way registerTransformersModel does. Because it is a
 * SHARED built-in namespace (not a pi-invented provider name like the two above), registration only
 * ever touches this provider's `models` array — never the whole provider object — so a user's own
 * hand-authored `llama-cpp` override (e.g. for their own server) is never destroyed.
 */
export const PRISM_LLAMACPP_PROVIDER = "llama-cpp";

function localModelEntry(ref: string, contextWindow: number, servedContextWindow?: number): ModelsJsonModel {
	return {
		id: ref,
		name: ref,
		contextWindow,
		...(servedContextWindow !== undefined ? { servedContextWindow } : {}),
		maxTokens: 2048,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function transformersModelEntry(args: { modelId: string; baseUrl: string; contextWindow?: number }): ModelsJsonModel {
	return {
		id: args.modelId,
		name: args.modelId,
		baseUrl: `${args.baseUrl.replace(/\/$/, "")}/v1`,
		contextWindow: args.contextWindow ?? 131_072,
		maxTokens: 1024,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { supportsUsageInStreaming: false },
	};
}

function prismLlamaCppModelEntry(args: {
	modelId: string;
	baseUrl: string;
	contextWindow: number;
	servedContextWindow: number;
}): ModelsJsonModel {
	return {
		id: args.modelId,
		name: args.modelId,
		baseUrl: `${args.baseUrl.replace(/\/$/, "")}/v1`,
		contextWindow: args.contextWindow,
		servedContextWindow: args.servedContextWindow,
		maxTokens: 2048,
		reasoning: false,
		// Vision rides along via the served mmproj file — unlike localModelEntry's Ollama entries,
		// which are text-only until per-model vision plumbing exists there too.
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function loadStrict(path: string): { json?: ModelsJson; reason?: string } {
	if (!existsSync(path)) return { json: { providers: {} } };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ModelsJson;
		if (!parsed || typeof parsed !== "object") return { reason: "models.json is not a JSON object" };
		parsed.providers = parsed.providers ?? {};
		return { json: parsed };
	} catch {
		return { reason: "models.json uses comments/relaxed JSON — pi will not rewrite a hand-authored file" };
	}
}

function writeModelsJson(path: string, json: ModelsJson): void {
	writeFileSync(path, `${JSON.stringify(json, null, "\t")}\n`, "utf-8");
}

function registerModel(args: {
	agentDir: string;
	providerId: string;
	modelId: string;
	entry: ModelsJsonModel;
	providerDefaults?: ModelsJsonProvider;
}): LocalRegistrationResult {
	const modelsJsonPath = configFile(args.agentDir, "models.json");
	const providerDefaults = args.providerDefaults ?? {};
	const { json, reason } = loadStrict(modelsJsonPath);
	if (!json) {
		return {
			ok: false,
			modelsJsonPath,
			reason,
			manualSnippet: JSON.stringify(
				{ providers: { [args.providerId]: { ...providerDefaults, models: [args.entry] } } },
				null,
				"\t",
			),
		};
	}

	json.providers[args.providerId] ??= { ...providerDefaults, models: [] };
	const provider = json.providers[args.providerId];
	for (const [key, value] of Object.entries(providerDefaults)) {
		if (provider[key] === null || provider[key] === undefined) provider[key] = value;
	}
	provider.models ??= [];
	const existing = provider.models.findIndex((model) => model.id === args.modelId);
	if (existing >= 0) provider.models[existing] = { ...provider.models[existing], ...args.entry };
	else provider.models.push(args.entry);

	writeModelsJson(modelsJsonPath, json);
	return { ok: true, modelsJsonPath };
}

function unregisterModel(args: {
	agentDir: string;
	providerId: string;
	modelId: string;
	deleteProviderWhenEmpty: boolean;
}): LocalRegistrationResult {
	const modelsJsonPath = configFile(args.agentDir, "models.json");
	const { json, reason } = loadStrict(modelsJsonPath);
	if (!json) return { ok: false, modelsJsonPath, reason };
	const provider = json.providers[args.providerId];
	if (!provider?.models) return { ok: true, modelsJsonPath };
	const before = provider.models.length;
	provider.models = provider.models.filter((model) => model.id !== args.modelId);
	if (provider.models.length === before) return { ok: true, modelsJsonPath };
	if (args.deleteProviderWhenEmpty && provider.models.length === 0) delete json.providers[args.providerId];
	writeModelsJson(modelsJsonPath, json);
	return { ok: true, modelsJsonPath };
}

export function registerLocalModel(args: {
	agentDir: string;
	ref: string;
	baseUrl: string;
	contextWindow?: number;
	servedContextWindow?: number;
}): LocalRegistrationResult {
	const contextWindow = args.contextWindow ?? 8192;
	const entry = localModelEntry(args.ref, contextWindow, args.servedContextWindow);
	const providerBase = {
		baseUrl: `${args.baseUrl.replace(/\/$/, "")}/v1`,
		api: "openai-completions",
		apiKey: "ollama",
	};
	return registerModel({
		agentDir: args.agentDir,
		providerId: OLLAMA_PROVIDER,
		modelId: args.ref,
		entry,
		providerDefaults: providerBase,
	});
}

export function registerTransformersModel(args: {
	agentDir: string;
	modelId: string;
	baseUrl: string;
	contextWindow?: number;
}): LocalRegistrationResult {
	const entry = transformersModelEntry(args);
	const providerBase = {
		name: "Hugging Face Transformers (pi-managed)",
		baseUrl: entry.baseUrl,
		api: "openai-completions",
		apiKey: "pi-transformers",
	};
	return registerModel({
		agentDir: args.agentDir,
		providerId: HF_TRANSFORMERS_PROVIDER,
		modelId: args.modelId,
		entry,
		providerDefaults: providerBase,
	});
}

/**
 * Register a pi-managed prism llama.cpp model (e.g. Bonsai-27B) under the shared built-in
 * "llama-cpp" provider. Unlike registerLocalModel/registerTransformersModel, this never writes
 * provider-level baseUrl/api/apiKey: "llama-cpp" is a built-in KnownProvider, so model-registry.ts
 * inherits api/baseUrl defaults from the built-in `llama-cpp/local` catalog entry when a model
 * definition omits them, and treats the whole provider as auth-exempt regardless. Each model
 * definition still sets its OWN baseUrl explicitly (this server's actual host:port), which
 * model-registry.ts's `modelDef.baseUrl ?? providerConfig.baseUrl ?? builtInDefaults?.baseUrl`
 * precedence picks up ahead of the built-in default.
 */
export function registerPrismLlamaCppModel(args: {
	agentDir: string;
	modelId: string;
	baseUrl: string;
	contextWindow: number;
	servedContextWindow?: number;
}): LocalRegistrationResult {
	const entry = prismLlamaCppModelEntry({
		modelId: args.modelId,
		baseUrl: args.baseUrl,
		contextWindow: args.contextWindow,
		servedContextWindow: args.servedContextWindow ?? args.contextWindow,
	});
	return registerModel({
		agentDir: args.agentDir,
		providerId: PRISM_LLAMACPP_PROVIDER,
		modelId: args.modelId,
		entry,
	});
}

export function unregisterLocalModel(args: { agentDir: string; ref: string }): LocalRegistrationResult {
	// Drop the whole provider entry when its last pi-registered model goes (leave user fields alone
	// if they added any models themselves — only an all-pi-managed empty list is removed).
	return unregisterModel({
		agentDir: args.agentDir,
		providerId: OLLAMA_PROVIDER,
		modelId: args.ref,
		deleteProviderWhenEmpty: true,
	});
}

export function unregisterTransformersModel(args: { agentDir: string; modelId: string }): LocalRegistrationResult {
	return unregisterModel({
		agentDir: args.agentDir,
		providerId: HF_TRANSFORMERS_PROVIDER,
		modelId: args.modelId,
		deleteProviderWhenEmpty: true,
	});
}

/**
 * Drop a pi-registered model entry from the shared "llama-cpp" provider. Deliberately never
 * deletes the whole provider object even when its `models` array empties out — see
 * {@link PRISM_LLAMACPP_PROVIDER}'s doc comment: unlike OLLAMA_PROVIDER/HF_TRANSFORMERS_PROVIDER
 * (pi-invented namespaces pi fully owns), "llama-cpp" is a built-in provider a user may have
 * independently configured (e.g. a baseUrl override for their own server); this must not remove
 * fields it didn't write.
 */
export function unregisterPrismLlamaCppModel(args: { agentDir: string; modelId: string }): LocalRegistrationResult {
	return unregisterModel({
		agentDir: args.agentDir,
		providerId: PRISM_LLAMACPP_PROVIDER,
		modelId: args.modelId,
		deleteProviderWhenEmpty: false,
	});
}
