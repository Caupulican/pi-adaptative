import { createHash } from "crypto";
import { statSync } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { getAgentDir } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { GnuToolsDirSetting } from "../../utils/shell.ts";
import { stripBom } from "../../utils/text.ts";
import { directoryProfilesDir } from "../agent-paths.ts";
import type {
	HmoeIndependence,
	HmoePreference,
	HmoePreset,
	HmoeTeamStrategy,
	HmoeWeights,
} from "../expert-routing/vocabulary.ts";
import {
	DEFAULT_GOAL_AUTO_CONTINUE,
	DEFAULT_GOAL_AUTO_CONTINUE_DELAY_MS,
	DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS,
	DEFAULT_GOAL_CONTINUE_MAX_TURNS,
	DEFAULT_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
} from "../goals/goal-continuation-defaults.ts";
import { parseHttpIdleTimeoutMs } from "../http-dispatcher.ts";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "../orchestration/contracts.ts";
import { normalizeResourceProfileFilter } from "../resource-profile-blocks.ts";
import { matchesCompiledPattern } from "../util/minimatch-cache.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type {
	BedrockScopeSettings,
	DirectoryResourceProfileInfo,
	LearningPolicyLayer,
	MemorySystem,
	ModelCapabilityMode,
	ModelRouterPoolPreference,
	ModelRouterSelectionMode,
	ModelRouterSettings,
	ProfileDefinitionInput,
	ResourceProfileFilterSettings,
	ResourceProfileKind,
	ResourceProfileSettings,
	Settings,
	StreamStallBudgetSettings,
	ThinkingLevel,
	WorkbenchSettings,
	WorkerAccountPolicy,
	WorkerDelegationSettings,
	WorkerThinkingPolicy,
	WorktreeSyncPolicySetting,
} from "./settings-schema.ts";

export const MEMORY_RETRIEVAL_MAX_RESULTS_MIN = 1;

export const MEMORY_RETRIEVAL_MAX_RESULTS_MAX = 20;

export const MEMORY_RETRIEVAL_MAX_RESULTS_DEFAULT = 5;

export function clampMemoryRetrievalMaxResults(value: number): number {
	return Math.min(MEMORY_RETRIEVAL_MAX_RESULTS_MAX, Math.max(MEMORY_RETRIEVAL_MAX_RESULTS_MIN, Math.trunc(value)));
}

export const DEFAULT_AUTONOMY_MAX_STALL_TURNS = DEFAULT_GOAL_CONTINUE_MAX_STALL_TURNS;

export const DEFAULT_AUTONOMY_GOAL_CONTINUE_TURNS = DEFAULT_GOAL_CONTINUE_MAX_TURNS;

export const DEFAULT_AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES = DEFAULT_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES;

export const DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE = DEFAULT_GOAL_AUTO_CONTINUE;

export const DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS = DEFAULT_GOAL_AUTO_CONTINUE_DELAY_MS;

export const MODEL_ROUTER_SELECTION_MODES: readonly ModelRouterSelectionMode[] = ["manual", "auto", "hybrid"];

export const MODEL_ROUTER_POOL_PREFERENCES: readonly ModelRouterPoolPreference[] = ["subscription-first", "balanced"];

export const DEFAULT_MODEL_ROUTER_SELECTION_MODE: ModelRouterSelectionMode = "manual";

export const DEFAULT_MODEL_ROUTER_POOL_PREFERENCE: ModelRouterPoolPreference = "subscription-first";

export function isModelRouterSelectionMode(value: unknown): value is ModelRouterSelectionMode {
	return typeof value === "string" && (MODEL_ROUTER_SELECTION_MODES as readonly string[]).includes(value);
}

export function isModelRouterPoolPreference(value: unknown): value is ModelRouterPoolPreference {
	return typeof value === "string" && (MODEL_ROUTER_POOL_PREFERENCES as readonly string[]).includes(value);
}

