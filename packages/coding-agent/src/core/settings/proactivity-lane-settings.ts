/**
 * Background-lane settings: proactivity, routines (including routines away) and the research lane. Each resolver is
 * pure over the settings slice it is given; the manager delegates to them and keeps the layer reads it needs.
 */

import {
	DEFAULT_PROACTIVITY_DELIVERY,
	DEFAULT_PROACTIVITY_ENABLED,
	DEFAULT_PROACTIVITY_IDLE_DELAY_MS,
	DEFAULT_PROACTIVITY_MAX_NOTES,
	DEFAULT_PROACTIVITY_MAX_RUNS_PER_SESSION,
	DEFAULT_PROACTIVITY_MAX_TURN_WAKES_PER_DAY,
	DEFAULT_PROACTIVITY_MAX_USD,
	DEFAULT_PROACTIVITY_MAX_USD_PER_DAY,
	DEFAULT_PROACTIVITY_MIN_OWNER_TURNS,
	DEFAULT_RESEARCH_LANE_ENABLED,
	DEFAULT_RESEARCH_LANE_IDLE_DELAY_MS,
	DEFAULT_RESEARCH_LANE_MAX_FINDINGS,
	DEFAULT_RESEARCH_LANE_MAX_RUNS_PER_SESSION,
	DEFAULT_RESEARCH_LANE_MAX_SOURCES,
	DEFAULT_RESEARCH_LANE_MAX_USD,
	DEFAULT_RESEARCH_LANE_MAX_WALL_CLOCK_MS,
	DEFAULT_ROUTINE_AWAY_ENABLED,
	DEFAULT_ROUTINE_AWAY_MAX_PARENT_HOSTS,
	DEFAULT_ROUTINE_AWAY_MAX_USD_PER_DAY,
	DEFAULT_ROUTINE_AWAY_MAX_USD_PER_RUN,
	DEFAULT_ROUTINE_MAX_RESULT_WAKES_PER_DAY,
	MAX_PROACTIVITY_IDLE_DELAY_MS,
	MAX_PROACTIVITY_MAX_NOTES,
	MAX_PROACTIVITY_MAX_RUNS_PER_SESSION,
	MAX_PROACTIVITY_MAX_TURN_WAKES_PER_DAY,
	MAX_PROACTIVITY_MAX_USD,
	MAX_PROACTIVITY_MAX_USD_PER_DAY,
	MAX_PROACTIVITY_MIN_OWNER_TURNS,
	MAX_PROACTIVITY_PREFERENCES_CHARS,
	MAX_RESEARCH_LANE_IDLE_DELAY_MS,
	MAX_RESEARCH_LANE_MAX_FINDINGS,
	MAX_RESEARCH_LANE_MAX_RUNS_PER_SESSION,
	MAX_RESEARCH_LANE_MAX_SOURCES,
	MAX_RESEARCH_LANE_MAX_USD,
	MAX_RESEARCH_LANE_MAX_WALL_CLOCK_MS,
	MAX_ROUTINE_AWAY_MAX_PARENT_HOSTS,
	MAX_ROUTINE_AWAY_MAX_USD_PER_DAY,
	MAX_ROUTINE_AWAY_MAX_USD_PER_RUN,
	MAX_ROUTINE_MAX_RESULT_WAKES_PER_DAY,
	MIN_ROUTINE_AWAY_MAX_USD_PER_RUN,
	sanitizeIntegerSetting,
	sanitizeNumberSetting,
} from "./settings-rules.ts";
import type {
	ResolvedProactivitySettings,
	ResolvedResearchLaneSettings,
	ResolvedRoutineAwaySettings,
	RoutinesSettings,
	Settings,
} from "./settings-schema.ts";

/** Proactivity bounds: idle delay, owner turns between runs, run and spend caps, delivery and preferences. */
export function resolveProactivitySettings(settings: Pick<Settings, "proactivity">): ResolvedProactivitySettings {
	const configured = settings.proactivity ?? {};
	const resolved: ResolvedProactivitySettings = {
		enabled: typeof configured.enabled === "boolean" ? configured.enabled : DEFAULT_PROACTIVITY_ENABLED,
		idleDelayMs: sanitizeIntegerSetting(
			configured.idleDelayMs,
			DEFAULT_PROACTIVITY_IDLE_DELAY_MS,
			0,
			MAX_PROACTIVITY_IDLE_DELAY_MS,
		),
		minOwnerTurnsBetweenRuns: sanitizeIntegerSetting(
			configured.minOwnerTurnsBetweenRuns,
			DEFAULT_PROACTIVITY_MIN_OWNER_TURNS,
			1,
			MAX_PROACTIVITY_MIN_OWNER_TURNS,
		),
		maxRunsPerSession: sanitizeIntegerSetting(
			configured.maxRunsPerSession,
			DEFAULT_PROACTIVITY_MAX_RUNS_PER_SESSION,
			0,
			MAX_PROACTIVITY_MAX_RUNS_PER_SESSION,
		),
		maxUsd: sanitizeNumberSetting(configured.maxUsd, DEFAULT_PROACTIVITY_MAX_USD, 0, MAX_PROACTIVITY_MAX_USD),
		maxUsdPerDay: sanitizeNumberSetting(
			configured.maxUsdPerDay,
			DEFAULT_PROACTIVITY_MAX_USD_PER_DAY,
			0,
			MAX_PROACTIVITY_MAX_USD_PER_DAY,
		),
		maxTurnWakesPerDay: sanitizeIntegerSetting(
			configured.maxTurnWakesPerDay,
			DEFAULT_PROACTIVITY_MAX_TURN_WAKES_PER_DAY,
			0,
			MAX_PROACTIVITY_MAX_TURN_WAKES_PER_DAY,
		),
		maxNotesPerRun: sanitizeIntegerSetting(
			configured.maxNotesPerRun,
			DEFAULT_PROACTIVITY_MAX_NOTES,
			1,
			MAX_PROACTIVITY_MAX_NOTES,
		),
		delivery:
			configured.delivery === "note" || configured.delivery === "turn"
				? configured.delivery
				: DEFAULT_PROACTIVITY_DELIVERY,
		preferences:
			typeof configured.preferences === "string"
				? configured.preferences.trim().slice(0, MAX_PROACTIVITY_PREFERENCES_CHARS)
				: "",
		ciEvents: typeof configured.ciEvents === "boolean" ? configured.ciEvents : true,
	};
	if (typeof configured.model === "string" && configured.model.trim().length > 0) {
		resolved.model = configured.model;
	}
	return resolved;
}

