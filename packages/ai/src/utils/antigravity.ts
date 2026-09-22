import type { Model, ThinkingBudgets, ThinkingLevelMap } from "../types.ts";

export const ANTIGRAVITY_PROVIDER = "google-antigravity";
export const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_VERSION = "1.2.4";

function isAntigravityObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function antigravityObject(value: unknown): Record<string, unknown> {
	if (!isAntigravityObject(value)) throw new Error("Invalid Antigravity response");
	return value;
}

export function antigravityHeaders(
	token: string,
	runtime: { platform: string; arch: string } | undefined = typeof process === "undefined" ? undefined : process,
): Record<string, string> {
	const platform = runtime?.platform === "win32" ? "windows" : runtime?.platform;
	const arch = runtime?.arch === "x64" ? "amd64" : runtime?.arch === "ia32" ? "386" : runtime?.arch;
	const system = platform && arch ? `; os_type=${platform}; arch=${arch}` : "";
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"User-Agent": `antigravity/cli/${ANTIGRAVITY_VERSION} (aidev_client${system}; auth_method=consumer)`,
	};
}

export async function antigravityRequest(
	token: string,
	method: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:${method}`, {
		method: "POST",
		headers: antigravityHeaders(token),
		body: JSON.stringify(body),
		redirect: "error",
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		const error = new Error(`Antigravity ${method} failed (HTTP ${response.status})`);
		(error as Error & { status?: number }).status = response.status;
		throw error;
	}
	return antigravityObject(await response.json());
}

/**
 * An Antigravity model is a fixed thinking preset: its catalog `thinkingBudget` (-1 is dynamic) is
 * what separates the -low and -high variants of one model, and it is the only thinking configuration
 * every advertised model accepts (measured: Gemini rejects the MINIMAL level, GPT-OSS rejects any
 * level). The model therefore declares one thinking level, named from its budget, and the transport
 * sends the budget itself; pi's level scale is never mapped onto it.
 */
function antigravityThinkingPreset(budget: number): {
	level: "low" | "medium" | "high";
	thinkingLevelMap: ThinkingLevelMap;
	thinkingBudgets: ThinkingBudgets;
} {
	const level = budget < 0 || budget >= 8192 ? "high" : budget >= 2048 ? "medium" : "low";
	return {
		level,
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, [level]: level },
		thinkingBudgets: { [level]: budget },
	};
}

/** The model family the catalog's backend name stands for. */
function antigravityUpstream(backend: string): "google" | "anthropic" | "openai" {
	return backend.includes("ANTHROPIC") ? "anthropic" : backend.includes("OPENAI") ? "openai" : "google";
}

/** The backend field worth persisting from a catalog entry: which provider serves the model. */
function antigravityBackend(entry: unknown): { apiProvider?: string } {
	const provider = isAntigravityObject(entry) ? entry.apiProvider : undefined;
	return typeof provider === "string" && /^API_PROVIDER_[A-Z_]{1,60}$/.test(provider) ? { apiProvider: provider } : {};
}

/** The catalog thinking budget an Antigravity model runs at, or undefined when its catalog predates budgets. */
export function antigravityThinkingBudget(model: Model<"google-antigravity">): number | undefined {
	const budgets = model.thinkingBudgets;
	if (!budgets) return undefined;
	const values = Object.values(budgets).filter((value): value is number => typeof value === "number");
	return values.length === 1 ? values[0] : undefined;
}

export function parseAntigravityModels(raw: unknown): Model<"google-antigravity">[] {
	const entries = Object.entries(antigravityObject(raw));
	if (entries.length > 200) throw new Error("Antigravity model catalog exceeds its size limit");
	const models: Model<"google-antigravity">[] = [];
	for (const [id, value] of entries) {
		if (!isAntigravityObject(value)) continue;
		const info = value;
		// This adapter exposes chat models, not internal completion or image-generation routes.
		if (!/^(?:gemini|claude|gpt|o[1-9])-[a-z0-9.-]+$/.test(id) || id.includes("image") || info.isInternal) continue;
		if (!Number.isSafeInteger(info.maxTokens) || !Number.isSafeInteger(info.maxOutputTokens)) continue;
		const contextWindow = info.maxTokens as number;
		const maxTokens = info.maxOutputTokens as number;
		if (contextWindow <= 0 || maxTokens <= 0 || maxTokens > contextWindow) continue;
		const reasoning = info.supportsThinking === true;
		const budget =
			reasoning && Number.isSafeInteger(info.thinkingBudget) && (info.thinkingBudget as number) >= -1
				? (info.thinkingBudget as number)
				: undefined;
		const preset = budget !== undefined ? antigravityThinkingPreset(budget) : undefined;
		// The catalog names the backend; only Gemini reads the JSON-schema tool field.
		const backend = typeof info.apiProvider === "string" ? info.apiProvider : undefined;
		models.push({
			id,
			name: typeof info.displayName === "string" ? info.displayName.slice(0, 200) : id,
			provider: ANTIGRAVITY_PROVIDER,
			api: "google-antigravity",
			baseUrl: ANTIGRAVITY_ENDPOINT,
			reasoning,
			...(preset
				? {
						defaultThinkingLevel: preset.level,
						thinkingLevelMap: preset.thinkingLevelMap,
						thinkingBudgets: preset.thinkingBudgets,
					}
				: {}),
			input: info.supportsImages === true ? ["text", "image"] : ["text"],
			contextWindow,
			maxTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			...(backend ? { upstream: antigravityUpstream(backend) } : {}),
		});
	}
	return models;
}

/**
 * The project each access token resolved to. The native client resolves the project once at
 * startup, not per request; a refreshed token is a new key and resolves again. Concurrent first
 * calls share one lookup, and a failed lookup is not kept.
 */
const resolvedProjects = new Map<string, Promise<string>>();
const MAX_RESOLVED_PROJECTS = 16;

export function resolveAntigravityProjectOnce(token: string, signal?: AbortSignal): Promise<string> {
	const known = resolvedProjects.get(token);
	if (known) return known;
	const lookup = resolveAntigravityProject(token, signal);
	resolvedProjects.set(token, lookup);
	if (resolvedProjects.size > MAX_RESOLVED_PROJECTS)
		resolvedProjects.delete(resolvedProjects.keys().next().value as string);
	lookup.catch(() => {
		if (resolvedProjects.get(token) === lookup) resolvedProjects.delete(token);
	});
	return lookup;
}

export async function resolveAntigravityProject(token: string, signal?: AbortSignal): Promise<string> {
	const account = await antigravityRequest(
		token,
		"loadCodeAssist",
		{
			metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
		},
		signal,
	);
	const project = account.cloudaicompanionProject;
	const projectId = typeof project === "string" ? project : project ? antigravityObject(project).id : undefined;
	if (typeof projectId !== "string" || !projectId.trim()) {
		throw new Error(
			"Antigravity did not return an accessible project. Complete account setup in AGY and sign in again.",
		);
	}
	return projectId;
}

export async function discoverAntigravityAccount(
	token: string,
	signal?: AbortSignal,
): Promise<{ projectId: string; modelCatalog: unknown }> {
	const projectId = await resolveAntigravityProject(token, signal);
	const response = await antigravityRequest(token, "fetchAvailableModels", { project: projectId }, signal);
	if (!Array.isArray(response.agentModelSorts) || response.agentModelSorts.length > 20)
		throw new Error("Invalid Antigravity agent model catalog");
	const agentIds = new Set<string>();
	for (const sort of response.agentModelSorts) {
		const groups = antigravityObject(sort).groups;
		if (!Array.isArray(groups) || groups.length > 20) throw new Error("Invalid Antigravity model groups");
		for (const group of groups) {
			const ids = antigravityObject(group).modelIds;
			if (!Array.isArray(ids) || ids.length > 200) throw new Error("Invalid Antigravity model identifiers");
			for (const id of ids) {
				if (typeof id !== "string") throw new Error("Invalid Antigravity model identifier");
				agentIds.add(id);
			}
		}
	}
	const models = parseAntigravityModels(response.models).filter((model) => agentIds.has(model.id));
	if (models.length === 0) throw new Error("Antigravity returned no supported chat models");
	// Persist only public model capabilities, never quota/account metadata from discovery.
	const modelCatalog = Object.fromEntries(
		models.map((model) => [
			model.id,
			{
				displayName: model.name,
				maxTokens: model.contextWindow,
				maxOutputTokens: model.maxTokens,
				supportsThinking: model.reasoning,
				supportsImages: model.input.includes("image"),
				...(antigravityThinkingBudget(model) !== undefined
					? { thinkingBudget: antigravityThinkingBudget(model) }
					: {}),
				...(response.models && typeof antigravityObject(response.models)[model.id] === "object"
					? antigravityBackend(antigravityObject(response.models)[model.id])
					: {}),
			},
		]),
	);
	return { projectId, modelCatalog };
}
