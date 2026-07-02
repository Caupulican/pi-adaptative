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
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
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

const OLLAMA_PROVIDER = "ollama";

function localModelEntry(ref: string, contextWindow: number): ModelsJsonModel {
	return {
		id: ref,
		name: ref,
		contextWindow,
		maxTokens: 2048,
		reasoning: false,
		input: ["text"],
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
}): LocalRegistrationResult {
	const modelsJsonPath = join(args.agentDir, "models.json");
	const contextWindow = args.contextWindow ?? 8192;
	const entry = localModelEntry(args.ref, contextWindow);
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
