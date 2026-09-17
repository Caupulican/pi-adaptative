import type { Model } from "../types.ts";

export const ANTIGRAVITY_PROVIDER = "google-antigravity";
export const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_VERSION = "1.2.3";

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
	if (!response.ok) throw new Error(`Antigravity ${method} failed (HTTP ${response.status})`);
	return antigravityObject(await response.json());
}

export function parseAntigravityModels(raw: unknown): Model<"google-antigravity">[] {
	const entries = Object.entries(antigravityObject(raw));
	if (entries.length > 200) throw new Error("Antigravity model catalog exceeds its size limit");
	const models: Model<"google-antigravity">[] = [];
	for (const [id, value] of entries) {
		if (!isAntigravityObject(value)) continue;
		const info = value;
		// This adapter exposes Gemini chat models, not internal completion or image-generation routes.
		if (!/^gemini-[a-z0-9.-]+$/.test(id) || id.includes("image") || info.isInternal) continue;
		if (!Number.isSafeInteger(info.maxTokens) || !Number.isSafeInteger(info.maxOutputTokens)) continue;
		const contextWindow = info.maxTokens as number;
		const maxTokens = info.maxOutputTokens as number;
		if (contextWindow <= 0 || maxTokens <= 0 || maxTokens > contextWindow) continue;
		models.push({
			id,
			name: typeof info.displayName === "string" ? info.displayName.slice(0, 200) : id,
			provider: ANTIGRAVITY_PROVIDER,
			api: "google-antigravity",
			baseUrl: ANTIGRAVITY_ENDPOINT,
			reasoning: info.supportsThinking === true,
			input: info.supportsImages === true ? ["text", "image"] : ["text"],
			contextWindow,
			maxTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
	return models;
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
	if (models.length === 0) throw new Error("Antigravity returned no supported Gemini chat models");
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
			},
		]),
	);
	return { projectId, modelCatalog };
}
