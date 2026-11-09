/**
 * Autonomy settings: the autonomy mode and goal-continuation bounds, the edge grants (standing allow and deny lists)
 * and the learning policy. Each resolver is pure; the manager passes the layer data it reads and keeps the load-error
 * gating.
 */

import { EDGE_CLASSES, isEdgeClass } from "../autonomy/edge-policy.ts";
import {
	MAX_GOAL_AUTO_CONTINUE_DELAY_MS,
	MAX_GOAL_CONTINUE_MAX_STALL_TURNS,
	MAX_GOAL_CONTINUE_MAX_TURNS,
	MAX_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
} from "../goals/goal-continuation-defaults.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE,
	DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS,
	DEFAULT_AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
	DEFAULT_AUTONOMY_GOAL_CONTINUE_TURNS,
	DEFAULT_AUTONOMY_MAX_STALL_TURNS,
	DEFAULT_LEARNING_POLICY_ALLOWED_AUTO_APPLY_LAYERS,
	DEFAULT_LEARNING_POLICY_AUTO_APPLY_ENABLED,
	DEFAULT_LEARNING_POLICY_AUTO_APPLY_SUPERSESSIONS,
	DEFAULT_LEARNING_POLICY_CONFIDENCE_THRESHOLD,
	DEFAULT_LEARNING_POLICY_ENABLED,
	DEFAULT_LEARNING_POLICY_MIN_OBSERVATIONS,
	DEFAULT_LEARNING_POLICY_REFLECTION_SOURCE_CONFIDENCE,
	sanitizeIntegerSetting,
} from "./settings-rules.ts";
import type {
	AutonomySettings,
	LearningPolicyLayer,
	ResolvedEdgeSettings,
	ResolvedLearningPolicySettings,
	Settings,
} from "./settings-schema.ts";

/** Autonomy mode and goal-continuation bounds, each clamped to its range with the default when unset. */
export function resolveAutonomySettings(settings: Pick<Settings, "autonomy">): Required<AutonomySettings> {
	const mode = settings.autonomy?.mode;
	const configuredMaxStallTurns = settings.autonomy?.maxStallTurns;
	const configuredGoalContinueTurns = settings.autonomy?.goalContinueTurns;
	const configuredGoalContinueMaxWallClockMinutes = settings.autonomy?.goalContinueMaxWallClockMinutes;
	const configuredGoalAutoContinue = settings.autonomy?.goalAutoContinue;
	const configuredGoalAutoContinueDelayMs = settings.autonomy?.goalAutoContinueDelayMs;

	const maxStallTurns = sanitizeIntegerSetting(
		configuredMaxStallTurns,
		DEFAULT_AUTONOMY_MAX_STALL_TURNS,
		0,
		MAX_GOAL_CONTINUE_MAX_STALL_TURNS,
	);
	const goalContinueTurns = sanitizeIntegerSetting(
		configuredGoalContinueTurns,
		DEFAULT_AUTONOMY_GOAL_CONTINUE_TURNS,
		0,
		MAX_GOAL_CONTINUE_MAX_TURNS,
	);
	const goalContinueMaxWallClockMinutes = sanitizeIntegerSetting(
		configuredGoalContinueMaxWallClockMinutes,
		DEFAULT_AUTONOMY_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
		0,
		MAX_GOAL_CONTINUE_MAX_WALL_CLOCK_MINUTES,
	);
	const goalAutoContinueDelayMs = sanitizeIntegerSetting(
		configuredGoalAutoContinueDelayMs,
		DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE_DELAY_MS,
		0,
		MAX_GOAL_AUTO_CONTINUE_DELAY_MS,
	);

	return {
		mode: mode === "safe" || mode === "balanced" || mode === "full" ? mode : "off",
		maxStallTurns,
		goalContinueTurns,
		goalContinueMaxWallClockMinutes,
		goalAutoContinue:
			typeof configuredGoalAutoContinue === "boolean"
				? configuredGoalAutoContinue
				: DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE,
		goalAutoContinueDelayMs,
	};
}

