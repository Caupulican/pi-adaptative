import { resolveCatalogPricing } from "../models.ts";
import { requestBoundedAccountJson } from "../providers/account-request.ts";
import { ANTIGRAVITY_CLIENT_CONFIG } from "../providers/antigravity-client-config.generated.ts";
import { gemini4ArgonThinkingMetadata, isGemini4ArgonModel } from "../providers/google-model-family.ts";
import type { Model, ThinkingBudgets, ThinkingLevelMap } from "../types.ts";
import { isRecord } from "./value-guards.ts";

export const ANTIGRAVITY_PROVIDER = "google-antigravity";
export const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ACCOUNT_METADATA = {
	ideType: "ANTIGRAVITY",
	platform: "PLATFORM_UNSPECIFIED",
	pluginType: "GEMINI",
} as const;

/** Exact reviewed AGY images: a reported version alone cannot admit unreviewed OAuth or request headers. */
export const REVIEWED_ANTIGRAVITY_INSTALLATIONS = Object.freeze([
	Object.freeze({
		version: "1.4.5",
		sha256: "8af8e7a2a68f72fa7164e00bb59b8902c018fa43e528fc401ad7db8c2972583c",
	}),
	Object.freeze({
		version: "1.4.8",
		sha256: "70b1d27f1812f5ebccc8f13daf2209112447413437dd1ab6d87c58b8a04fe35b",
	}),
	Object.freeze({
		version: "1.4.9",
		sha256: "1c9102d0a36194d57f6b4a66249217ece0bf563e108bcdd1046b81c5b6d6004c",
	}),
]);

export function antigravityObject(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("Invalid Antigravity response");
	return value;
}

export function antigravityHeaders(
	token: string,
	runtime: { platform: string; arch: string } | undefined = typeof process === "undefined" ? undefined : process,
	userAgentPrefix: string = ANTIGRAVITY_CLIENT_CONFIG.userAgentPrefix,
): Record<string, string> {
	const platform = runtime?.platform === "win32" ? "windows" : runtime?.platform;
	const arch = runtime?.arch === "x64" ? "amd64" : runtime?.arch === "ia32" ? "386" : runtime?.arch;
	const system = platform && arch ? `; os_type=${platform}; arch=${arch}` : "";
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"User-Agent": `${userAgentPrefix} (aidev_client${system}; auth_method=consumer)`,
	};
}

export async function antigravityRequest(
	token: string,
	method: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	return antigravityObject(
		await requestBoundedAccountJson({
			url: `${ANTIGRAVITY_ENDPOINT}/v1internal:${method}`,
			headers: new Headers(antigravityHeaders(token)),
			init: { method: "POST", body: JSON.stringify(body) },
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
			label: `Antigravity ${method}`,
			createError: (message, status, retryAfterMs) => Object.assign(new Error(message), { status, retryAfterMs }),
		}),
	);
}

/**
 * Catalog variants are fixed presets. Budget models send their own budget;
 * level models send the catalog level (1=LOW, 2=MEDIUM, 3=HIGH), not a caller-selected scale.
 */
function antigravityThinkingPreset(
	preset: { kind: "budget"; value: number } | { kind: "level"; value: 1 | 2 | 3 },
	id: string,
): {
	level: "low" | "medium" | "high";
	thinkingLevelMap: ThinkingLevelMap;
	thinkingBudgets?: ThinkingBudgets;
} {
	// Variant identity is authoritative: GPT-OSS Medium has an 8192-token budget.
	const namedLevel = id.endsWith("-low")
		? "low"
		: id.endsWith("-medium")
			? "medium"
			: id.endsWith("-high")
				? "high"
				: undefined;
	const level =
		preset.kind === "level"
			? preset.value === 1
				? "low"
				: preset.value === 2
					? "medium"
					: "high"
			: (namedLevel ??
				(preset.value < 0 || preset.value >= 8192 ? "high" : preset.value >= 2048 ? "medium" : "low"));
	return {
		level,
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, [level]: level },
		...(preset.kind === "budget" ? { thinkingBudgets: { [level]: preset.value } } : {}),
	};
}

/** The model family the catalog's backend name stands for. */
function antigravityUpstream(backend: string): "google" | "anthropic" | "openai" {
	return backend.includes("ANTHROPIC") ? "anthropic" : backend.includes("OPENAI") ? "openai" : "google";
}

/** The backend field worth persisting from a catalog entry: which provider serves the model. */
function antigravityBackend(entry: unknown): { apiProvider?: string } {
	const provider = isRecord(entry) ? entry.apiProvider : undefined;
	return typeof provider === "string" && /^API_PROVIDER_[A-Z_]{1,60}$/.test(provider) ? { apiProvider: provider } : {};
}

/** The catalog thinking budget an Antigravity model runs at, or undefined when its catalog predates budgets. */
export function antigravityThinkingBudget(model: Model<"google-antigravity">): number | undefined {
	const budgets = model.thinkingBudgets;
	if (!budgets) return undefined;
	const values = Object.values(budgets).filter((value): value is number => typeof value === "number");
	return values.length === 1 ? values[0] : undefined;
}

export function antigravityThinkingLevel(model: Model<"google-antigravity">): 1 | 2 | 3 | undefined {
	if (!model.reasoning || model.thinkingBudgets || !model.thinkingLevelMap) return undefined;
	if (Object.values(model.thinkingLevelMap).filter((value) => value != null).length !== 1) return undefined;
	return toAntigravityThinkingLevel(model.defaultThinkingLevel);
}

/** One native enum projection for catalog presets and caller-selected Google levels. */
export function toAntigravityThinkingLevel(level: string | undefined): 1 | 2 | 3 | undefined {
	switch (level?.toLowerCase()) {
		case "low":
			return 1;
		case "medium":
			return 2;
		case "high":
			return 3;
		default:
			return undefined;
	}
}

