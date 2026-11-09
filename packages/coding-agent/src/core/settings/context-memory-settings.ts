/**
 * Context and memory settings: context garbage collection, prompt enforcement, curation, memory retrieval and the
 * memory history. Each resolver is pure over the settings slice it is given; the manager delegates to them.
 */

import { DEFAULT_CONTEXT_GC_SETTINGS } from "../context-gc.ts";
import {
	clampMemoryHistoryFrontierMaxBytes,
	clampMemoryHistoryMaxConcurrentSummaries,
	clampMemoryHistoryRetentionDays,
	clampMemoryRetrievalMaxResults,
	MEMORY_HISTORY_FRONTIER_MAX_BYTES_DEFAULT,
	MEMORY_HISTORY_MAX_CONCURRENT_SUMMARIES_DEFAULT,
	MEMORY_RETRIEVAL_MAX_RESULTS_DEFAULT,
	sanitizeIntegerSetting,
} from "./settings-rules.ts";
import type { MemoryHistorySettings, MemoryRetrievalSettings, Settings } from "./settings-schema.ts";

/** Memory retrieval as written to settings, with the result count clamped when it is given. */
export function normalizeMemoryRetrievalSettings(settings: MemoryRetrievalSettings): MemoryRetrievalSettings {
	return {
		enabled: settings.enabled,
		maxResults: settings.maxResults === undefined ? undefined : clampMemoryRetrievalMaxResults(settings.maxResults),
		includeInPrompt: settings.includeInPrompt,
		allowExternalEgress: settings.allowExternalEgress,
	};
}

/** Memory history as written to settings: the summary model trimmed and the bounds clamped where given. */
export function normalizeMemoryHistorySettings(settings: MemoryHistorySettings): MemoryHistorySettings {
	return {
		hierarchy: settings.hierarchy,
		summaryModel: settings.summaryModel?.trim() || undefined,
		compactionThinkingLevel: settings.compactionThinkingLevel,
		compactionMaxUsdPerDay: settings.compactionMaxUsdPerDay,
		allowExternalSummaryEgress: settings.allowExternalSummaryEgress,
		allowExternalAdmissionEgress: settings.allowExternalAdmissionEgress,
		maxConcurrentSummaries:
			settings.maxConcurrentSummaries === undefined
				? undefined
				: clampMemoryHistoryMaxConcurrentSummaries(settings.maxConcurrentSummaries),
		frontierMaxBytes:
			settings.frontierMaxBytes === undefined
				? undefined
				: clampMemoryHistoryFrontierMaxBytes(settings.frontierMaxBytes),
		retentionDays: clampMemoryHistoryRetentionDays(settings.retentionDays),
	};
}

/** Context garbage collection, field by field, each default taken from the context-gc defaults. */
export function resolveContextGcSettings(settings: Pick<Settings, "contextGc">): {
	enabled: boolean;
	preserveRecentMessages: number;
	packStrideMessages: number;
	minToolResultChars: number;
	tools: string[];
	semanticMemory: {
		enabled: boolean;
		preserveRecentPages: number;
		minChars: number;
		markers: string[];
	};
} {
	// Per-field fallback throughout (never a whole-object `??`) so an explicit partial override --
	// e.g. only `contextGc.minToolResultChars`, or only `semanticMemory.enabled` -- still gets the
	// canonical default for every field it didn't set. Every fallback DERIVES from context-gc.ts's
	// exported DEFAULT_CONTEXT_GC_SETTINGS (the same object applyContextGc's own normalizer falls
	// back to) instead of a hand-kept copy, so this method and context-gc.ts's defaults can never
	// drift again -- hand-copied fallbacks here previously (a) missed a marker context-gc.ts's own
	// default carried, silently disabling GC packing for that page under default settings, and (b) diverged on the `tools` list (missing
	// "run_toolkit_script", present only here) -- both classes of drift are now structurally
	// impossible since there is exactly one place these defaults are written down.
	return {
		enabled: settings.contextGc?.enabled ?? DEFAULT_CONTEXT_GC_SETTINGS.enabled,
		preserveRecentMessages:
			settings.contextGc?.preserveRecentMessages ?? DEFAULT_CONTEXT_GC_SETTINGS.preserveRecentMessages,
		packStrideMessages: settings.contextGc?.packStrideMessages ?? DEFAULT_CONTEXT_GC_SETTINGS.packStrideMessages,
		minToolResultChars: settings.contextGc?.minToolResultChars ?? DEFAULT_CONTEXT_GC_SETTINGS.minToolResultChars,
		tools: settings.contextGc?.tools ?? DEFAULT_CONTEXT_GC_SETTINGS.tools,
		semanticMemory: {
			enabled: settings.contextGc?.semanticMemory?.enabled ?? DEFAULT_CONTEXT_GC_SETTINGS.semanticMemory.enabled,
			preserveRecentPages:
				settings.contextGc?.semanticMemory?.preserveRecentPages ??
				DEFAULT_CONTEXT_GC_SETTINGS.semanticMemory.preserveRecentPages,
			minChars: settings.contextGc?.semanticMemory?.minChars ?? DEFAULT_CONTEXT_GC_SETTINGS.semanticMemory.minChars,
			markers: settings.contextGc?.semanticMemory?.markers ?? DEFAULT_CONTEXT_GC_SETTINGS.semanticMemory.markers,
		},
	};
}