export const HMOE_PRESETS: readonly HmoePreset[] = [
	"balanced",
	"quality",
	"subscription-first",
	"cost",
	"speed",
	"local-first",
	"custom",
];

export const HMOE_TEAM_STRATEGIES: readonly HmoeTeamStrategy[] = [
	"single",
	"primary_critic",
	"independent_verifier",
	"adaptive_team",
];

export const HMOE_INDEPENDENCE_LEVELS: readonly HmoeIndependence[] = [
	"none",
	"fresh_context",
	"distinct_profile",
	"distinct_model",
	"distinct_family",
	"distinct_provider",
];

export const HMOE_PREFERENCES: readonly HmoePreference[] = ["prefer_subscription", "prefer_local", "neutral"];

export function isHmoePreset(value: unknown): value is HmoePreset {
	return typeof value === "string" && (HMOE_PRESETS as readonly string[]).includes(value);
}

export function isHmoeTeamStrategy(value: unknown): value is HmoeTeamStrategy {
	return typeof value === "string" && (HMOE_TEAM_STRATEGIES as readonly string[]).includes(value);
}

export function isHmoeIndependence(value: unknown): value is HmoeIndependence {
	return typeof value === "string" && (HMOE_INDEPENDENCE_LEVELS as readonly string[]).includes(value);
}

export function isHmoePreference(value: unknown): value is HmoePreference {
	return typeof value === "string" && (HMOE_PREFERENCES as readonly string[]).includes(value);
}