export function parseAntigravityModels(raw: unknown): Model<"google-antigravity">[] {
	const entries = Object.entries(antigravityObject(raw));
	if (entries.length > 200) throw new Error("Antigravity model catalog exceeds its size limit");
	const models: Model<"google-antigravity">[] = [];
	for (const [id, value] of entries) {
		if (!isRecord(value)) continue;
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
		const nativeLevel = info.thinkingLevel;
		// Gemini level presets (including Argon) do not advertise adaptive thinking.
		// The catalog's level is authoritative even when a zero budget is also present.
		const catalogLevel =
			reasoning && (nativeLevel === 1 || nativeLevel === 2 || nativeLevel === 3) ? nativeLevel : undefined;
		const preset =
			catalogLevel !== undefined
				? antigravityThinkingPreset({ kind: "level", value: catalogLevel }, id)
				: budget !== undefined && !isGemini4ArgonModel(id)
					? antigravityThinkingPreset({ kind: "budget", value: budget }, id)
					: undefined;
		// The catalog names the backend; only Gemini reads the JSON-schema tool field.
		const backend = typeof info.apiProvider === "string" ? info.apiProvider : undefined;
		const pricing = resolveCatalogPricing(ANTIGRAVITY_PROVIDER, id);
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
						...(preset.thinkingBudgets ? { thinkingBudgets: preset.thinkingBudgets } : {}),
					}
				: reasoning && isGemini4ArgonModel(id)
					? gemini4ArgonThinkingMetadata(true)
					: {}),
			input: info.supportsImages === true ? ["text", "image"] : ["text"],
			contextWindow,
			maxTokens,
			cost: pricing ? { ...pricing.cost } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			...(pricing?.longContextPricing ? { longContextPricing: { ...pricing.longContextPricing } } : {}),
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
interface ProjectLookup {
	promise: Promise<string>;
	controller: AbortController;
	waiters: number;
	settled: boolean;
}
const resolvedProjects = new Map<string, ProjectLookup>();
const MAX_RESOLVED_PROJECTS = 16;

export async function resolveAntigravityProjectOnce(token: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	let lookup = resolvedProjects.get(token);
	if (!lookup) {
		const controller = new AbortController();
		lookup = { promise: resolveAntigravityProject(token, controller.signal), controller, waiters: 0, settled: false };
		const created = lookup;
		resolvedProjects.set(token, created);
		if (resolvedProjects.size > MAX_RESOLVED_PROJECTS)
			resolvedProjects.delete(resolvedProjects.keys().next().value as string);
		created.promise.then(
			() => {
				created.settled = true;
			},
			() => {
				created.settled = true;
				if (resolvedProjects.get(token) === created) resolvedProjects.delete(token);
			},
		);
	}
	const shared = lookup;
	return new Promise<string>((resolve, reject) => {
		let finished = false;
		const finish = (result: { project: string } | { error: unknown }) => {
			if (finished) return;
			finished = true;
			signal?.removeEventListener("abort", onAbort);
			shared.waiters--;
			if ("project" in result) resolve(result.project);
			else reject(result.error);
		};
		const onAbort = () => {
			finish({ error: signal?.reason });
			if (shared.waiters === 0 && !shared.settled) {
				if (resolvedProjects.get(token) === shared) resolvedProjects.delete(token);
				shared.controller.abort();
			}
		};
		shared.waiters++;
		signal?.addEventListener("abort", onAbort, { once: true });
		shared.promise.then(
			(project) => finish({ project }),
			(error: unknown) => finish({ error }),
		);
		if (signal?.aborted) onAbort();
	});
}

export async function resolveAntigravityProject(token: string, signal?: AbortSignal): Promise<string> {
	const account = await antigravityRequest(
		token,
		"loadCodeAssist",
		{
			metadata: ANTIGRAVITY_ACCOUNT_METADATA,
		},
		signal,
	);
	return antigravityProjectId(account);
}

export function antigravityProjectId(account: Record<string, unknown>): string {
	const project = account.cloudaicompanionProject;
	const projectId = typeof project === "string" ? project : project ? antigravityObject(project).id : undefined;
	if (typeof projectId !== "string" || !projectId.trim()) {
		throw new Error(
			"Antigravity did not return an accessible project. Complete account setup in AGY and sign in again.",
		);
	}
	return projectId;
}

/**
 * The shape of the model catalog this adapter stores. Raise it whenever discovery starts persisting a
 * field the adapter reads (thinking budgets and backends are version 2): a stored catalog of an older
 * version is refreshed instead of silently running models without what it lacks. Version 3 adds
 * adaptive thinking levels and the discovery client's version. Version 4 retains level-based
 * Gemini presets independently of the adaptive-thinking flag.
 */
export const ANTIGRAVITY_CATALOG_VERSION = 4;

export async function discoverAntigravityAccount(
	token: string,
	signal?: AbortSignal,
): Promise<{ projectId: string; modelCatalog: unknown; catalogVersion: number; clientVersion: string }> {
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
				...(antigravityThinkingLevel(model) !== undefined
					? { thinkingLevel: antigravityThinkingLevel(model) }
					: {}),
				...(response.models && typeof antigravityObject(response.models)[model.id] === "object"
					? antigravityBackend(antigravityObject(response.models)[model.id])
					: {}),
			},
		]),
	);
	return {
		projectId,
		modelCatalog,
		catalogVersion: ANTIGRAVITY_CATALOG_VERSION,
		clientVersion: ANTIGRAVITY_CLIENT_CONFIG.version,
	};
}
