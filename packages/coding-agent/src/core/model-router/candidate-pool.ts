import type { Api, Model } from "@caupulican/pi-ai";
import { modelsAreEqual } from "@caupulican/pi-ai/models";
import { harnessLog } from "../../kernel/harness-log.ts";
import { interfaceText } from "../language/interface-text.ts";
import { findRenamedFreeTierModel } from "../model-registry.ts";
import {
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
} from "../orchestration/contracts.ts";

type WorkerModelReference = { provider: string; modelId: string };

export type WorkerModelReferenceResolution =
	| { ok: true; model: WorkerModelReference }
	| { ok: false; reason: "unknown" | "ambiguous" | "unavailable"; candidates: readonly string[] };

/** Resolve a delegate shorthand by configured identity before availability can bias an ambiguous match. */
export function resolveWorkerModelReference(
	reference: string,
	context?: {
		favorites: readonly WorkerModelReference[];
		catalog(): readonly Model<Api>[];
		available(): readonly Model<Api>[];
	},
): WorkerModelReferenceResolution {
	const ref = reference.trim();
	const separator = ref.indexOf("/");
	if (separator >= 0) {
		const provider = ref.slice(0, separator);
		const modelId = ref.slice(separator + 1);
		return provider &&
			modelId &&
			provider.length <= MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH &&
			modelId.length <= MAX_ORCHESTRATION_MODEL_ID_LENGTH &&
			!/\s/.test(ref)
			? { ok: true, model: { provider, modelId } }
			: { ok: false, reason: "unknown", candidates: [] };
	}
	const favorites = context?.favorites ?? [];
	const needle = ref.toLowerCase();
	let matches = favorites.filter(({ modelId }) => modelId.toLowerCase() === needle);
	if (!matches.length && favorites.length && context) {
		// Keep version numbers intact. "Sol 6.2" and "gpt-6.2-sol" can name the same favorite.
		const tokens = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}]+(?:\.[\p{N}]+)*/gu) ?? [];
		const wanted = tokens(ref);
		const favoriteRefs = new Set(favorites.map(({ provider, modelId }) => `${provider}/${modelId}`));
		const names = new Map<string, string>();
		for (const model of context.catalog()) {
			const key = `${model.provider}/${model.id}`;
			if (favoriteRefs.has(key)) names.set(key, model.name);
		}
		const nameOf = ({ provider, modelId }: WorkerModelReference) => names.get(`${provider}/${modelId}`) ?? "";
		matches = favorites.filter((favorite) => needle !== "" && nameOf(favorite).toLowerCase() === needle);
		if (!matches.length && wanted.length) {
			matches = favorites.filter((favorite) =>
				[favorite.modelId, nameOf(favorite)].some((label) => {
					const parts = tokens(label);
					return wanted.every((token) => parts.includes(token));
				}),
			);
		}
	}
	const candidates = (models: readonly WorkerModelReference[]) =>
		models.slice(0, 4).map(({ provider, modelId }) => `${provider}/${modelId}`);
	if (matches.length === 0) return { ok: false, reason: "unknown", candidates: candidates(favorites) };
	if (matches.length > 1) return { ok: false, reason: "ambiguous", candidates: candidates(matches) };
	const model = matches[0]!;
	if (
		!context?.available().some((candidate) => candidate.provider === model.provider && candidate.id === model.modelId)
	)
		return { ok: false, reason: "unavailable", candidates: candidates(matches) };
	return { ok: true, model: { provider: model.provider, modelId: model.modelId } };
}

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
	const availableKeys = new Set(available.map((model) => `${model.provider}\0${model.id}`));
	const resolvedFavoriteKeys = new Set<string>();
	for (const favorite of options.favorites) {
		const key = `${favorite.provider}\0${favorite.modelId}`;
		if (availableKeys.has(key)) {
			resolvedFavoriteKeys.add(key);
			continue;
		}
		const target = findRenamedFreeTierModel(available, favorite.provider, favorite.modelId);
		if (target) {
			resolvedFavoriteKeys.add(`${target.provider}\0${target.id}`);
		}
	}
	const scopedKeys = pool && new Set(pool.models.map((model) => `${model.provider}\0${model.id}`));
	const models = available.filter(
		(model) =>
			(resolvedFavoriteKeys.has(`${model.provider}\0${model.id}`) ||
				options.selectedAdvisorRef === `${model.provider}/${model.id}`) &&
			(!scopedKeys || scopedKeys.has(`${model.provider}\0${model.id}`)),
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
