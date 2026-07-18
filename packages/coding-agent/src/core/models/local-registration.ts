import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

interface ModelsJson {
	providers: Record<
		string,
		{
			baseUrl?: string;
			api?: string;
			apiKey?: string;
			models?: ModelsJsonModel[];
			[key: string]: unknown;
		}
	>;
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

export function registerLocalModel(args: {
	agentDir: string;
	ref: string;
	baseUrl: string;
	contextWindow?: number;
	servedContextWindow?: number;
}): LocalRegistrationResult {
	const modelsJsonPath = join(args.agentDir, "models.json");
	const contextWindow = args.contextWindow ?? 8192;
	const entry = localModelEntry(args.ref, contextWindow, args.servedContextWindow);
	const providerBase = {
		baseUrl: `${args.baseUrl.replace(/\/$/, "")}/v1`,
		api: "openai-completions",
		apiKey: "ollama",
	};
	const { json, reason } = loadStrict(modelsJsonPath);
	if (!json) {
		return {
			ok: false,
			modelsJsonPath,
			reason,
			manualSnippet: JSON.stringify(
				{ providers: { [OLLAMA_PROVIDER]: { ...providerBase, models: [entry] } } },
				null,
				"\t",
			),
		};
	}
	json.providers[OLLAMA_PROVIDER] ??= { ...providerBase, models: [] };
	const provider = json.providers[OLLAMA_PROVIDER];
	provider.baseUrl ??= providerBase.baseUrl;
	provider.api ??= providerBase.api;
	provider.apiKey ??= providerBase.apiKey;
	provider.models ??= [];
	const existing = provider.models.findIndex((model) => model.id === args.ref);
	if (existing >= 0) {
		provider.models[existing] = { ...provider.models[existing], ...entry };
	} else {
		provider.models.push(entry);
	}
	writeFileSync(modelsJsonPath, `${JSON.stringify(json, null, "\t")}\n`, "utf-8");
	return { ok: true, modelsJsonPath };
}

export function registerTransformersModel(args: {
	agentDir: string;
	modelId: string;
	baseUrl: string;
	contextWindow?: number;
}): LocalRegistrationResult {
	const modelsJsonPath = join(args.agentDir, "models.json");
	const entry = transformersModelEntry(args);
	const providerBase = {
		name: "Hugging Face Transformers (pi-managed)",
		baseUrl: entry.baseUrl,
		api: "openai-completions",
		apiKey: "pi-transformers",
	};
	const { json, reason } = loadStrict(modelsJsonPath);
	if (!json) {
		return {
			ok: false,
			modelsJsonPath,
			reason,
			manualSnippet: JSON.stringify(
				{ providers: { [HF_TRANSFORMERS_PROVIDER]: { ...providerBase, models: [entry] } } },
				null,
				"\t",
			),
		};
	}
	json.providers[HF_TRANSFORMERS_PROVIDER] ??= { ...providerBase, models: [] };
	const provider = json.providers[HF_TRANSFORMERS_PROVIDER];
	provider.name ??= providerBase.name;
	provider.baseUrl ??= providerBase.baseUrl;
	provider.api ??= providerBase.api;
	provider.apiKey ??= providerBase.apiKey;
	provider.models ??= [];
	const existing = provider.models.findIndex((model) => model.id === args.modelId);
	if (existing >= 0) {
		provider.models[existing] = { ...provider.models[existing], ...entry };
	} else {
		provider.models.push(entry);
	}
	writeFileSync(modelsJsonPath, `${JSON.stringify(json, null, "\t")}\n`, "utf-8");
	return { ok: true, modelsJsonPath };
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
	const modelsJsonPath = join(args.agentDir, "models.json");
	const entry = prismLlamaCppModelEntry({
		modelId: args.modelId,
		baseUrl: args.baseUrl,
		contextWindow: args.contextWindow,
		servedContextWindow: args.servedContextWindow ?? args.contextWindow,
	});
	const { json, reason } = loadStrict(modelsJsonPath);
	if (!json) {
		return {
			ok: false,
			modelsJsonPath,
			reason,
			manualSnippet: JSON.stringify({ providers: { [PRISM_LLAMACPP_PROVIDER]: { models: [entry] } } }, null, "\t"),
		};
	}
	json.providers[PRISM_LLAMACPP_PROVIDER] ??= { models: [] };
	const provider = json.providers[PRISM_LLAMACPP_PROVIDER];
	provider.models ??= [];
	const existing = provider.models.findIndex((model) => model.id === args.modelId);
	if (existing >= 0) {
		provider.models[existing] = { ...provider.models[existing], ...entry };
	} else {
		provider.models.push(entry);
	}
	writeFileSync(modelsJsonPath, `${JSON.stringify(json, null, "\t")}\n`, "utf-8");
	return { ok: true, modelsJsonPath };
}

export function unregisterLocalModel(args: { agentDir: string; ref: string }): LocalRegistrationResult {
	const modelsJsonPath = join(args.agentDir, "models.json");
	const { json, reason } = loadStrict(modelsJsonPath);
	if (!json) return { ok: false, modelsJsonPath, reason };
	const provider = json.providers[OLLAMA_PROVIDER];
	if (!provider?.models) return { ok: true, modelsJsonPath };
	const before = provider.models.length;
	provider.models = provider.models.filter((model) => model.id !== args.ref);
	if (provider.models.length === before) return { ok: true, modelsJsonPath };
	// Drop the whole provider entry when its last pi-registered model goes (leave user fields alone
	// if they added any models themselves — only an all-pi-managed empty list is removed).
	if (provider.models.length === 0) {
		delete json.providers[OLLAMA_PROVIDER];
	}
	writeFileSync(modelsJsonPath, `${JSON.stringify(json, null, "\t")}\n`, "utf-8");
	return { ok: true, modelsJsonPath };
}

export function unregisterTransformersModel(args: { agentDir: string; modelId: string }): LocalRegistrationResult {
	const modelsJsonPath = join(args.agentDir, "models.json");
	const { json, reason } = loadStrict(modelsJsonPath);
	if (!json) return { ok: false, modelsJsonPath, reason };
	const provider = json.providers[HF_TRANSFORMERS_PROVIDER];
	if (!provider?.models) return { ok: true, modelsJsonPath };
	const before = provider.models.length;
	provider.models = provider.models.filter((model) => model.id !== args.modelId);
	if (provider.models.length === before) return { ok: true, modelsJsonPath };
	if (provider.models.length === 0) {
		delete json.providers[HF_TRANSFORMERS_PROVIDER];
	}
	writeFileSync(modelsJsonPath, `${JSON.stringify(json, null, "\t")}\n`, "utf-8");
	return { ok: true, modelsJsonPath };
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
	const modelsJsonPath = join(args.agentDir, "models.json");
	const { json, reason } = loadStrict(modelsJsonPath);
	if (!json) return { ok: false, modelsJsonPath, reason };
	const provider = json.providers[PRISM_LLAMACPP_PROVIDER];
	if (!provider?.models) return { ok: true, modelsJsonPath };
	const before = provider.models.length;
	provider.models = provider.models.filter((model) => model.id !== args.modelId);
	if (provider.models.length === before) return { ok: true, modelsJsonPath };
	writeFileSync(modelsJsonPath, `${JSON.stringify(json, null, "\t")}\n`, "utf-8");
	return { ok: true, modelsJsonPath };
}