export function normalizeHmoeWeights(value: unknown): HmoeWeights | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const result: HmoeWeights = {};
	const keys: (keyof HmoeWeights)[] = [
		"ability",
		"reliability",
		"operational",
		"capabilityFit",
		"reasoningFit",
		"contextFit",
		"probeFit",
		"outcomeFit",
		"cost",
		"latency",
		"availability",
		"localResourceFit",
		"diversity",
		"privacy",
	];
	for (const key of keys) {
		const val = input[key];
		if (typeof val === "number" && !Number.isNaN(val)) {
			result[key] = Math.max(0, Math.min(1, val));
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export const DEFAULT_RESEARCH_LANE_ENABLED = false;

export const DEFAULT_RESEARCH_LANE_MAX_USD = 0.25;

export const DEFAULT_RESEARCH_LANE_MAX_SOURCES = 8;

export const DEFAULT_RESEARCH_LANE_MAX_FINDINGS = 10;

export const DEFAULT_RESEARCH_LANE_MAX_WALL_CLOCK_MS = 120_000;

export const DEFAULT_RESEARCH_LANE_IDLE_DELAY_MS = 0;

export const DEFAULT_RESEARCH_LANE_MAX_RUNS_PER_SESSION = 10;

export const MAX_RESEARCH_LANE_MAX_USD = 5;

export const MAX_RESEARCH_LANE_MAX_SOURCES = 32;

export const MAX_RESEARCH_LANE_MAX_FINDINGS = 50;

export const MAX_RESEARCH_LANE_MAX_WALL_CLOCK_MS = 3_600_000;

export const MAX_RESEARCH_LANE_IDLE_DELAY_MS = 300_000;

export const MAX_RESEARCH_LANE_MAX_RUNS_PER_SESSION = 100;

export const DEFAULT_WORKER_DELEGATION_ENABLED = true;

export const DEFAULT_WORKER_DELEGATION_MAX_USD = 0;

export const DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS = 0;

/**
 * Five concurrently running subagents. The Codex CLI's own per-session default is 4 threads
 * including the root (three subagents); this is an owner-chosen raise above it, not a measured
 * optimum. Lower it in settings when the account or the box cannot take it.
 */
export const DEFAULT_WORKER_DELEGATION_MAX_CONCURRENT = 5;

export const DEFAULT_WORKER_DELEGATION_WRITE_ENABLED = true;

export const MAX_WORKER_DELEGATION_MAX_USD = Number.MAX_SAFE_INTEGER;

export const MAX_WORKER_DELEGATION_MAX_WALL_CLOCK_MS = Number.MAX_SAFE_INTEGER;

export const DEFAULT_WORKER_DELEGATION_HALT_REPORT_DEADLINE_MS = 120_000;

/** The largest delay a timer honors; anything above it fires at once. */
export const MAX_WORKER_DELEGATION_HALT_REPORT_DEADLINE_MS = 2_147_483_647;

export const MAX_WORKER_DELEGATION_MAX_CONCURRENT = Number.MAX_SAFE_INTEGER;

export const WORKER_ACCOUNT_POLICIES: readonly WorkerAccountPolicy[] = ["other", "same"];

export const DEFAULT_WORKER_DELEGATION_ACCOUNT: WorkerAccountPolicy = "other";

export const MAX_WORKER_ROUTE_PROVIDERS = 16;

export const WORKER_THINKING_POLICIES: readonly WorkerThinkingPolicy[] = ["inherit", "step_down"];

export const DEFAULT_WORKER_DELEGATION_THINKING: WorkerThinkingPolicy = "step_down";

export const DEFAULT_WORKTREE_SYNC_POLICY: WorktreeSyncPolicySetting = "on_land_mandatory";

export const DEFAULT_WORKTREE_SYNC_GATE_TIMEOUT_MS = 900_000;

export const DEFAULT_WORKTREE_SYNC_MAX_LANES = 5;

export const DEFAULT_PROCESS_MATRIX_HEARTBEAT_MS = 30_000;

export const DEFAULT_PROCESS_MATRIX_ADOPTION_GRACE_MS = 300_000;

export const DEFAULT_PROCESS_MATRIX_WATCHER_POLL_MS = 25_000;

export const DEFAULT_PROVIDER_ADMISSION_ENABLED = true;

export const DEFAULT_PROVIDER_ADMISSION_LIMITS: Readonly<Record<string, number>> = Object.freeze({});

export const DEFAULT_PROVIDER_ADMISSION_MAX_WAIT_MS = 120_000;

export const DEFAULT_PROVIDER_ADMISSION_FOREGROUND_LIMIT_WAIT_MS = 60_000;

export const MAX_PROVIDER_ADMISSION_MAX_WAIT_MS = 3_600_000;

export const MAX_PROVIDER_ADMISSION_LIMIT = 10_000;

export const DEFAULT_TOOL_EXECUTION_CONCURRENCY = 8;

export const MIN_TOOL_EXECUTION_CONCURRENCY = 1;

export const MAX_TOOL_EXECUTION_CONCURRENCY = 32;

export const MIN_BACKGROUND_TOOL_CALL_AFTER_MS = 0;

export const MAX_BACKGROUND_TOOL_CALL_AFTER_MS = 3_600_000;

export function sanitizeGnuToolsDirSetting(value: unknown): GnuToolsDirSetting {
	if (typeof value !== "string") return "auto";
	const trimmed = value.trim();
	return trimmed === "" ? "auto" : trimmed;
}

export const DEFAULT_LEARNING_POLICY_ENABLED = true;

export const DEFAULT_LEARNING_POLICY_AUTO_APPLY_ENABLED = true;

export const DEFAULT_LEARNING_POLICY_CONFIDENCE_THRESHOLD = 50;

export const DEFAULT_LEARNING_POLICY_MIN_OBSERVATIONS = 1;

export const DEFAULT_LEARNING_POLICY_ALLOWED_AUTO_APPLY_LAYERS: readonly LearningPolicyLayer[] = ["memory", "skill"];

export const DEFAULT_LEARNING_POLICY_REFLECTION_SOURCE_CONFIDENCE = 50;

export const DEFAULT_LEARNING_POLICY_AUTO_APPLY_SUPERSESSIONS = false;

export const DEFAULT_MODEL_CAPABILITY_MODE: ModelCapabilityMode = "auto";

export const MAX_BEDROCK_SCOPE_MODEL_IDS = 16;

export const MAX_BEDROCK_MODEL_ID_CHARS = 512;

export function normalizeBedrockScopeSettings(
	value: BedrockScopeSettings | undefined,
): BedrockScopeSettings | undefined {
	if (!value || typeof value !== "object") return undefined;
	const region = typeof value.region === "string" ? value.region.trim().toLowerCase() : "";
	if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(region)) return undefined;

	const profile = typeof value.profile === "string" ? value.profile.trim() : undefined;
	if (
		profile !== undefined &&
		(profile.length === 0 || profile.length > 256 || /[\u0000-\u001f\u007f]/.test(profile))
	) {
		return undefined;
	}

	if (!Array.isArray(value.modelIds)) return undefined;
	const modelIds = [
		...new Set(
			value.modelIds
				.filter((id): id is string => typeof id === "string")
				.map((id) => id.trim())
				.filter(
					(id) => id.length > 0 && id.length <= MAX_BEDROCK_MODEL_ID_CHARS && !/[\u0000-\u001f\u007f]/.test(id),
				),
		),
	];
	if (modelIds.length === 0 || modelIds.length > MAX_BEDROCK_SCOPE_MODEL_IDS) return undefined;

	const verifiedAt = typeof value.verifiedAt === "string" ? value.verifiedAt.trim() : "";
	if (!verifiedAt || !Number.isFinite(Date.parse(verifiedAt))) return undefined;
	if (value.verification !== "identity+control-plane+runtime" && value.verification !== "runtime") {
		return undefined;
	}

	return {
		region,
		...(profile ? { profile } : {}),
		modelIds,
		verifiedAt,
		verification: value.verification,
	};
}

export const DEFAULT_WORKBENCH_SETTINGS: Readonly<Required<WorkbenchSettings>> = Object.freeze({
	mouse: "on",
	rows: "half",
	collapsed: false,
	inspector: "shown",
	executionMaximized: false,
	inspectorFraction: 0.3,
	layout: "stacked",
	conversationFraction: 0.5,
	previews: 24,
	graph: "shown",
	graphFraction: 0.32,
	graphView: "diagram",
});

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
export function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// For nested objects, merge recursively
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = deepMergeSettings(baseValue as Settings, overrideValue as Settings);
		} else {
			// For primitives and arrays, override value wins
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

export function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

export function findDirectoryProfileRoot(cwd: string): string {
	let current = resolvePath(cwd);
	while (true) {
		for (const marker of [".git", ".hg", ".svn"]) {
			try {
				statSync(join(current, marker));
				return current;
			} catch {}
		}
		const parent = resolve(current, "..");
		if (parent === current) return resolvePath(cwd);
		current = parent;
	}
}

export function getDirectoryResourceProfileInfo(
	cwd: string,
	agentDir: string = getAgentDir(),
): DirectoryResourceProfileInfo {
	const root = findDirectoryProfileRoot(cwd);
	const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
	return {
		root,
		hash,
		path: join(directoryProfilesDir(resolvePath(agentDir)), hash, "settings.json"),
	};
}

export function getResourceProfileMatchCandidates(resourcePath: string, baseDir: string): readonly string[] {
	const resolvedBase = baseDir ? resolvePath(baseDir) : "";
	const rel = resolvedBase ? toPosixPath(relative(resolvedBase, resourcePath)) : toPosixPath(resourcePath);
	const name = basename(resourcePath);
	const filePathPosix = toPosixPath(resourcePath);
	const parentDir = dirname(resourcePath);
	const parentRel = resolvedBase ? toPosixPath(relative(resolvedBase, parentDir)) : toPosixPath(parentDir);
	const parentName = basename(parentDir);
	const parentDirPosix = toPosixPath(parentDir);
	return [rel, name, filePathPosix, parentRel, parentName, parentDirPosix];
}

export function matchesResourceProfilePattern(resourcePath: string, patterns: string[], baseDir = ""): boolean {
	if (patterns.length === 0) return false;
	const candidates = getResourceProfileMatchCandidates(resourcePath, baseDir);
	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(pattern);
		return candidates.some((candidate) => matchesCompiledPattern(candidate, normalizedPattern));
	});
}

