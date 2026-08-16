/**
 * Model capability auto-detection: derive what the harness may load onto a model FROM the model's
 * own metadata (`Model.contextWindow`), so small open models (4k/8k/16k windows, sub-1B params)
 * can still hold a usable chat instead of drowning in the stable prompt, tool schemas, and
 * background-lane prompts. The same class is the single input to prompt shaping and tool/lane gates.
 *
 * Derivation is metadata-first; defaults apply only when the metadata is missing (unknown/zero
 * window keeps today's full behavior rather than guessing). Detection can be disabled or forced
 * per class via the `modelCapability.mode` setting.
 */

import { GOAL_LIFECYCLE_TOOL_NAMES } from "./goals/goal-tool-names.ts";

export type ModelCapabilityClass = "full" | "lean" | "minimal" | "chat";

export type ModelCapabilityMode = "auto" | "off" | ModelCapabilityClass;

export interface ModelCapabilityProfile {
	class: ModelCapabilityClass;
	contextWindow?: number;
	reasonCode: string;
	/** Hard aggregate character envelope for the stable system prompt; undefined = intentionally unbounded. */
	systemPromptMaxChars: number | undefined;
	/** Allow-list; undefined = no allow-list restriction. */
	allowedToolNames?: readonly string[];
	/** Block-list applied after the allow-list; undefined = nothing blocked. */
	blockedToolNames?: readonly string[];
	/** Whether resource-heavy research/delegation background lanes may run on this model. */
	backgroundLanesEnabled: boolean;
	/** Output-token cap for lane isolated completions, scaled to the window. */
	laneMaxOutputTokens: number;
}

/** Windows at or above this keep the full harness surface. */
export const MODEL_CAPABILITY_FULL_MIN_CONTEXT = 32_768;
/** Windows at or above this keep core tools but shed background-autonomy extras. */
export const MODEL_CAPABILITY_LEAN_MIN_CONTEXT = 16_384;
/** Windows at or above this get the minimal coding set; below is chat-only. */
export const MODEL_CAPABILITY_MINIMAL_MIN_CONTEXT = 8_192;

/**
 * Aggregate stable-prompt envelopes. These are deliberately owned beside the classification
 * thresholds so every harness expansion must fit the same profile that owns tools and lanes.
 * Full/off profiles are intentionally unbounded; constrained profiles fail visibly on overflow.
 */
export const MODEL_CAPABILITY_SYSTEM_PROMPT_MAX_CHARS: Readonly<Record<ModelCapabilityClass, number | undefined>> = {
	full: undefined,
	lean: 8_192,
	minimal: 4_096,
	chat: 2_048,
};

export const MODEL_CAPABILITY_LEAN_BLOCKED_TOOLS: readonly string[] = [
	"delegate",
	"context_audit",
	"goal",
	"pipeline",
	"worktree_sync",
	"improvement_loop",
	"extensionify",
	"skillify",
	"model_fitness",
	"context_scout",
	"tmux_agent_manager",
];
export const MODEL_CAPABILITY_MINIMAL_ALLOWED_TOOLS: readonly string[] = [
	"read",
	"skill",
	"bash",
	"python",
	"powershell",
	"edit",
	"write",
	...GOAL_LIFECYCLE_TOOL_NAMES,
	"ask_question",
	// The executor tool: minimal-class models ARE the daily-ops executors, and its schema is tiny.
	"run_toolkit_script",
];
export const MODEL_CAPABILITY_CHAT_ALLOWED_TOOLS: readonly string[] = [...GOAL_LIFECYCLE_TOOL_NAMES];

export const DEFAULT_LANE_MAX_OUTPUT_TOKENS = 2048;
const MIN_LANE_MAX_OUTPUT_TOKENS = 256;

function laneOutputTokensForWindow(contextWindow: number | undefined): number {
	if (contextWindow === undefined || contextWindow <= 0) return DEFAULT_LANE_MAX_OUTPUT_TOKENS;
	// A lane completion may use at most an eighth of the window for output, floored so tiny
	// windows still produce something parseable.
	return Math.min(DEFAULT_LANE_MAX_OUTPUT_TOKENS, Math.max(MIN_LANE_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 8)));
}

function profileForClass(
	capabilityClass: ModelCapabilityClass,
	reasonCode: string,
	contextWindow: number | undefined,
): ModelCapabilityProfile {
	const base = {
		class: capabilityClass,
		reasonCode,
		systemPromptMaxChars: MODEL_CAPABILITY_SYSTEM_PROMPT_MAX_CHARS[capabilityClass],
		backgroundLanesEnabled: true,
		laneMaxOutputTokens: laneOutputTokensForWindow(contextWindow),
		...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}),
	};
	switch (capabilityClass) {
		case "full":
			return base;
		case "lean":
			return { ...base, blockedToolNames: MODEL_CAPABILITY_LEAN_BLOCKED_TOOLS };
		case "minimal":
			return {
				...base,
				allowedToolNames: MODEL_CAPABILITY_MINIMAL_ALLOWED_TOOLS,
				backgroundLanesEnabled: false,
			};
		case "chat":
			return {
				...base,
				allowedToolNames: MODEL_CAPABILITY_CHAT_ALLOWED_TOOLS,
				backgroundLanesEnabled: false,
			};
	}
}

/**
 * Mandatory provider-neutral gate for a final system prompt. This intentionally rejects rather
 * than truncates: arbitrary truncation can silently remove security, repair, or project rules.
 */
