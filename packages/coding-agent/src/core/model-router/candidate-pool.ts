import type { Api, Model } from "@caupulican/pi-ai";
import { modelsAreEqual } from "@caupulican/pi-ai/models";

/**
 * The router's candidate pool is the existing Models configuration, nothing else: the session's
 * scoped models (resolved at startup from `enabledModels` / `--models`, and live-edited by the
 * Models selector) when the operator customized the list, otherwise every model with configured
 * auth. There is no second checkbox list and no hidden weight — favorites order pickers only.
 */
export interface RouterCandidatePool {
	/** True when the operator selected an explicit model list; the pool is then a hard boundary. */
	readonly customized: boolean;
	readonly models: readonly Model<Api>[];
}

export function resolveRouterCandidatePool(
	scopedModels: ReadonlyArray<{ model: Model<Api> }>,
	registry: { getAvailable(): Model<Api>[] },
): RouterCandidatePool {
	if (scopedModels.length > 0) {
		return { customized: true, models: scopedModels.map((scoped) => scoped.model) };
	}
	return { customized: false, models: registry.getAvailable() };
}

export function isModelInRouterPool(pool: RouterCandidatePool, model: Model<Api>): boolean {
	return pool.models.some((candidate) => modelsAreEqual(candidate, model));
}

/** `provider/id` references of the pool, the shape the H-MoE allowlist and diagnostics use. */
export function routerPoolModelRefs(pool: RouterCandidatePool): string[] {
	return pool.models.map((model) => `${model.provider}/${model.id}`);
}

export function formatRouterPoolSummary(pool: RouterCandidatePool): string {
	return pool.customized
		? `${pool.models.length} selected model${pool.models.length === 1 ? "" : "s"}`
		: `all enabled models (${pool.models.length})`;
}