export function matchesExactResourceProfilePattern(resourcePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const candidates = getResourceProfileMatchCandidates(resourcePath, baseDir);
	return patterns.some((pattern) => {
		const withoutRelativePrefix = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
		return candidates.includes(toPosixPath(withoutRelativePrefix));
	});
}

/** Canonical `!`/`+`/`-` precedence for top-level resource selector overrides. */
export function isResourceEnabledByTopLevelOverrides(resourcePath: string, entries: string[], baseDir = ""): boolean {
	const overrides = entries.filter(
		(pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"),
	);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = !matchesResourceProfilePattern(resourcePath, excludes, baseDir);
	if (matchesExactResourceProfilePattern(resourcePath, forceIncludes, baseDir)) enabled = true;
	if (matchesExactResourceProfilePattern(resourcePath, forceExcludes, baseDir)) enabled = false;
	return enabled;
}

export function normalizeResourceProfileNames(value: unknown): string[] {
	const values: string[] = [];
	const add = (candidate: unknown) => {
		if (Array.isArray(candidate)) {
			for (const item of candidate) add(item);
			return;
		}
		if (typeof candidate === "string") {
			for (const part of candidate.split(",")) {
				const trimmed = part.trim();
				if (trimmed) values.push(trimmed);
			}
		}
	};
	add(value);
	return [...new Set(values)];
}

export function hasExplicitActiveResourceProfileSelection(settings: Settings): boolean {
	return Object.hasOwn(settings, "activeResourceProfiles") || Object.hasOwn(settings, "activeResourceProfile");
}

export function hasExplicitEmptyActiveResourceProfileSelection(settings: Settings): boolean {
	return (
		Object.hasOwn(settings, "activeResourceProfiles") &&
		normalizeResourceProfileNames(settings.activeResourceProfiles).length === 0
	);
}

export function normalizeActiveResourceProfiles(settings: Settings): string[] {
	// The array form is canonical when present, including an explicit empty array. Falling through
	// from `activeResourceProfiles: []` to the scalar alias would resurrect a lower-precedence or
	// legacy selection and makes it impossible to persist a durable "none" choice.
	const values = Object.hasOwn(settings, "activeResourceProfiles")
		? normalizeResourceProfileNames(settings.activeResourceProfiles)
		: normalizeResourceProfileNames(settings.activeResourceProfile);
	if (
		values.length === 0 &&
		!hasExplicitActiveResourceProfileSelection(settings) &&
		settings.resourceProfiles?.default
	) {
		values.push("default");
	}
	return [...new Set(values)];
}

export function appendFilter(target: ResourceProfileFilterSettings, source?: ResourceProfileFilterSettings): void {
	if (!source) return;
	if (Array.isArray(source.allow)) target.allow = [...(target.allow ?? []), ...source.allow];
	if (Array.isArray(source.block)) target.block = [...(target.block ?? []), ...source.block];
}

export function collectLegacyDisabledFilterFromSettings(
	settings: Settings,
	kind: ResourceProfileKind,
): ResourceProfileFilterSettings {
	const legacyDisabled = settings.disabledResources?.[kind];
	return Array.isArray(legacyDisabled) ? { block: legacyDisabled } : {};
}

export function isResourceDisabledByTopLevelOverrides(
	settings: Settings,
	kind: ResourceProfileKind,
	resourcePath: string,
	baseDir: string,
): boolean {
	if (kind === "agents" || kind === "tools") return false;
	const entries = settings[kind];
	if (!Array.isArray(entries)) return false;
	return !isResourceEnabledByTopLevelOverrides(resourcePath, entries, baseDir);
}

export function mergeResourceProfileFilters(
	...filters: ResourceProfileFilterSettings[]
): ResourceProfileFilterSettings {
	const result: ResourceProfileFilterSettings = {};
	for (const filter of filters) appendFilter(result, filter);
	return result;
}

export function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

/** Stall bounds must be strictly positive — 0 is not "disabled" here (it would stall instantly). */
/** True when a stall block still carries the pre-split, class-less bounds. */
export function hasLegacyStreamStallBounds(stall: StreamStallBudgetSettings | undefined): boolean {
	return stall?.connectMs !== undefined || stall?.activeIdleMs !== undefined || stall?.quietIdleMs !== undefined;
}

export function parseStallBoundMs(value: unknown, settingName: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return Math.floor(value);
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

export function sanitizeIntegerSetting(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
	if (value < min || value > max) return fallback;
	return value;
}

export function sanitizeNumberSetting(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value < min || value > max) return fallback;
	return value;
}

export function reportInvalidWorkerDelegationField(
	reportDiagnostic: WorkerDelegationDiagnosticReporter | undefined,
	field: keyof WorkerDelegationSettings,
	expectation: string,
): void {
	reportDiagnostic?.(`workerDelegation.${field} must be ${expectation}; the configured value was ignored`);
}

/** Normalize one precedence layer before merging so malformed overrides cannot widen lower-scope authority. */
export function normalizeWorkerDelegationLayer(
	value: unknown,
	reportDiagnostic?: WorkerDelegationDiagnosticReporter,
): WorkerDelegationSettings | undefined {
	if (!isPlainRecord(value)) {
		if (value !== undefined)
			reportDiagnostic?.("workerDelegation must be an object; the configured value was ignored");
		return undefined;
	}
	const normalized: WorkerDelegationSettings = {};
	if (Object.hasOwn(value, "enabled")) {
		if (typeof value.enabled === "boolean") normalized.enabled = value.enabled;
		else reportInvalidWorkerDelegationField(reportDiagnostic, "enabled", "a boolean");
	}
	if (Object.hasOwn(value, "orchestrationProfile")) {
		if (typeof value.orchestrationProfile === "string") {
			const profileId = value.orchestrationProfile.trim();
			if (profileId && profileId.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH) {
				normalized.orchestrationProfile = profileId;
			} else {
				reportInvalidWorkerDelegationField(
					reportDiagnostic,
					"orchestrationProfile",
					`a nonempty string of at most ${MAX_ORCHESTRATION_IDENTIFIER_LENGTH} characters`,
				);
			}
		} else {
			reportInvalidWorkerDelegationField(
				reportDiagnostic,
				"orchestrationProfile",
				`a nonempty string of at most ${MAX_ORCHESTRATION_IDENTIFIER_LENGTH} characters`,
			);
		}
	}
	if (Object.hasOwn(value, "maxUsd")) {
		if (
			typeof value.maxUsd === "number" &&
			Number.isFinite(value.maxUsd) &&
			value.maxUsd >= 0 &&
			value.maxUsd <= MAX_WORKER_DELEGATION_MAX_USD
		) {
			normalized.maxUsd = value.maxUsd;
		} else {
			reportInvalidWorkerDelegationField(
				reportDiagnostic,
				"maxUsd",
				`a finite number between 0 and ${MAX_WORKER_DELEGATION_MAX_USD}`,
			);
		}
	}
	if (Object.hasOwn(value, "maxWallClockMs")) {
		if (
			typeof value.maxWallClockMs === "number" &&
			Number.isSafeInteger(value.maxWallClockMs) &&
			value.maxWallClockMs >= 0 &&
			value.maxWallClockMs <= MAX_WORKER_DELEGATION_MAX_WALL_CLOCK_MS
		) {
			normalized.maxWallClockMs = value.maxWallClockMs;
		} else {
			reportInvalidWorkerDelegationField(
				reportDiagnostic,
				"maxWallClockMs",
				`a safe integer between 0 and ${MAX_WORKER_DELEGATION_MAX_WALL_CLOCK_MS}`,
			);
		}
	}
	if (Object.hasOwn(value, "writeEnabled")) {
		if (typeof value.writeEnabled === "boolean") normalized.writeEnabled = value.writeEnabled;
		else reportInvalidWorkerDelegationField(reportDiagnostic, "writeEnabled", "a boolean");
	}
	if (Object.hasOwn(value, "haltReportDeadlineMs")) {
		if (
			typeof value.haltReportDeadlineMs === "number" &&
			Number.isSafeInteger(value.haltReportDeadlineMs) &&
			value.haltReportDeadlineMs > 0 &&
			value.haltReportDeadlineMs <= MAX_WORKER_DELEGATION_HALT_REPORT_DEADLINE_MS
		) {
			normalized.haltReportDeadlineMs = value.haltReportDeadlineMs;
		} else {
			reportInvalidWorkerDelegationField(
				reportDiagnostic,
				"haltReportDeadlineMs",
				`a safe integer between 1 and ${MAX_WORKER_DELEGATION_HALT_REPORT_DEADLINE_MS}`,
			);
		}
	}
	if (Object.hasOwn(value, "maxConcurrent")) {
		if (
			typeof value.maxConcurrent === "number" &&
			Number.isSafeInteger(value.maxConcurrent) &&
			value.maxConcurrent > 0 &&
			value.maxConcurrent <= MAX_WORKER_DELEGATION_MAX_CONCURRENT
		) {
			normalized.maxConcurrent = value.maxConcurrent;
		} else {
			reportInvalidWorkerDelegationField(
				reportDiagnostic,
				"maxConcurrent",
				`a safe integer between 1 and ${MAX_WORKER_DELEGATION_MAX_CONCURRENT}`,
			);
		}
	}
	if (Object.hasOwn(value, "account")) {
		if (typeof value.account === "string" && WORKER_ACCOUNT_POLICIES.includes(value.account as WorkerAccountPolicy)) {
			normalized.account = value.account as WorkerAccountPolicy;
		} else {
			reportInvalidWorkerDelegationField(
				reportDiagnostic,
				"account",
				`one of ${WORKER_ACCOUNT_POLICIES.join(", ")}`,
			);
		}
	}
	if (Object.hasOwn(value, "routeProviders")) {
		if (
			Array.isArray(value.routeProviders) &&
			value.routeProviders.length <= MAX_WORKER_ROUTE_PROVIDERS &&
			value.routeProviders.every(
				(entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 200,
			)
		) {
			normalized.routeProviders = (value.routeProviders as string[]).map((entry) => entry.trim());
		} else {
			reportInvalidWorkerDelegationField(
				reportDiagnostic,
				"routeProviders",
				`an array of at most ${MAX_WORKER_ROUTE_PROVIDERS} nonempty strings (provider or provider/modelId)`,
			);
		}
	}
	if (Object.hasOwn(value, "routeProvidersByRole")) {
		const byRole: Record<string, string[]> = {};
		let valid = isPlainRecord(value.routeProvidersByRole);
		if (valid) {
			for (const [role, entries] of Object.entries(value.routeProvidersByRole as Record<string, unknown>)) {
				if (
					!role.trim() ||
					!Array.isArray(entries) ||
					entries.length > MAX_WORKER_ROUTE_PROVIDERS ||
					!entries.every((entry) => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 200)
				) {
					valid = false;
					break;
				}
				byRole[role.trim()] = (entries as string[]).map((entry) => entry.trim());
			}
		}
		if (valid) normalized.routeProvidersByRole = byRole;
		else {
			reportInvalidWorkerDelegationField(
				reportDiagnostic,
				"routeProvidersByRole",
				"an object of role -> array of provider or provider/modelId strings",
			);
		}
	}
	if (Object.hasOwn(value, "thinking")) {
		if (
			typeof value.thinking === "string" &&
			WORKER_THINKING_POLICIES.includes(value.thinking as WorkerThinkingPolicy)
		) {
			normalized.thinking = value.thinking as WorkerThinkingPolicy;
		} else {
			reportInvalidWorkerDelegationField(
				reportDiagnostic,
				"thinking",
				`one of ${WORKER_THINKING_POLICIES.join(", ")}`,
			);
		}
	}
	return normalized;
}

export function mergeWorkerDelegationLayers(...layers: unknown[]): WorkerDelegationSettings | undefined {
	let merged: WorkerDelegationSettings | undefined;
	for (const layer of layers) {
		const normalized = normalizeWorkerDelegationLayer(layer);
		if (!normalized) continue;
		merged = { ...(merged ?? {}), ...normalized };
	}
	return merged;
}

/** Validate a memory system value; returns true only for known, allowed values. */
export function isValidMemorySystem(value: unknown): value is MemorySystem {
	return typeof value === "string" && (value === "okf" || value === "icm");
}

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && VALID_THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function normalizeProfileFilterResource(value: unknown): ResourceProfileFilterSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("resource profile filter must be an object");
	}
	return normalizeResourceProfileFilter(value as Record<string, unknown>);
}