export function enforceModelCapabilitySystemPromptBudget(
	systemPrompt: string,
	profile: Pick<ModelCapabilityProfile, "class" | "systemPromptMaxChars">,
): string {
	const maxChars = profile.systemPromptMaxChars;
	if (maxChars === undefined || systemPrompt.length <= maxChars) return systemPrompt;
	throw new Error(
		`${profile.class} system prompt exceeds its ${maxChars}-character capability budget (${systemPrompt.length} characters). Reduce custom, extension, or harness prompt guidance, or select a more capable profile.`,
	);
}

export function deriveModelCapabilityProfile(args: {
	contextWindow?: number;
	mode?: ModelCapabilityMode;
}): ModelCapabilityProfile {
	const mode = args.mode ?? "auto";
	const contextWindow =
		args.contextWindow !== undefined && Number.isFinite(args.contextWindow) && args.contextWindow > 0
			? args.contextWindow
			: undefined;
	if (mode === "off") {
		return profileForClass("full", "detection_disabled", contextWindow);
	}
	if (mode !== "auto") {
		return profileForClass(mode, "forced_by_setting", contextWindow);
	}

	if (contextWindow === undefined) {
		// Metadata missing: defaults, never guesses.
		return profileForClass("full", "unknown_context_window_defaults", undefined);
	}
	if (contextWindow >= MODEL_CAPABILITY_FULL_MIN_CONTEXT) {
		return profileForClass("full", "large_context_window", contextWindow);
	}
	if (contextWindow >= MODEL_CAPABILITY_LEAN_MIN_CONTEXT) {
		return profileForClass("lean", "lean_context_window", contextWindow);
	}
	if (contextWindow >= MODEL_CAPABILITY_MINIMAL_MIN_CONTEXT) {
		return profileForClass("minimal", "minimal_context_window", contextWindow);
	}
	return profileForClass("chat", "chat_only_context_window", contextWindow);
}

/** Apply the profile's allow/block lists to a requested tool-name list, preserving order. */
export function filterToolNamesForCapability(toolNames: readonly string[], profile: ModelCapabilityProfile): string[] {
	let filtered = [...toolNames];
	if (profile.allowedToolNames !== undefined) {
		const allowed = new Set(profile.allowedToolNames);
		filtered = filtered.filter((name) => allowed.has(name));
	}
	if (profile.blockedToolNames !== undefined) {
		const blocked = new Set(profile.blockedToolNames);
		filtered = filtered.filter((name) => !blocked.has(name));
	}
	return filtered;
}

/**
 * Lane-worker eligibility: a session bound to a worktree-sync lane (`--worktree-lane` /
 * `PI_WORKTREE_LANE`, see worktree-sync/runtime.ts) is expected to drive the FULL multi-step
 * lane-gate/recovery surface -- sync, conflict recovery, land -- unattended. A sub-full capability
 * class or a model with no working native tool-call path cannot reliably drive that surface. This
 * rides the SAME capability system every other adaptation in this file rides (class + context
 * window + the `/toolprobe` verdict) -- no parallel mechanism, no new env var, no new registry field.
 */
export type LaneWorkerRefusalReason =
	| "capability_class_below_full"
	| "context_window_unknown"
	| "tool_calling_unadvertised"
	| "tool_calling_demoted";

export interface LaneWorkerRefusal {
	reason: LaneWorkerRefusalReason;
	capabilityClass: ModelCapabilityClass;
	contextWindow?: number;
}

/**
 * Decide whether the model described by `args` may drive a worktree-sync lane worker. First
 * failure wins, in order: capability class below full; an unknown/undeclared context window (the
 * classifier's own registry-derived SSOT -- see `deriveModelCapabilityProfile`; a full class can
 * still carry an undefined window via the `unknown_context_window_defaults` fallback); no
 * ADVERTISED native tool-call path (`Model.textToolCallProtocol` unset/false -- set true means
 * phone-only); or a GRADED `/toolprobe` demotion to "text-protocol"/"none". An UNPROBED model (no
 * verdict on record yet) is eligible on its advertised support alone -- unprobed is never treated
 * as demoted. `undefined` means eligible.
 */
export function evaluateLaneWorkerRefusal(args: {
	capabilityClass: ModelCapabilityClass;
	contextWindow: number | undefined;
	toolCallingAdvertised: boolean;
	toolCallingDemoted: boolean;
}): LaneWorkerRefusal | undefined {
	const { capabilityClass, contextWindow, toolCallingAdvertised, toolCallingDemoted } = args;
	if (capabilityClass !== "full") return { reason: "capability_class_below_full", capabilityClass, contextWindow };
	if (contextWindow === undefined) return { reason: "context_window_unknown", capabilityClass, contextWindow };
	if (!toolCallingAdvertised) return { reason: "tool_calling_unadvertised", capabilityClass, contextWindow };
	if (toolCallingDemoted) return { reason: "tool_calling_demoted", capabilityClass, contextWindow };
	return undefined;
}

/** Stable, greppable prefix for {@link formatLaneWorkerRefusal}'s output. */
export const LANE_WORKER_REFUSAL_PREFIX = "worktree-sync lane-worker refusal:";

/** Format a refusal into one deterministic, greppable line naming the lane, class, window, and reason. */
export function formatLaneWorkerRefusal(refusal: LaneWorkerRefusal, laneKey?: string): string {
	const laneSuffix = laneKey !== undefined ? ` lane=${laneKey}` : "";
	const windowText = refusal.contextWindow !== undefined ? String(refusal.contextWindow) : "unknown";
	return `${LANE_WORKER_REFUSAL_PREFIX}${laneSuffix} class=${refusal.capabilityClass} contextWindow=${windowText} reason=${refusal.reason}`;
}
