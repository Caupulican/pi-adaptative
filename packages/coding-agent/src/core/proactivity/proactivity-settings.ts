import type { ProactivitySettings, ResolvedProactivitySettings } from "../settings/settings-schema.ts";

/** The owner's proactivity settings with some fields changed; every other field stays as it resolves now. */
export function withProactivityChange(
	settings: ResolvedProactivitySettings,
	change: Partial<ProactivitySettings>,
): ProactivitySettings {
	return {
		enabled: settings.enabled,
		idleDelayMs: settings.idleDelayMs,
		minOwnerTurnsBetweenRuns: settings.minOwnerTurnsBetweenRuns,
		maxRunsPerSession: settings.maxRunsPerSession,
		maxUsd: settings.maxUsd,
		maxUsdPerDay: settings.maxUsdPerDay,
		maxTurnWakesPerDay: settings.maxTurnWakesPerDay,
		maxNotesPerRun: settings.maxNotesPerRun,
		delivery: settings.delivery,
		preferences: settings.preferences,
		ciEvents: settings.ciEvents,
		...(settings.model === undefined ? {} : { model: settings.model }),
		...change,
	};
}
