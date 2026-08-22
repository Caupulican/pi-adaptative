import type { AutoLearnSettings, AutonomyMode } from "../settings-manager.ts";

/** The authoritative Auto Learn defaults used by runtime resolution and settings UI. */
export const DEFAULT_AUTO_LEARN_SETTINGS = {
	enabled: true,
	model: "active",
	thinkingLevel: "low",
	longSessionMessages: 32,
	longSessionContextPercent: 70,
	cooldownMinutes: 24 * 60,
	leaseMinutes: 90,
	maxConcurrentLearners: 1,
	applyHighConfidence: false,
	reflectionReview: true,
	reflectionMinToolCalls: 12,
	reflectionCooldownMinutes: 24 * 60,
	complexTaskToolCalls: 12,
} as const satisfies Required<AutoLearnSettings>;

export const AUTONOMY_AUTO_LEARN_PRESETS = {
	off: DEFAULT_AUTO_LEARN_SETTINGS,
	safe: {
		...DEFAULT_AUTO_LEARN_SETTINGS,
		longSessionMessages: 64,
		longSessionContextPercent: 85,
		leaseMinutes: 60,
	},
	balanced: {
		...DEFAULT_AUTO_LEARN_SETTINGS,
		longSessionMessages: 64,
		longSessionContextPercent: 85,
	},
	full: {
		...DEFAULT_AUTO_LEARN_SETTINGS,
		longSessionMessages: 64,
		longSessionContextPercent: 85,
		applyHighConfidence: true,
	},
} as const satisfies Record<AutonomyMode, Required<AutoLearnSettings>>;

export function getAutoLearnPreset(mode: AutonomyMode, current: AutoLearnSettings = {}): Required<AutoLearnSettings> {
	const preset = AUTONOMY_AUTO_LEARN_PRESETS[mode] ?? AUTONOMY_AUTO_LEARN_PRESETS.off;
	return { ...preset, model: current.model?.trim() || preset.model };
}

export function resolveAutoLearnSettings(
	mode: AutonomyMode,
	settings: AutoLearnSettings = {},
): Required<AutoLearnSettings> {
	const preset = getAutoLearnPreset(mode, settings);
	return {
		enabled: settings.enabled ?? preset.enabled,
		model: settings.model?.trim() || preset.model,
		thinkingLevel: settings.thinkingLevel ?? preset.thinkingLevel,
		longSessionMessages: settings.longSessionMessages ?? preset.longSessionMessages,
		longSessionContextPercent: settings.longSessionContextPercent ?? preset.longSessionContextPercent,
		cooldownMinutes: settings.cooldownMinutes ?? preset.cooldownMinutes,
		leaseMinutes: settings.leaseMinutes ?? preset.leaseMinutes,
		maxConcurrentLearners: settings.maxConcurrentLearners ?? preset.maxConcurrentLearners,
		applyHighConfidence: settings.applyHighConfidence ?? preset.applyHighConfidence,
		reflectionReview: settings.reflectionReview ?? preset.reflectionReview,
		reflectionMinToolCalls: settings.reflectionMinToolCalls ?? preset.reflectionMinToolCalls,
		reflectionCooldownMinutes: settings.reflectionCooldownMinutes ?? preset.reflectionCooldownMinutes,
		complexTaskToolCalls: settings.complexTaskToolCalls ?? preset.complexTaskToolCalls,
	};
}

/** One settings/environment gate shared by root prompt construction and current-turn cue delivery. */
export function isCurrentSessionReflectionEnabled(
	settings: Pick<Required<AutoLearnSettings>, "enabled" | "reflectionReview">,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return (
		settings.enabled &&
		settings.reflectionReview &&
		env.PI_NATIVE_REFLECTION !== "0" &&
		env.PI_AUTO_LEARN_CHILD !== "1"
	);
}
