import type { Api, Model } from "@caupulican/pi-ai";
import { modelsAreEqual } from "@caupulican/pi-ai/models";

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

const ROUTER_POOL_SOURCE_LABELS: Record<CustomizedRouterPoolSource, string> = {
	enabled_models: "Models config",
	cli_models: "--models",
	sdk_models: "SDK scope",
	models_selector: "Models selector",
};

/** Pure projection of the session's pool provenance onto the live registry. */
export function resolveRouterCandidatePool(
	pool: RouterPoolState | undefined,
	registry: { getAvailable(): Model<Api>[] },
	options: {
		favorites: readonly { provider: string; modelId: string }[];
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

	const models = filterDisabled(registry.getAvailable()).filter(
		(model) =>
			options.favorites.some((favorite) => favorite.provider === model.provider && favorite.modelId === model.id) &&
			(!pool || pool.models.some((scoped) => modelsAreEqual(scoped, model))),
	);
	return { customized: pool !== undefined, source: pool?.source ?? "favorites", models };
}

export function isModelInRouterPool(pool: RouterCandidatePool, model: Model<Api>): boolean {
	return pool.models.some((candidate) => modelsAreEqual(candidate, model));
}

/** `provider/id` references of the pool, the shape the H-MoE allowlist and diagnostics use. */
export function routerPoolModelRefs(pool: RouterCandidatePool): string[] {
	return pool.models.map((model) => `${model.provider}/${model.id}`);
}

export function formatRouterPoolSourceLabel(source: RouterPoolSource): string {
	return source === "favorites" ? "favorites" : ROUTER_POOL_SOURCE_LABELS[source];
}

export function formatRouterPoolSummary(pool: RouterCandidatePool): string {
	return pool.customized
		? `${pool.models.length} selected model${pool.models.length === 1 ? "" : "s"} (${formatRouterPoolSourceLabel(pool.source)})`
		: `${pool.models.length} favorite model${pool.models.length === 1 ? "" : "s"}`;
}