/** Prompt enforcement; its unset fields mirror the live context-gc settings. */
export function resolveContextPromptEnforcementSettings(
	settings: Pick<Settings, "contextPolicy">,
	gcSettings: ReturnType<typeof resolveContextGcSettings>,
): { enabled: boolean; preserveRecentMessages: number; minChars: number } {
	// Enforcement's own default MIRRORS the live context-gc settings (not a second hardcoded
	// literal) so tuning contextGc.preserveRecentMessages/minToolResultChars moves this default
	// with it instead of silently drifting. An explicitly configured enforcement value always
	// wins over the mirror -- see the ContextPromptEnforcementSettings doc comment.
	return {
		enabled: settings.contextPolicy?.enforcement?.enabled ?? false,
		preserveRecentMessages:
			settings.contextPolicy?.enforcement?.preserveRecentMessages ?? gcSettings.preserveRecentMessages,
		minChars: settings.contextPolicy?.enforcement?.minChars ?? gcSettings.minToolResultChars,
	};
}

/** Context curation: switch, optional model and the jobs-per-turn bound. */
export function resolveContextCurationSettings(settings: Pick<Settings, "contextPolicy">): {
	enabled: boolean;
	model?: string;
	maxJobsPerTurn: number;
} {
	return {
		enabled: settings.contextPolicy?.curation?.enabled ?? false,
		model: settings.contextPolicy?.curation?.model?.trim() || undefined,
		maxJobsPerTurn: sanitizeIntegerSetting(settings.contextPolicy?.curation?.maxJobsPerTurn, 4, 1, 16),
	};
}

/** Memory retrieval: switch, the clamped result count, prompt inclusion and external egress. */
export function resolveMemoryRetrievalSettings(settings: Pick<Settings, "contextPolicy">): {
	enabled: boolean;
	maxResults: number;
	includeInPrompt: boolean;
	allowExternalEgress: boolean;
} {
	return {
		enabled: settings.contextPolicy?.memory?.enabled ?? true,
		maxResults: clampMemoryRetrievalMaxResults(
			settings.contextPolicy?.memory?.maxResults ?? MEMORY_RETRIEVAL_MAX_RESULTS_DEFAULT,
		),
		includeInPrompt: settings.contextPolicy?.memory?.includeInPrompt ?? true,
		allowExternalEgress: settings.contextPolicy?.memory?.allowExternalEgress === true,
	};
}

/**
 * Memory history: hierarchy, summary model, compaction bounds, egress flags and retention, validated field by field.
 */
export function resolveMemoryHistorySettings(settings: Pick<Settings, "contextPolicy">): {
	hierarchy: boolean;
	summaryModel: string | undefined;
	compactionThinkingLevel: MemoryHistorySettings["compactionThinkingLevel"];
	compactionMaxUsdPerDay: number | undefined;
	allowExternalSummaryEgress: boolean;
	allowExternalAdmissionEgress: boolean;
	maxConcurrentSummaries: number;
	frontierMaxBytes: number;
	retentionDays: number | undefined;
} {
	const history = settings.contextPolicy?.memory?.history;
	return {
		// Stored settings are unvalidated JSON: only the boolean true opts in (as the egress flags below), and only a
		// string names a model, so a hand-edited "false" or a number never starts or breaks history construction.
		hierarchy: history?.hierarchy === true,
		summaryModel: typeof history?.summaryModel === "string" ? history.summaryModel.trim() || undefined : undefined,
		compactionThinkingLevel: ["minimal", "low", "medium", "high", "xhigh"].includes(
			String(history?.compactionThinkingLevel),
		)
			? history?.compactionThinkingLevel
			: undefined,
		compactionMaxUsdPerDay:
			typeof history?.compactionMaxUsdPerDay === "number" &&
			Number.isFinite(history.compactionMaxUsdPerDay) &&
			history.compactionMaxUsdPerDay >= 0
				? history.compactionMaxUsdPerDay
				: undefined,
		allowExternalSummaryEgress: history?.allowExternalSummaryEgress === true,
		allowExternalAdmissionEgress: history?.allowExternalAdmissionEgress === true,
		maxConcurrentSummaries: clampMemoryHistoryMaxConcurrentSummaries(
			history?.maxConcurrentSummaries ?? MEMORY_HISTORY_MAX_CONCURRENT_SUMMARIES_DEFAULT,
		),
		frontierMaxBytes: clampMemoryHistoryFrontierMaxBytes(
			history?.frontierMaxBytes ?? MEMORY_HISTORY_FRONTIER_MAX_BYTES_DEFAULT,
		),
		retentionDays: clampMemoryHistoryRetentionDays(history?.retentionDays),
	};
}
