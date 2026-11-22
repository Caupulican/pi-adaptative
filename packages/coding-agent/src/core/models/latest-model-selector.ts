/**
 * Dynamic latest-model selection from a live catalog: picks the newest eligible flagship or workhorse model per
 * provider, classifies version-agnostic model tiers, and resolves Antigravity effort siblings on the fly.
 */

import { ANTIGRAVITY_EFFORT_ORDER, type Api, type KnownProvider, type Model } from "@caupulican/pi-ai";
import { getModels, resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import { deriveModelCapabilityProfile } from "../model-capability.ts";
import { ORCHESTRATION_THINKING_LEVELS, type OrchestrationThinkingLevel } from "../orchestration/contracts.ts";
import { antigravityGeminiEffortFamily } from "./antigravity-effort.ts";

export type LatestModelTier = "default" | "workhorse";

export interface LatestModelSelectionOptions {
	/** `"default"` prefers the primary coding/flagship model; `"workhorse"` prefers the fast/flash-class worker model. */
	readonly tier?: LatestModelTier;
	/** Preferred Antigravity fixed-effort preset when choosing across a family's effort variants. */
	readonly preferredEffort?: OrchestrationThinkingLevel;
	/** Require `backgroundLanesEnabled` (large enough context window for autonomous workers). */
	readonly requireBackgroundLanes?: boolean;
	/** Exclude one specific model id on this provider (for example, the active foreground model). */
	readonly excludeModelId?: string;
}

/**
 * Subscription providers prioritized first when `workerDelegation.routeProviders` is empty: fast workhorse models
 * from these providers run before other authenticated subscription accounts.
 */
export const DEFAULT_WORKHORSE_PROVIDER_ORDER = ["anthropic", "google-antigravity"] as const;

/** Specialized non-agentic model ids that must never be selected for chat or coding workers. */
const NON_AGENTIC_MODEL_PATTERN =
	/(?:^|[-_/.:])(images?|img|audio|tts|stt|whisper|transcribe|realtime|live|computer-use|deep-research|safeguard|embed(?:ding)?s?|rerank(?:er)?s?|moderation|speech|voice)(?:$|[-_/.:])|:batch$/i;

const PREVIEW_MODEL_PATTERN = /(?:^|[-_/.])(preview|exp|experimental|beta|alpha)(?:$|[-_/.])/i;
const TRAILING_DATE_PATTERN =
	/-(?:20\d{6}|20\d{2}-\d{2}-\d{2}|\d{2}-20\d{2}|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|(?:2[4-9]|3\d)(?:0[1-9]|1[0-2]))$/;
const EFFORT_SUFFIX_PATTERN = new RegExp(`-(?:${ANTIGRAVITY_EFFORT_ORDER.join("|")})$`, "i");

/** Native primary lineage for first-party providers so cross-vendor models hosted on one provider do not shadow it. */
const NATIVE_PROVIDER_LINEAGE: Readonly<Record<string, string>> = {
	anthropic: "claude",
	openai: "gpt",
	"openai-codex": "gpt",
	"azure-openai-responses": "gpt",
	google: "gemini",
	"google-vertex": "gemini",
	"google-antigravity": "gemini",
	xai: "grok",
	deepseek: "deepseek",
	moonshotai: "kimi",
	"moonshotai-cn": "kimi",
	"kimi-coding": "kimi",
	zai: "glm",
	minimax: "minimax",
	"minimax-cn": "minimax",
	xiaomi: "mimo",
	"xiaomi-token-plan-cn": "mimo",
	"xiaomi-token-plan-ams": "mimo",
	"xiaomi-token-plan-sgp": "mimo",
	mistral: "mistral",
	typesafe: "jev",
};

const WORKHORSE_EFFORT_PREFERENCE: readonly string[] = ["medium", "low", "high", "xhigh"];
const DEFAULT_EFFORT_PREFERENCE: readonly string[] = ["high", "medium", "xhigh", "low"];

/** Native provider catalogs may expose identity and presets without context or price metadata. */
export type LatestModelCandidate = Pick<Model<Api>, "id" | "provider"> &
	Partial<Pick<Model<Api>, "name" | "input" | "contextWindow" | "reasoning" | "defaultThinkingLevel" | "cost">>;

interface ParsedModelFeatures<T extends LatestModelCandidate = LatestModelCandidate> {
	readonly model: T;
	readonly lineage: string;
	readonly hasVersion: boolean;
	readonly version: readonly [number, number, number];
	readonly isPreview: boolean;
	readonly isAlias: boolean;
	readonly isLatestAlias: boolean;
	readonly workhorseAffinity: number;
	readonly flagshipAffinity: number;
	readonly effortRank: number;
	readonly blendedCost: number;
}

/** Whether a catalog model is eligible to run an agentic text/coding turn. Never softened as a fallback. */
export function isEligibleAgentModel(
	model: LatestModelCandidate,
	options?: Pick<LatestModelSelectionOptions, "requireBackgroundLanes" | "excludeModelId">,
): boolean {
	if (options?.excludeModelId !== undefined && model.id === options.excludeModelId) return false;
	if (Array.isArray(model.input) && model.input.length > 0 && !model.input.includes("text")) return false;
	if (NON_AGENTIC_MODEL_PATTERN.test(model.id)) return false;
	if (options?.requireBackgroundLanes) {
		if (
			model.contextWindow === undefined ||
			!deriveModelCapabilityProfile({ contextWindow: model.contextWindow }).backgroundLanesEnabled
		)
			return false;
	}
	return true;
}

/**
 * Strip provider/gateway prefixes, tags, effort presets, and date snapshots so version and family extraction see the
 * canonical model name regardless of gateway wrapper format.
 */
function canonicalModelLeaf(modelId: string): {
	readonly leaf: string;
	readonly withoutEffort: string;
	readonly withoutDate: string;
	readonly isAlias: boolean;
	readonly isLatestAlias: boolean;
	readonly isPreview: boolean;
} {
	const rawLower = modelId.trim().toLowerCase();
	const lastSlash = rawLower.lastIndexOf("/");
	let leaf = lastSlash >= 0 ? rawLower.slice(lastSlash + 1) : rawLower;
	// Strip AWS Bedrock region/vendor prefixes like `us.anthropic.` or `zai.`
	const dotPrefix = /^(?:(?:us|eu|ap|global)\.)?(?:anthropic|amazon|meta|mistral|deepseek|google|openai|zai|cohere)\./;
	leaf = leaf.replace(dotPrefix, "");
	const colonIndex = leaf.indexOf(":");
	if (colonIndex > 0) leaf = leaf.slice(0, colonIndex);
	const withoutEffort = leaf.replace(EFFORT_SUFFIX_PATTERN, "");
	const hasDate = TRAILING_DATE_PATTERN.test(withoutEffort);
	const withoutDate = hasDate ? withoutEffort.replace(TRAILING_DATE_PATTERN, "") : withoutEffort;
	const isLatestAlias = withoutDate === "latest" || withoutDate.endsWith("-latest");
	const isPreview = PREVIEW_MODEL_PATTERN.test(withoutDate);
	return {
		leaf,
		withoutEffort,
		withoutDate,
		isAlias: isLatestAlias || !hasDate,
		isLatestAlias,
		isPreview,
	};
}

function modelLineageOf(leaf: string): string {
	if (leaf.startsWith("gemini-")) return "gemini";
	if (leaf.startsWith("gemma-") || leaf.startsWith("gemma4")) return "gemma";
	if (leaf.startsWith("claude-")) return "claude";
	if (leaf.startsWith("gpt-") || leaf.startsWith("chatgpt-") || /^o[1-9](?:[-.]|$)/.test(leaf)) return "gpt";
	if (leaf.startsWith("grok-")) return "grok";
	if (leaf.startsWith("deepseek-")) return "deepseek";
	if (leaf.startsWith("kimi-") || /^k\d+(?:\.\d+)?(?:[-]|$)/.test(leaf)) return "kimi";
	if (leaf.startsWith("glm-")) return "glm";
	if (leaf.startsWith("minimax-")) return "minimax";
	if (leaf.startsWith("mimo-")) return "mimo";
	if (
		leaf.startsWith("devstral-") ||
		leaf.startsWith("codestral-") ||
		leaf.startsWith("mistral-") ||
		leaf.startsWith("ministral-")
	) {
		return "mistral";
	}
	if (leaf.startsWith("qwen")) return "qwen";
	if (leaf.startsWith("jev-")) return "jev";
	if (leaf.startsWith("llama-") || leaf.startsWith("llama3") || leaf.startsWith("llama4")) return "llama";
	return "other";
}

/**
 * Parse a semantic generation tuple `[major, minor, patch]` from a canonical model id without mistaking parameter
 * sizes (`120b`, `27b`, `256k`) or date stamps (`20251001`, `1017`) for version numbers.
 */
export function parseModelVersionTuple(modelId: string): {
	readonly hasVersion: boolean;
	readonly version: readonly [number, number, number];
} {
	const { withoutDate } = canonicalModelLeaf(modelId);
	// Normalize Bedrock `-v1` wrapper suffix only when another version precedes it (e.g. `claude-opus-4-6-v1`).
	const stripped = withoutDate.replace(/-v\d+$/, (match, offset) =>
		/\d/.test(withoutDate.slice(0, offset)) ? "" : match,
	);
	// Normalize Fireworks `4p1` notation (`deepseek-v4p1-flash`, `glm-5p3`) to dot notation.
	const normalized = stripped.replace(/(\d)p(\d)/g, "$1.$2");

	// Dotted / semver style: `gemini-3.8-flash`, `gpt-6.2-sol`, `jev-1.14.0`, `mimo-v2.6-pro`, `k3.1-pro`, `qwen3.7-max`
	const dotted = normalized.match(/(?:^|[-_a-z])(\d{1,2})\.(\d{1,2})(?:\.(\d{1,2}))?(?=$|[-_.a-z])/);
	if (dotted) {
		const major = Number(dotted[1]);
		const minor = Number(dotted[2]);
		const patch = dotted[3] ? Number(dotted[3]) : 0;
		return { hasVersion: true, version: [major, minor, patch] };
	}

	// Hyphenated major-minor style: `claude-opus-5-5`, `claude-fable-5-2`, `deepseek-v4-1-flash`
	const hyphenPair = normalized.match(/(?:^|[-_a-z])(\d{1,2})-(\d{1,2})(?=$|[-_](?![bk]\b))/);
	if (hyphenPair && !/^\d{1,2}[bk]$/.test(hyphenPair[2]!)) {
		const afterIndex = (hyphenPair.index ?? 0) + hyphenPair[0].length;
		const suffixChar = normalized[afterIndex];
		if (suffixChar !== "b" && suffixChar !== "k") {
			return { hasVersion: true, version: [Number(hyphenPair[1]), Number(hyphenPair[2]), 0] };
		}
	}

	// Single major version: `gemini-4-hydrogen`, `gpt-6-luna`, `kimi-k3`, `MiniMax-M3`, `o4-mini`, `claude-opus-5`
	const single = normalized.match(/(?:^|[-_]|[a-z])(\d{1,2})(?=$|[-_])/);
	if (single) {
		const matchEnd = (single.index ?? 0) + single[0].length;
		const nextChar = normalized[matchEnd];
		if (nextChar !== "b" && nextChar !== "k") {
			return { hasVersion: true, version: [Number(single[1]), 0, 0] };
		}
	}

	return { hasVersion: false, version: [0, 0, 0] };
}

function compareVersionsDesc(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	if (b[0] !== a[0]) return b[0] - a[0];
	if (b[1] !== a[1]) return b[1] - a[1];
	return b[2] - a[2];
}

function hasToken(text: string, pattern: RegExp): boolean {
	return pattern.test(text);
}

/** How strongly a model belongs to the fast/workhorse tier (higher = stronger workhorse match; 0 = unrecognized). */
function workhorseAffinityOf(leaf: string, lineage: string): number {
	// Primary coding workhorses: Gemini Hydrogen (Gemini 4 Flash successor), Gemini Flash (non-lite), Claude Haiku,
	// GPT Luna/Mini, xAI Fast, DeepSeek/Xiaomi/GLM Flash.
	if (hasToken(leaf, /(?:^|[-_.])(hydrogen|haiku|luna)(?:$|[-_.])/)) return 3;
	if (hasToken(leaf, /(?:^|[-_.])flash(?:$|[-_.])/) && !hasToken(leaf, /(?:^|[-_.])lite(?:$|[-_.])/)) return 3;
	if (lineage === "grok" && hasToken(leaf, /(?:^|[-_.])fast(?:$|[-_.])/)) return 3;
	if (lineage === "gpt" && hasToken(leaf, /(?:^|[-_.])mini(?:$|[-_.])/)) return 3;
	if (hasToken(leaf, /(?:^|[-_.])(flash-lite|lite|turbo|fast|spark|highspeed|ultraspeed|instant)(?:$|[-_.])/))
		return 2;
	if (hasToken(leaf, /(?:^|[-_.])(nano|micro|mini)(?:$|[-_.])/)) return 1;
	return 0;
}

/** How strongly a model belongs to the provider's flagship/default tier. */
function flagshipAffinityOf(leaf: string, lineage: string): number {
	if (hasToken(leaf, /(?:^|[-_.])(opus|sol|neon|devstral|kimi-for-coding)(?:$|[-_.])/)) return 4;
	if (lineage === "gpt" && hasToken(leaf, /(?:^|[-_.])pro(?:$|[-_.])/)) {
		// Ultra-premium `gpt-*-pro` endpoints are specialized high-cost tiers; keep general/sol ahead when equal gen.
		return 2;
	}
	if (hasToken(leaf, /(?:^|[-_.])(pro|max|sonnet|argon|carbon|terra|astra|ultra)(?:$|[-_.])/)) return 3;
	if (hasToken(leaf, /(?:^|[-_.])fable(?:$|[-_.])/)) return 2;
	if (workhorseAffinityOf(leaf, lineage) === 0) return 3;
	if (workhorseAffinityOf(leaf, lineage) >= 2) return 1;
	return 0;
}

function effortPreferenceRank(
	model: LatestModelCandidate,
	tier: LatestModelTier,
	preferredEffort?: OrchestrationThinkingLevel,
): number {
	const effort = model.defaultThinkingLevel?.toLowerCase();
	if (!effort) return 0;
	const baseOrder = tier === "workhorse" ? WORKHORSE_EFFORT_PREFERENCE : DEFAULT_EFFORT_PREFERENCE;
	const requestedIndex = preferredEffort === undefined ? -1 : ORCHESTRATION_THINKING_LEVELS.indexOf(preferredEffort);
	const order = preferredEffort
		? [
				...ORCHESTRATION_THINKING_LEVELS.slice(0, requestedIndex + 1).reverse(),
				...ORCHESTRATION_THINKING_LEVELS.slice(requestedIndex + 1),
			]
		: baseOrder;
	const index = order.indexOf(effort);
	return index >= 0 ? order.length - index : 0;
}

function parseFeatures<T extends LatestModelCandidate>(
	model: T,
	tier: LatestModelTier,
	preferredEffort?: OrchestrationThinkingLevel,
): ParsedModelFeatures<T> {
	const { withoutDate, isAlias, isLatestAlias, isPreview } = canonicalModelLeaf(model.id);
	const lineage = modelLineageOf(withoutDate);
	const { hasVersion, version } = parseModelVersionTuple(model.id);
	const input = Number.isFinite(model.cost?.input) ? (model.cost?.input ?? 0) : 0;
	const output = Number.isFinite(model.cost?.output) ? (model.cost?.output ?? 0) : 0;
	const blendedCost = input + output;
	return {
		model,
		lineage,
		hasVersion,
		version,
		isPreview,
		isAlias,
		isLatestAlias,
		workhorseAffinity: workhorseAffinityOf(withoutDate, lineage),
		flagshipAffinity: flagshipAffinityOf(withoutDate, lineage),
		effortRank: effortPreferenceRank(model, tier, preferredEffort),
		blendedCost,
	};
}

function compareStableId(a: ParsedModelFeatures, b: ParsedModelFeatures): number {
	return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
}

/**
 * Narrow each lineage in `candidates` to its latest major generation so an older recognized workhorse (e.g. Gemini 4
 * Hydrogen) never shadows a newer generation whose codename is not yet in the keyword table (e.g. Gemini 5).
 */
function keepLatestGenerationPerLineage<T extends LatestModelCandidate>(
	candidates: readonly ParsedModelFeatures<T>[],
): ParsedModelFeatures<T>[] {
	const maxMajorByLineage = new Map<string, number>();
	for (const candidate of candidates) {
		if (!candidate.hasVersion) continue;
		const current = maxMajorByLineage.get(candidate.lineage) ?? -1;
		if (candidate.version[0] > current) maxMajorByLineage.set(candidate.lineage, candidate.version[0]);
	}
	return candidates.filter((candidate) => {
		const maxMajor = maxMajorByLineage.get(candidate.lineage);
		if (maxMajor === undefined) return true;
		// When a lineage already has versioned models, unversioned aliases (like `gemini-flash-latest` pointing at an
		// older generation) do not bypass the latest major generation.
		return candidate.hasVersion && candidate.version[0] === maxMajor;
	});
}

function compareTierCandidates(
	a: ParsedModelFeatures,
	b: ParsedModelFeatures,
	tier: LatestModelTier,
	singleLineage: boolean,
	preferEffort = false,
): number {
	const aAffinity = tier === "workhorse" ? a.workhorseAffinity : a.flagshipAffinity;
	const bAffinity = tier === "workhorse" ? b.workhorseAffinity : b.flagshipAffinity;
	const threshold = tier === "workhorse" ? 3 : 2;
	const aPrimary = aAffinity >= threshold ? 1 : 0;
	const bPrimary = bAffinity >= threshold ? 1 : 0;
	if (bPrimary !== aPrimary) return bPrimary - aPrimary;
	if (singleLineage) {
		const versionDelta = compareVersionsDesc(a.version, b.version);
		if (versionDelta !== 0) return versionDelta;
	}
	if (bAffinity !== aAffinity) return bAffinity - aAffinity;
	if (!singleLineage) {
		const versionDelta = compareVersionsDesc(a.version, b.version);
		if (versionDelta !== 0) return versionDelta;
	}
	if (!!a.model.reasoning !== !!b.model.reasoning) return a.model.reasoning ? -1 : 1;
	if (a.isPreview !== b.isPreview) return a.isPreview ? 1 : -1;
	if (a.isAlias !== b.isAlias) return a.isAlias ? -1 : 1;
	if (tier === "workhorse") {
		if (preferEffort && b.effortRank !== a.effortRank) return b.effortRank - a.effortRank;
		if (a.blendedCost !== b.blendedCost) return a.blendedCost - b.blendedCost;
		if (b.effortRank !== a.effortRank) return b.effortRank - a.effortRank;
		if (b.model.contextWindow !== a.model.contextWindow)
			return (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0);
	} else {
		if (a.isLatestAlias !== b.isLatestAlias) return a.isLatestAlias ? -1 : 1;
		if (b.effortRank !== a.effortRank) return b.effortRank - a.effortRank;
		if (b.model.contextWindow !== a.model.contextWindow)
			return (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0);
		// For the default/flagship tier, higher price breaks remaining ties toward the stronger model.
		if (a.blendedCost !== b.blendedCost) return b.blendedCost - a.blendedCost;
	}
	return compareStableId(a, b);
}

/**
 * Select the latest eligible model for `provider` on the fly from `models`.
 *
 * Returns `undefined` when no eligible general-purpose agent model exists for `provider`, so callers advance to the
 * next provider rather than falling back to an embedding, image, or other non-agentic model.
 */
export function selectLatestProviderModel<T extends LatestModelCandidate>(
	provider: string,
	models: readonly T[],
	options: LatestModelSelectionOptions = {},
): T | undefined {
	const tier = options.tier ?? "default";
	const eligible = models.filter((model) => model.provider === provider && isEligibleAgentModel(model, options));
	if (eligible.length === 0) return undefined;

	const parsed = eligible.map((model) => parseFeatures(model, tier, options.preferredEffort));
	const nativeLineage = NATIVE_PROVIDER_LINEAGE[provider];
	const nativeMatches = nativeLineage ? parsed.filter((entry) => entry.lineage === nativeLineage) : [];
	const scoped = nativeMatches.length > 0 ? nativeMatches : parsed;
	const latestGeneration = keepLatestGenerationPerLineage(scoped);
	const singleLineage = new Set(latestGeneration.map((entry) => entry.lineage)).size === 1;

	if (tier === "workhorse") {
		const recognized = latestGeneration.filter((entry) => entry.workhorseAffinity > 0);
		const pool = recognized.length > 0 ? recognized : latestGeneration;
		pool.sort((a, b) =>
			compareTierCandidates(a, b, "workhorse", singleLineage, options.preferredEffort !== undefined),
		);
		return pool[0]?.model;
	}

	const pool = [...latestGeneration];
	pool.sort((a, b) => compareTierCandidates(a, b, "default", singleLineage));
	return pool[0]?.model;
}

/**
 * Dynamic workhorse model id for a known catalog provider, used only when a low-level storage or transcript fallback
 * lacks a live ModelRegistry instance.
 */
export function defaultFallbackWorkhorseModelId(provider: KnownProvider = "anthropic"): string {
	const models = getModels(provider);
	return selectLatestProviderModel(provider, models, { tier: "workhorse" })?.id ?? models[0]?.id ?? "";
}

/**
 * Narrow sticky-high thinking predicate: only models whose ordinary default thinking is intentionally pinned to
 * `"high"` (Anthropic Claude Haiku across all generations, plus explicit `-high` Antigravity Gemini workhorse presets).
 * Tier membership alone never forces `"high"` on unrelated multi-effort workhorses.
 */
export function isStickyWorkhorseModelId(provider: string, modelId: string): boolean {
	const lower = modelId.trim().toLowerCase();
	if (provider === "anthropic") return /^claude-haiku(?:[-.]|$)/.test(lower);
	if (provider === "google-antigravity") return /^gemini-\d+(?:\.\d+)?-(?:hydrogen|flash)-high$/.test(lower);
	return false;
}

/**
 * Find the best Antigravity effort sibling in the same Gemini family for an explicit `requestedThinking` level.
 * Exact effort match wins; if the family defines no preset at `requestedThinking` at all, chooses the highest
 * eligible effort strictly above `baseModel` and below `requestedThinking` without silently escalating above it.
 */
export function resolveAntigravityEffortSibling(
	baseModel: Model<Api>,
	requestedThinking: OrchestrationThinkingLevel,
	candidates: readonly Model<Api>[],
): Model<Api> | undefined {
	const family = antigravityGeminiEffortFamily(baseModel);
	if (!family) return undefined;

	const siblings = candidates.filter(
		(candidate) =>
			candidate.provider === "google-antigravity" &&
			candidate.id !== baseModel.id &&
			antigravityGeminiEffortFamily(candidate) === family,
	);
	if (siblings.length === 0) return undefined;

	const exact = siblings.find(
		(candidate) => resolveModelThinkingLevel(candidate, requestedThinking) === requestedThinking,
	);
	if (exact) return exact;

	// If a sibling at `requestedThinking` exists in the naming scheme (low/medium/high/xhigh) we simply didn't receive
	// it in `candidates` (it was exhausted, limited, or excluded), so stay on `baseModel` rather than escalating.
	const effortOrder: readonly string[] = ANTIGRAVITY_EFFORT_ORDER;
	const requestedIndex = effortOrder.indexOf(requestedThinking);
	const baseIndex = effortOrder.indexOf(baseModel.defaultThinkingLevel ?? "");
	if (requestedIndex < 0 || baseIndex < 0 || requestedIndex <= baseIndex) return undefined;

	// Pick the highest eligible intermediate effort strictly between `baseIndex` and `requestedIndex`.
	let best: { model: Model<Api>; index: number } | undefined;
	for (const candidate of siblings) {
		const index = effortOrder.indexOf(candidate.defaultThinkingLevel ?? "");
		if (index > baseIndex && index < requestedIndex && (!best || index > best.index)) {
			best = { model: candidate, index };
		}
	}
	return best?.model;
}
