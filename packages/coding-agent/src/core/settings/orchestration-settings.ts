/**
 * The orchestration settings the coordinators read through the settings manager: the retention of closed orchestration
 * work (`orchestration.retention`) and the leader nesting depth (`leaders`). The resolvers are pure; the manager
 * delegates to them, so its own size does not grow.
 */

import { LEADER_MAX_DEPTH_CEILING, LEADER_MAX_DEPTH_DEFAULT } from "../delegation/leader-delegation.ts";
import { clampOrchestrationRetentionDays, sanitizeIntegerSetting } from "./settings-rules.ts";
import type { LeaderSettings } from "./settings-schema.ts";

export interface OrchestrationRetentionSettings {
	/** Days a closed objective, or a finished session task, stays before idle release; 0 keeps it for the session's life. */
	closedObjectiveDays?: number;
}

export interface OrchestrationSettings {
	retention?: OrchestrationRetentionSettings;
}

/** The retention the orchestration store applies: the day count a closed unit stays, clamped to its range. */
export function resolveOrchestrationRetention(settings: OrchestrationSettings | undefined): {
	closedObjectiveDays: number;
} {
	return { closedObjectiveDays: clampOrchestrationRetentionDays(settings?.retention?.closedObjectiveDays) };
}

/** Leaders as sub-orchestrators: the nesting depth, the default when unset or out of range. */
export function resolveLeaderSettings(settings: LeaderSettings | undefined): Required<LeaderSettings> {
	return {
		maxDepth: sanitizeIntegerSetting(settings?.maxDepth, LEADER_MAX_DEPTH_DEFAULT, 1, LEADER_MAX_DEPTH_CEILING),
	};
}
