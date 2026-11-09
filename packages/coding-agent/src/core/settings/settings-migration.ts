/**
 * Settings file migration: rewrites older settings shapes to the current schema when a layer is read (renamed keys, the
 * legacy skills object, and the retry delay moved under the provider block). Pure; the manager applies it to every
 * layer.
 */

import type { Settings } from "./settings-schema.ts";

/** Migrate old settings format to new format */
export function migrateSettings(settings: Record<string, unknown>): Settings {
	// Migrate queueMode -> steeringMode
	if ("queueMode" in settings && !("steeringMode" in settings)) {
		settings.steeringMode = settings.queueMode;
		delete settings.queueMode;
	}

	// Migrate legacy websockets boolean -> transport enum
	if (!("transport" in settings) && typeof settings.websockets === "boolean") {
		settings.transport = settings.websockets ? "websocket" : "sse";
		delete settings.websockets;
	}

	// Migrate old skills object format to new array format
	if (
		"skills" in settings &&
		typeof settings.skills === "object" &&
		settings.skills !== null &&
		!Array.isArray(settings.skills)
	) {
		const skillsSettings = settings.skills as {
			enableSkillCommands?: boolean;
			customDirectories?: unknown;
		};
		if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
			settings.enableSkillCommands = skillsSettings.enableSkillCommands;
		}
		if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
			settings.skills = skillsSettings.customDirectories;
		} else {
			delete settings.skills;
		}
	}

	// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
	if (
		"retry" in settings &&
		typeof settings.retry === "object" &&
		settings.retry !== null &&
		!Array.isArray(settings.retry)
	) {
		const retrySettings = settings.retry as Record<string, unknown>;
		const providerSettings =
			typeof retrySettings.provider === "object" && retrySettings.provider !== null
				? (retrySettings.provider as Record<string, unknown>)
				: undefined;
		if (
			typeof retrySettings.maxDelayMs === "number" &&
			(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
		) {
			retrySettings.provider = {
				...(providerSettings ?? {}),
				maxRetryDelayMs: retrySettings.maxDelayMs,
			};
		}
		delete retrySettings.maxDelayMs;
	}

	return settings as Settings;
}