/** The learning policy: switches, thresholds, the auto-apply layers and the rollback requirement. */
export function resolveLearningPolicySettings(
	settings: Pick<Settings, "learningPolicy">,
): ResolvedLearningPolicySettings {
	const configured = settings.learningPolicy ?? {};

	const allowedLayers = Array.isArray(configured.allowedAutoApplyLayers)
		? configured.allowedAutoApplyLayers.filter(
				(layer): layer is LearningPolicyLayer =>
					typeof layer === "string" &&
					["memory", "skill", "prompt", "extension", "tool", "script", "settings", "source"].includes(layer),
			)
		: [...DEFAULT_LEARNING_POLICY_ALLOWED_AUTO_APPLY_LAYERS];

	return {
		enabled: typeof configured.enabled === "boolean" ? configured.enabled : DEFAULT_LEARNING_POLICY_ENABLED,
		autoApplyEnabled:
			typeof configured.autoApplyEnabled === "boolean"
				? configured.autoApplyEnabled
				: DEFAULT_LEARNING_POLICY_AUTO_APPLY_ENABLED,
		confidenceThreshold: sanitizeIntegerSetting(
			configured.confidenceThreshold,
			DEFAULT_LEARNING_POLICY_CONFIDENCE_THRESHOLD,
			0,
			100,
		),
		minObservations: sanitizeIntegerSetting(
			configured.minObservations,
			DEFAULT_LEARNING_POLICY_MIN_OBSERVATIONS,
			0,
			100,
		),
		allowedAutoApplyLayers: allowedLayers,
		requireRollbackPlan: typeof configured.requireRollbackPlan === "boolean" ? configured.requireRollbackPlan : true,
		reflectionSourceConfidence: sanitizeIntegerSetting(
			configured.reflectionSourceConfidence,
			DEFAULT_LEARNING_POLICY_REFLECTION_SOURCE_CONFIDENCE,
			0,
			100,
		),
		autoApplySupersessions:
			typeof configured.autoApplySupersessions === "boolean"
				? configured.autoApplySupersessions
				: DEFAULT_LEARNING_POLICY_AUTO_APPLY_SUPERSESSIONS,
	};
}

/**
 * The edge grants: the mode, the standing allow list and the third-party allow list, withheld on a settings load error
 * or an unreadable deny list.
 */
export function resolveEdgeSettings(
	settings: Pick<Settings, "edge">,
	loadError: Error | null,
	edgeLayers: ReadonlyArray<Settings["edge"]>,
): ResolvedEdgeSettings {
	// Load diagnostics already report the file error. Withhold standing grants, but keep
	// provider planning and ordinary tools available so the session can diagnose and repair it.
	if (loadError || (settings.edge !== undefined && !isPlainRecord(settings.edge)))
		return { mode: "guarded", allow: [], thirdPartyAllow: [], deny: [] };
	const configured = settings.edge?.allow;
	// Resolve once here: foreground, worker inheritance and provider authority context all
	// consume these grants. Autonomy/learning presets never narrow execution authority.
	const allow =
		configured === undefined ? EDGE_CLASSES : Array.isArray(configured) ? configured.filter(isEdgeClass) : [];
	// What a run carrying a third party's words may do is its own key, never `allow` (which grants the owner's own
	// runs). A repository's own settings file never writes it: a project without a trust decision loads it trusted by
	// default (`getProjectTrustDefault`), so only the global and directory-profile layers under the agent directory
	// count, the directory profile first. It never exceeds what the owner's own runs may do (`allow`).
	const thirdPartyWritten = edgeLayers
		.map((layer) => (isPlainRecord(layer) ? layer.thirdPartyAllow : undefined))
		.find((list) => list !== undefined);
	const thirdPartyAllow = Array.isArray(thirdPartyWritten)
		? [...new Set(allow)].filter((edgeClass) => thirdPartyWritten.includes(edgeClass))
		: [];
	const configuredDeny = settings.edge?.deny;
	// A deny list that cannot be read cannot be enforced, so YOLO waits until it is corrected. The
	// standing grants do not depend on it and stay as configured.
	if (
		configuredDeny !== undefined &&
		(!Array.isArray(configuredDeny) || configuredDeny.some((value) => typeof value !== "string" || !value.trim()))
	) {
		return { mode: "guarded", allow: [...new Set(allow)], thirdPartyAllow, deny: [] };
	}
	return {
		mode: settings.edge?.mode === "yolo" ? "yolo" : "guarded",
		allow: [...new Set(allow)],
		thirdPartyAllow,
		deny: [...new Set((configuredDeny ?? []).map((value) => value.trim()))],
	};
}