export function normalizeProfileResources(value: unknown): ResourceProfileSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("resources must be an object");
	}
	const input = value as Record<string, unknown>;
	const result: ResourceProfileSettings = {};
	for (const kind of ["extensions", "skills", "prompts", "themes", "agents", "tools"] as const) {
		if (input[kind] === undefined) continue;
		result[kind] = normalizeProfileFilterResource(input[kind]);
	}
	return result;
}

export function normalizeModelRouterSettings(value: unknown): ModelRouterSettings | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const settings: ModelRouterSettings = {};
	for (const key of ["enabled", "fitnessGate"] as const) {
		if (typeof input[key] === "boolean") settings[key] = input[key];
	}
	if (isModelRouterSelectionMode(input.selectionMode)) settings.selectionMode = input.selectionMode;
	if (isModelRouterPoolPreference(input.poolPreference)) settings.poolPreference = input.poolPreference;
	for (const key of ["cheapModel", "mediumModel", "expensiveModel", "learningModel", "executorModel"] as const) {
		const candidate = input[key];
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed) settings[key] = trimmed;
	}
	for (const key of ["cheapThinking", "mediumThinking", "expensiveThinking", "executorThinking"] as const) {
		const candidate = input[key];
		if (isThinkingLevel(candidate)) settings[key] = candidate;
	}
	if (isHmoePreset(input.hmoePreset)) settings.hmoePreset = input.hmoePreset;
	if (isHmoeTeamStrategy(input.hmoeTeamStrategy)) settings.hmoeTeamStrategy = input.hmoeTeamStrategy;
	if (isHmoeIndependence(input.hmoeIndependence)) settings.hmoeIndependence = input.hmoeIndependence;
	if (isHmoePreference(input.hmoePreference)) settings.hmoePreference = input.hmoePreference;
	const weights = normalizeHmoeWeights(input.hmoeWeights);
	if (weights) settings.hmoeWeights = weights;
	return Object.keys(settings).length > 0 ? settings : undefined;
}

export function parseProfileFileDefinition(content: string, fallbackName?: string): ProfileDefinitionInput {
	const parsed = JSON.parse(stripBom(content)) as Record<string, unknown>;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("profile file must contain a JSON object");
	}
	const name = (typeof parsed.name === "string" ? parsed.name.trim() : undefined) || fallbackName;
	if (!name) {
		throw new Error("profile name is required");
	}
	const resourceSection = parsed.resources ?? {};
	return {
		name,
		description: typeof parsed.description === "string" ? parsed.description.trim() || undefined : undefined,
		model: typeof parsed.model === "string" ? parsed.model.trim() || undefined : undefined,
		thinking: isThinkingLevel(parsed.thinking) ? parsed.thinking : undefined,
		modelRouter: normalizeModelRouterSettings(parsed.modelRouter),
		soul: typeof parsed.soul === "string" ? parsed.soul.trim() || undefined : undefined,
		resources: normalizeProfileResources(resourceSection),
	};
}

export type WorkerDelegationDiagnosticReporter = (message: string) => void;
