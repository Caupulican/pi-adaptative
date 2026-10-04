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

import {
	type Api,
	MIN_TOOL_SCHEMA_DISCLOSURE_SEARCHABLE_TOOLS,
	type Model,
	supportsToolSchemaDisclosure,
	TOOL_SCHEMA_SEARCH_NAME,
} from "@caupulican/pi-ai";
import type { ModelCapabilityClass } from "./capability-tier.ts";
import { GOAL_LIFECYCLE_TOOL_NAMES } from "./goals/goal-tool-names.ts";
import type { ModelToolProtocolResolution } from "./model-tool-protocol.ts";
import { SYSTEM_ONE_TOOL_NAME } from "./system-one/tool-names.ts";

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
	// 11,264 characters is about 2,750 tokens: 17 % of the 16k window that defines the lean class.
	// The previous 8,192 left under 100 characters of margin once tool schemas and a Windows temp
	// path were in place (bug ledger 155), so any guidance change overflowed it.
	lean: 11_264,
	minimal: 5_120,
	chat: 3_072,
};

/**
 * Aggregate rendered budget for tool-guideline bullets. Individual tool definitions retain their
 * own prose bound; constrained profiles additionally need one cross-tool ceiling so platform-only
 * guidance cannot overflow the stable system-prompt envelope. The builder admits one rule per tool
 * before lower-priority rules, preserving each tool owner's first-rule priority convention.
 */
export const MODEL_CAPABILITY_TOOL_GUIDELINES_MAX_CHARS: Readonly<Record<ModelCapabilityClass, number | undefined>> = {
	full: undefined,
	lean: 3_584,
	minimal: 1_536,
	chat: 0,
};

export const MODEL_CAPABILITY_LEAN_BLOCKED_TOOLS: readonly string[] = [
	"delegate",
	"context_audit",
	// Durable goals drive multi-step autonomous continuation: complex agentic work that needs class "full".
	"goal",
	...GOAL_LIFECYCLE_TOOL_NAMES,
	"pipeline",
	"worktree_sync",
	"improvement_loop",
	"extensionify",
	"skillify",
	"model_fitness",
	"context_scout",
	"pi_collaboration",
	"list_peers",
	"agent_send",
	"task_automation",
];
export const MODEL_CAPABILITY_MINIMAL_ALLOWED_TOOLS: readonly string[] = [
	"read",
	TOOL_SCHEMA_SEARCH_NAME,
	"skill",
	"bash",
	"python",
	"powershell",
	"edit",
	"write",
	"ask_question",
	// The executor tool: minimal-class models ARE the daily-ops executors, and its schema is tiny.
	"run_toolkit_script",
	SYSTEM_ONE_TOOL_NAME,
];
// Independent semantic assistance is available across model classes; authority filters still apply.
export const MODEL_CAPABILITY_CHAT_ALLOWED_TOOLS: readonly string[] = [SYSTEM_ONE_TOOL_NAME];

export const DEFAULT_LANE_MAX_OUTPUT_TOKENS = 2048;
const MIN_LANE_MAX_OUTPUT_TOKENS = 256;

/**
 * Output cap for a worker's own provider turns when the model declares no usable limit. Matches the
 * registry default for custom models; the lane summary cap is never the answer here.
 */
export const DEFAULT_WORKER_MAX_OUTPUT_TOKENS = 16_384;

function laneOutputTokensForWindow(contextWindow: number | undefined): number {
	if (contextWindow === undefined || contextWindow <= 0) return DEFAULT_LANE_MAX_OUTPUT_TOKENS;
	// A lane completion may use at most an eighth of the window for output, floored so tiny
	// windows still produce something parseable.
	return Math.min(DEFAULT_LANE_MAX_OUTPUT_TOKENS, Math.max(MIN_LANE_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 8)));
}

/**
 * Output cap for one worker agent turn: the model's own output limit. The lane cap above bounds
 * one-shot summary completions (research, fitness, compaction); a worker turn carries a full claim
 * envelope, file contents and tool arguments. Measured live (session 01a07461): two workers that
 * emitted complete 7.7k-character envelopes were cut at the 2048-token lane cap, reported as
 * "not valid structured JSON", and $1.26 of evidence was lost. Budget narrowing still applies
 * downstream (remaining attempt and tree token budgets, then the model limit again at transport).
 */
