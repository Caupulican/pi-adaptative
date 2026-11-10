import type { Api, Model } from "@caupulican/pi-ai";
import { modelsAreEqual } from "@caupulican/pi-ai/models";
import { harnessLog } from "../../kernel/harness-log.ts";
import { interfaceText } from "../language/interface-text.ts";
import { findRenamedFreeTierModel } from "../model-registry.ts";

/**
 * Favorites define router eligibility. An explicit Models configuration, CLI/SDK scope or selector
 * edit narrows those favorites; an orchestration profile only pins the session's cycling model.
 */
export type RouterPoolSource = "favorites" | "enabled_models" | "cli_models" | "sdk_models" | "models_selector";

export type CustomizedRouterPoolSource = Exclude<RouterPoolSource, "favorites">;

/** Session-held pool provenance: the operator's explicit model list and where it came from. */
export interface RouterPoolState {
	readonly source: CustomizedRouterPoolSource;
	readonly models: readonly Model<Api>[];
}

export interface RouterCandidatePool {
	/** True when the operator selected an explicit model list; the pool is then a hard boundary. */
	readonly customized: boolean;
	readonly source: RouterPoolSource;
	readonly models: readonly Model<Api>[];
}

/** A customized pool's source, as the summary names it: the catalogue gives each source the owner's label. */
const POOL_SOURCE_WORDS: Record<
	CustomizedRouterPoolSource,
	"modelsConfig" | "modelsArg" | "sdkScope" | "modelsSelector"
> = {
	enabled_models: "modelsConfig",
	cli_models: "modelsArg",
	sdk_models: "sdkScope",
	models_selector: "modelsSelector",
};

/** Pure projection of the session's pool provenance onto the live registry. */
export function resolveRouterCandidatePool(
	pool: RouterPoolState | undefined,
	registry: { getAvailable(): Model<Api>[] },
	options: {
		favorites: readonly { provider: string; modelId: string }[];
		/** Explicit advisor choice only; does not change favorites or the caller's hard model scope. */
		selectedAdvisorRef?: string;
		isRuntimeDisabled?: (runtime: "ollama" | "llamacpp" | "transformers") => boolean;
	},
): RouterCandidatePool {
	const filterDisabled = (models: readonly Model<Api>[]): Model<Api>[] => {
		if (!options?.isRuntimeDisabled) return [...models];
		return models.filter((m) => {
			if (m.provider === "ollama" && options.isRuntimeDisabled?.("ollama")) return false;
			if (m.provider === "hf-transformers" && options.isRuntimeDisabled?.("transformers")) return false;
			if (
				(m.provider === "llama-cpp" || m.provider === "prism-llamacpp") &&
				options.isRuntimeDisabled?.("llamacpp")
			) {
				return false;
			}
			return true;
		});
	};

	const available = filterDisabled(registry.getAvailable());
	const resolvedFavoriteKeys = new Set<string>();
	for (const favorite of options.favorites) {
		const exact = available.find((m) => m.provider === favorite.provider && m.id === favorite.modelId);
		const target = exact ?? findRenamedFreeTierModel(available, favorite.provider, favorite.modelId);
		if (target) {
			resolvedFavoriteKeys.add(`${target.provider}\0${target.id}`);
		}
	}
	const models = available.filter(
		(model) =>
			(resolvedFavoriteKeys.has(`${model.provider}\0${model.id}`) ||
				options.selectedAdvisorRef === `${model.provider}/${model.id}`) &&
			(!pool || pool.models.some((scoped) => modelsAreEqual(scoped, model))),
	);
	const resolved: RouterCandidatePool = {
		customized: pool !== undefined,
		source: pool?.source ?? "favorites",
		models,
	};
	harnessLog.debug("router", "the router pool was resolved", () => ({
		source: resolved.source,
		customized: resolved.customized,
		models: resolved.models.length,
	}));
	return resolved;
}

export function isModelInRouterPool(pool: RouterCandidatePool, model: Model<Api>): boolean {
	return pool.models.some((candidate) => modelsAreEqual(candidate, model));
}

/**
 * Whether a worker may run on `model`. With the router off, any model; with it on, the router's pool, and the model the
 * session itself runs is always usable. A pool with no model in it is a setup nothing was chosen in (no favorites yet), not a
 * ban on every model: it restricts nothing.
 */
export function workerModelAllocator(source: {
	getSessionModel(): Model<Api> | undefined;
	isRouterEnabled(): boolean;
	getPool(): RouterCandidatePool;
}): (model: Model<Api>) => boolean {
	return (model) => {
		if (!source.isRouterEnabled()) return true;
		const pool = source.getPool();
		if (pool.models.length === 0) return true;
		const sessionModel = source.getSessionModel();
		return (sessionModel !== undefined && modelsAreEqual(sessionModel, model)) || isModelInRouterPool(pool, model);
	};
}

/** `provider/id` references of the pool, the shape the H-MoE allowlist and diagnostics use. */
export function routerPoolModelRefs(pool: RouterCandidatePool): string[] {
	return pool.models.map((model) => `${model.provider}/${model.id}`);
}

export function formatRouterPoolSourceLabel(source: RouterPoolSource): string {
	const words = interfaceText().localModels.routerStatus.poolSource;
	return source === "favorites" ? words.favorites : words[POOL_SOURCE_WORDS[source]];
}

export function formatRouterPoolSummary(pool: RouterCandidatePool): string {
	const words = interfaceText().localModels.routerStatus;
	return pool.customized
		? words.poolSelected(pool.models.length, formatRouterPoolSourceLabel(pool.source))
		: words.poolFavorite(pool.models.length);
}
