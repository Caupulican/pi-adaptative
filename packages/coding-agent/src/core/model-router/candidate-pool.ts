import type { Api, Model } from "@caupulican/pi-ai";
import { modelsAreEqual } from "@caupulican/pi-ai/models";

/**
 * Where a customized candidate pool came from. The pool is the operator's Models configuration and
 * nothing else; every customized source is an explicit operator act (settings `enabledModels`, the
 * `--models` flag, an SDK caller's scope, or a live edit in the Models selector). An orchestration
 * profile pins the session's root model for cycling — it is never a pool source, so a profiled
 * session still routes across everything the operator enabled.
 */
export type RouterPoolSource = "all_enabled" | "enabled_models" | "cli_models" | "sdk_models" | "models_selector";

export type CustomizedRouterPoolSource = Exclude<RouterPoolSource, "all_enabled">;

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
): RouterCandidatePool {
	if (pool && pool.models.length > 0) {
		return { customized: true, source: pool.source, models: pool.models };
	}
	return { customized: false, source: "all_enabled", models: registry.getAvailable() };
}

export function isModelInRouterPool(pool: RouterCandidatePool, model: Model<Api>): boolean {
	return pool.models.some((candidate) => modelsAreEqual(candidate, model));
}

/** `provider/id` references of the pool, the shape the H-MoE allowlist and diagnostics use. */
export function routerPoolModelRefs(pool: RouterCandidatePool): string[] {
	return pool.models.map((model) => `${model.provider}/${model.id}`);
}

export function formatRouterPoolSourceLabel(source: RouterPoolSource): string {
	return source === "all_enabled" ? "all enabled" : ROUTER_POOL_SOURCE_LABELS[source];
}

export function formatRouterPoolSummary(pool: RouterCandidatePool): string {
	return pool.customized
		? `${pool.models.length} selected model${pool.models.length === 1 ? "" : "s"} (${formatRouterPoolSourceLabel(pool.source)})`
		: `all enabled models (${pool.models.length})`;
}
