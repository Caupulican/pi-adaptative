import { sanitizeIntegerSetting, sanitizeNumberSetting } from "../settings/settings-rules.ts";
import type {
	ActAheadSettings,
	ProactivitySettings,
	ResolvedActAheadSettings,
	ResolvedProactivitySettings,
} from "../settings/settings-schema.ts";

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

/** The longest validation command kept; a longer one is ignored and the static check is used. */
const MAX_ACT_AHEAD_COMMAND_CHARS = 500;

type ActAheadNumberKey = "maxAttemptsPerDay" | "maxUsdPerDay" | "maxUsdPerAttempt" | "maxMinutesPerAttempt";

/**
 * Acting-ahead settings from the owner's layers, first layer first (directory profile, then global): each field comes
 * from the first layer that sets it validly. `validate: "command"` without a usable command uses the static check.
 */
export function resolveActAheadSettings(layers: readonly (ActAheadSettings | undefined)[]): ResolvedActAheadSettings {
	const pick = <T>(read: (layer: ActAheadSettings) => T | undefined): T | undefined => {
		for (const layer of layers) {
			if (layer === null || typeof layer !== "object") continue;
			const value = read(layer);
			if (value !== undefined) return value;
		}
		return undefined;
	};
	const number = (key: ActAheadNumberKey) =>
		pick((layer) => {
			const value = layer[key];
			return typeof value === "number" && Number.isFinite(value) ? value : undefined;
		});
	const command = pick((layer) =>
		typeof layer.command === "string" &&
		layer.command.trim().length > 0 &&
		layer.command.length <= MAX_ACT_AHEAD_COMMAND_CHARS
			? layer.command.trim()
			: undefined,
	);
	const validate = pick((layer) =>
		layer.validate === "static" || layer.validate === "command" ? layer.validate : undefined,
	);
	return {
		enabled: pick((layer) => (typeof layer.enabled === "boolean" ? layer.enabled : undefined)) ?? true,
		validate: validate === "command" && command !== undefined ? "command" : "static",
		maxAttemptsPerDay: sanitizeIntegerSetting(number("maxAttemptsPerDay"), 3, 0, 20),
		maxUsdPerDay: sanitizeNumberSetting(number("maxUsdPerDay"), 0.5, 0, 20),
		maxUsdPerAttempt: sanitizeNumberSetting(number("maxUsdPerAttempt"), 0.25, 0, 5),
		maxMinutesPerAttempt: sanitizeIntegerSetting(number("maxMinutesPerAttempt"), 20, 1, 120),
		...(command === undefined ? {} : { command }),
	};
}