export function resolveWorkerOutputTokenCeiling(model: { maxTokens?: number }): number {
	const declared = model.maxTokens;
	return typeof declared === "number" && Number.isSafeInteger(declared) && declared > 0
		? declared
		: DEFAULT_WORKER_MAX_OUTPUT_TOKENS;
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
export function filterToolNamesForCapability(
	toolNames: readonly string[],
	profile: ModelCapabilityProfile,
	model?: {
		provider: string;
		api?: string;
		id?: string;
		baseUrl?: string;
		compat?: unknown;
	},
): string[] {
	let filtered = toolNames.filter((name) => name !== "image_generate" || model?.provider === "openai-codex");
	if (profile.allowedToolNames !== undefined) {
		const allowed = new Set(profile.allowedToolNames);
		filtered = filtered.filter((name) => allowed.has(name));
	}
	if (profile.blockedToolNames !== undefined) {
		const blocked = new Set(profile.blockedToolNames);
		filtered = filtered.filter((name) => !blocked.has(name));
	}
	const toolSearchSupported =
		filtered.filter((name) => name !== TOOL_SCHEMA_SEARCH_NAME).length >=
			MIN_TOOL_SCHEMA_DISCLOSURE_SEARCHABLE_TOOLS &&
		model?.api !== undefined &&
		model.id !== undefined &&
		model.baseUrl !== undefined
			? supportsToolSchemaDisclosure({
					api: model.api,
					id: model.id,
					baseUrl: model.baseUrl,
					provider: model.provider,
					compat: model.compat,
				})
			: false;
	filtered = filtered.filter((name) => name !== TOOL_SCHEMA_SEARCH_NAME || toolSearchSupported);
	return filtered;
}

/**
 * Lane-worker eligibility: a worker (a session bound to a worktree-sync lane, a launched collaboration
 * child, or an in-process delegated worker) is expected to drive complex multi-step agentic work
 * unattended. A sub-full capability class, a model whose context window or tool-call support is not
 * declared, or a model with no working native tool-call path cannot do that, so the harness neither
 * enforces nor allows it. This rides the SAME capability system every other adaptation in this file
 * rides (class + context window + the tool-protocol resolution) -- no parallel mechanism.
 */
export type LaneWorkerRefusalReason =
	| "capability_class_below_full"
	| "model_unresolved"
	| "context_window_unknown"
	| "tool_calling_unadvertised"
	| "tool_calling_unknown"
	| "tool_calling_demoted";

export interface LaneWorkerRefusal {
	reason: LaneWorkerRefusalReason;
	capabilityClass: ModelCapabilityClass;
	contextWindow?: number;
}

/** Whether a model advertises native tool calling: declared yes, declared no (phone-only), or not declared. */
export type LaneWorkerToolCalling = "advertised" | "unadvertised" | "unknown";

/**
 * Decide whether the model described by `args` may drive a lane worker. First failure wins, in
 * order: capability class below full; an unknown/undeclared context window (`undefined`; a
 * registry-defaulted window is not a declaration); native tool calling the model itself declares
 * absent (phone-only); a tool-call route the evidence gate or an operator setting demoted off the
 * native path; or tool-call support that is declared nowhere and proven by no probe. `undefined`
 * means eligible.
 */
export function evaluateLaneWorkerRefusal(args: {
	capabilityClass: ModelCapabilityClass;
	contextWindow: number | undefined;
	toolCalling: LaneWorkerToolCalling;
	toolCallingDemoted: boolean;
}): LaneWorkerRefusal | undefined {
	const { capabilityClass, contextWindow, toolCalling, toolCallingDemoted } = args;
	if (capabilityClass !== "full") return { reason: "capability_class_below_full", capabilityClass, contextWindow };
	if (contextWindow === undefined) return { reason: "context_window_unknown", capabilityClass, contextWindow };
	if (toolCalling === "unadvertised") return { reason: "tool_calling_unadvertised", capabilityClass, contextWindow };
	if (toolCallingDemoted) return { reason: "tool_calling_demoted", capabilityClass, contextWindow };
	if (toolCalling === "unknown") return { reason: "tool_calling_unknown", capabilityClass, contextWindow };
	return undefined;
}

/**
 * Lane-worker eligibility of one concrete model. The tool-call facts come from the single
 * transport resolver (`resolveModelToolProtocol`, passed in as its resolution) so settings
 * overrides, model hints and probe verdicts keep their one precedence order here too: native proven
 * by a probe or forced by settings is advertised; a model that declares text-only is unadvertised; a
 * text protocol or no-working-route outcome is demoted; otherwise the model's own declaration
 * decides, and an undeclared one is unknown.
 */
export function evaluateLaneWorkerModelRefusal(args: {
	model: Pick<Model<Api>, "contextWindow" | "contextWindowDefaulted" | "toolCallingUndeclared">;
	capabilityMode?: ModelCapabilityMode;
	toolProtocol: ModelToolProtocolResolution;
}): LaneWorkerRefusal | undefined {
	const { model, capabilityMode, toolProtocol } = args;
	const profile = deriveModelCapabilityProfile({ contextWindow: model.contextWindow, mode: capabilityMode });
	let toolCalling: LaneWorkerToolCalling = model.toolCallingUndeclared === true ? "unknown" : "advertised";
	let toolCallingDemoted = false;
	switch (toolProtocol.reasonCode) {
		case "settings_disabled":
		case "probe_native":
			toolCalling = "advertised";
			break;
		case "model_enabled":
			toolCalling = "unadvertised";
			break;
		case "settings_enabled":
		case "probe_calibrated":
		case "probe_no_working_path":
		case "probe_calibration_missing":
		case "probe_calibration_failed":
		case "probe_calibration_invalid":
			toolCallingDemoted = true;
			break;
		case "native_default":
			break;
	}
	return evaluateLaneWorkerRefusal({
		capabilityClass: profile.class,
		contextWindow: model.contextWindowDefaulted === true ? undefined : profile.contextWindow,
		toolCalling,
		toolCallingDemoted,
	});
}

/** Stable skip-reason code a refused worker launch/dispatch reports; the granular refusal follows it. */
export const WORKER_CAPABILITY_INSUFFICIENT_SKIP_REASON = "worker_capability_insufficient";

/** The skip reason for a refused worker: the stable code plus `reason`, `class` and `contextWindow`. */
export function laneWorkerRefusalSkipReason(refusal: LaneWorkerRefusal): string {
	const windowText = refusal.contextWindow !== undefined ? String(refusal.contextWindow) : "unknown";
	return `${WORKER_CAPABILITY_INSUFFICIENT_SKIP_REASON}:reason=${refusal.reason};class=${refusal.capabilityClass};contextWindow=${windowText}`;
}

/**
 * The actionable remedy for a skip reason produced by {@link laneWorkerRefusalSkipReason}, or undefined when
 * the skip reason is not a worker-capability refusal. Lets every surface that renders a skip reason (delegate,
 * goal dispatch) name what to change without re-deriving the refusal.
 */
export function laneWorkerRefusalSkipRemedy(skipReason: string): string | undefined {
	if (!skipReason.startsWith(WORKER_CAPABILITY_INSUFFICIENT_SKIP_REASON)) return undefined;
	const field = (name: string): string | undefined => new RegExp(`[:;]${name}=([^;]*)`).exec(skipReason)?.[1];
	const reason = field("reason") as LaneWorkerRefusalReason | undefined;
	const capabilityClass = field("class") as ModelCapabilityClass | undefined;
	if (!reason || !capabilityClass) return undefined;
	const windowText = field("contextWindow");
	const contextWindow = windowText !== undefined && windowText !== "unknown" ? Number(windowText) : undefined;
	return laneWorkerRefusalRemedy({ reason, capabilityClass, contextWindow });
}

/**
 * What the owner (or the delegating agent) changes so a refused model can carry a worker. The refusal is
 * owner doctrine, so its failure mode must be actionable: a reason code alone leaves a long durable run
 * with a blocked worker and no way forward.
 */
export function laneWorkerRefusalRemedy(refusal: LaneWorkerRefusal): string {
	switch (refusal.reason) {
		case "capability_class_below_full":
			return `Workers need a full-class model (declared context window of at least ${MODEL_CAPABILITY_FULL_MIN_CONTEXT}). Start the worker on a larger-window model (delegate \`model\`, workerDelegation.modelPins, or the launched agent's --model), or, if the window is under-declared, raise \`contextWindow\` for that model in models.json.`;
		case "model_unresolved":
			return "No model could be resolved for the worker. Name a model explicitly (delegate `model`, the launched agent's --model) or set a default model.";
		case "context_window_unknown":
			return "The model has no declared context window (the registry default is not a declaration). Declare `contextWindow` for it in models.json (or modelOverrides) to make it eligible as a worker.";
		case "tool_calling_unadvertised":
			return "The model declares text-only tool calling (`textToolCallProtocol: true`), so it cannot drive worker tools natively. Use a model with native tool calling, or run /toolprobe if it does support native calls.";
		case "tool_calling_unknown":
			return "The model declares neither native nor text tool calling. Declare `textToolCallProtocol: false` for it in models.json if it supports native tool calls, or run /toolprobe to prove it.";
		case "tool_calling_demoted":
			return "The model's native tool-call path was demoted (probe verdict or toolRepair.textProtocol). Run /toolprobe to re-prove native calls, clear the verdict with /toolprotocol-reset <provider/model>, or use another model.";
	}
}

/** Stable, greppable prefix for {@link formatLaneWorkerRefusal}'s output. */
export const LANE_WORKER_REFUSAL_PREFIX = "lane-worker refusal:";

/** Format a refusal into one deterministic, greppable line naming the lane, class, window, and reason. */
export function formatLaneWorkerRefusal(refusal: LaneWorkerRefusal, laneKey?: string): string {
	const laneSuffix = laneKey !== undefined ? ` lane=${laneKey}` : "";
	const windowText = refusal.contextWindow !== undefined ? String(refusal.contextWindow) : "unknown";
	return `${LANE_WORKER_REFUSAL_PREFIX}${laneSuffix} class=${refusal.capabilityClass} contextWindow=${windowText} reason=${refusal.reason}. ${laneWorkerRefusalRemedy(refusal)}`;
}