/** Routine intake and the daily result-wake cap. */
export function resolveRoutinesSettings(
	settings: Pick<Settings, "routines">,
): Required<Pick<RoutinesSettings, "automaticIntake" | "maxResultWakesPerDay">> {
	const configured = settings.routines ?? {};
	return {
		automaticIntake: typeof configured.automaticIntake === "boolean" ? configured.automaticIntake : true,
		maxResultWakesPerDay: sanitizeIntegerSetting(
			configured.maxResultWakesPerDay,
			DEFAULT_ROUTINE_MAX_RESULT_WAKES_PER_DAY,
			0,
			MAX_ROUTINE_MAX_RESULT_WAKES_PER_DAY,
		),
	};
}

/** Bounds of routines run away: the switch, per-run and per-day spend, and the parent host count. */
export function resolveRoutineAwaySettings(settings: Pick<Settings, "routines">): ResolvedRoutineAwaySettings {
	const configured = settings.routines?.away ?? {};
	return {
		enabled: typeof configured.enabled === "boolean" ? configured.enabled : DEFAULT_ROUTINE_AWAY_ENABLED,
		maxUsdPerRun: sanitizeNumberSetting(
			configured.maxUsdPerRun,
			DEFAULT_ROUTINE_AWAY_MAX_USD_PER_RUN,
			MIN_ROUTINE_AWAY_MAX_USD_PER_RUN,
			MAX_ROUTINE_AWAY_MAX_USD_PER_RUN,
		),
		maxUsdPerDay: sanitizeNumberSetting(
			configured.maxUsdPerDay,
			DEFAULT_ROUTINE_AWAY_MAX_USD_PER_DAY,
			0,
			MAX_ROUTINE_AWAY_MAX_USD_PER_DAY,
		),
		maxParentHosts: sanitizeIntegerSetting(
			configured.maxParentHosts,
			DEFAULT_ROUTINE_AWAY_MAX_PARENT_HOSTS,
			1,
			MAX_ROUTINE_AWAY_MAX_PARENT_HOSTS,
		),
	};
}

/**
 * The research lane bounds: spend, sources, findings, wall clock, idle delay and runs, with the optional model, profile
 * and prompt.
 */
export function resolveResearchLaneSettings(settings: Pick<Settings, "researchLane">): ResolvedResearchLaneSettings {
	const configured = settings.researchLane ?? {};

	const resolved: ResolvedResearchLaneSettings = {
		enabled: typeof configured.enabled === "boolean" ? configured.enabled : DEFAULT_RESEARCH_LANE_ENABLED,
		maxUsd: sanitizeNumberSetting(configured.maxUsd, DEFAULT_RESEARCH_LANE_MAX_USD, 0, MAX_RESEARCH_LANE_MAX_USD),
		maxSources: sanitizeIntegerSetting(
			configured.maxSources,
			DEFAULT_RESEARCH_LANE_MAX_SOURCES,
			1,
			MAX_RESEARCH_LANE_MAX_SOURCES,
		),
		maxFindings: sanitizeIntegerSetting(
			configured.maxFindings,
			DEFAULT_RESEARCH_LANE_MAX_FINDINGS,
			1,
			MAX_RESEARCH_LANE_MAX_FINDINGS,
		),
		maxWallClockMs: sanitizeIntegerSetting(
			configured.maxWallClockMs,
			DEFAULT_RESEARCH_LANE_MAX_WALL_CLOCK_MS,
			0,
			MAX_RESEARCH_LANE_MAX_WALL_CLOCK_MS,
		),
		idleDelayMs: sanitizeIntegerSetting(
			configured.idleDelayMs,
			DEFAULT_RESEARCH_LANE_IDLE_DELAY_MS,
			0,
			MAX_RESEARCH_LANE_IDLE_DELAY_MS,
		),
		maxRunsPerSession: sanitizeIntegerSetting(
			configured.maxRunsPerSession,
			DEFAULT_RESEARCH_LANE_MAX_RUNS_PER_SESSION,
			0,
			MAX_RESEARCH_LANE_MAX_RUNS_PER_SESSION,
		),
	};
	if (typeof configured.model === "string" && configured.model.trim().length > 0) {
		resolved.model = configured.model;
	}
	if (typeof configured.profile === "string" && configured.profile.trim().length > 0) {
		resolved.profile = configured.profile;
	}
	if (typeof configured.systemPrompt === "string" && configured.systemPrompt.trim().length > 0) {
		resolved.systemPrompt = configured.systemPrompt;
	}
	return resolved;
}
