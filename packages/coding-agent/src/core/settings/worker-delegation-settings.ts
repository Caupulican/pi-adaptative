/**
 * Worker delegation settings: the delegation budget and switches, the worker thinking policy and the account routing,
 * resolved from the merged `workerDelegation` layer. Pure; the manager delegates to them.
 */

import {
	DEFAULT_WORKER_DELEGATION_ACCOUNT,
	DEFAULT_WORKER_DELEGATION_ENABLED,
	DEFAULT_WORKER_DELEGATION_HALT_REPORT_DEADLINE_MS,
	DEFAULT_WORKER_DELEGATION_MAX_USD,
	DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
	DEFAULT_WORKER_DELEGATION_REPORT_HANDSHAKE,
	DEFAULT_WORKER_DELEGATION_THINKING,
	DEFAULT_WORKER_DELEGATION_WRITE_ENABLED,
	MAX_WORKER_DELEGATION_HALT_REPORT_DEADLINE_MS,
	MAX_WORKER_DELEGATION_MAX_USD,
	MAX_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
	normalizeWorkerDelegationLayer,
	sanitizeIntegerSetting,
	sanitizeNumberSetting,
} from "./settings-rules.ts";
import type {
	ResolvedWorkerDelegationSettings,
	Settings,
	WorkerAccountRouting,
	WorkerThinkingPolicy,
} from "./settings-schema.ts";

/**
 * The worker delegation budget, switches and handshake, each clamped or defaulted, with the optional orchestration
 * profile.
 */
export function resolveWorkerDelegationSettings(
	settings: Pick<Settings, "workerDelegation">,
): ResolvedWorkerDelegationSettings {
	const configured = normalizeWorkerDelegationLayer(settings.workerDelegation) ?? {};

	const resolved: ResolvedWorkerDelegationSettings = {
		enabled: typeof configured.enabled === "boolean" ? configured.enabled : DEFAULT_WORKER_DELEGATION_ENABLED,
		maxUsd: sanitizeNumberSetting(
			configured.maxUsd,
			DEFAULT_WORKER_DELEGATION_MAX_USD,
			0,
			MAX_WORKER_DELEGATION_MAX_USD,
		),
		maxWallClockMs: sanitizeIntegerSetting(
			configured.maxWallClockMs,
			DEFAULT_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
			0,
			MAX_WORKER_DELEGATION_MAX_WALL_CLOCK_MS,
		),
		writeEnabled:
			typeof configured.writeEnabled === "boolean"
				? configured.writeEnabled
				: DEFAULT_WORKER_DELEGATION_WRITE_ENABLED,
		reportHandshake:
			typeof configured.reportHandshake === "boolean"
				? configured.reportHandshake
				: DEFAULT_WORKER_DELEGATION_REPORT_HANDSHAKE,
		haltReportDeadlineMs: sanitizeIntegerSetting(
			configured.haltReportDeadlineMs,
			DEFAULT_WORKER_DELEGATION_HALT_REPORT_DEADLINE_MS,
			1,
			MAX_WORKER_DELEGATION_HALT_REPORT_DEADLINE_MS,
		),
	};
	if (typeof configured.orchestrationProfile === "string" && configured.orchestrationProfile.trim().length > 0) {
		resolved.orchestrationProfile = configured.orchestrationProfile.trim();
	}
	return resolved;
}

/** Worker thinking relative to the foreground when neither authority nor profile pins it. */
export function resolveWorkerThinkingPolicy(settings: Pick<Settings, "workerDelegation">): WorkerThinkingPolicy {
	const configured = normalizeWorkerDelegationLayer(settings.workerDelegation) ?? {};
	return configured.thinking ?? DEFAULT_WORKER_DELEGATION_THINKING;
}

/** The account fresh workers run on and the ordered routing candidates. */
export function resolveWorkerAccountRouting(settings: Pick<Settings, "workerDelegation">): WorkerAccountRouting {
	const configured = normalizeWorkerDelegationLayer(settings.workerDelegation) ?? {};
	return {
		account: configured.account ?? DEFAULT_WORKER_DELEGATION_ACCOUNT,
		routeProviders: configured.routeProviders ?? [],
		...(configured.routeProvidersByRole ? { routeProvidersByRole: configured.routeProvidersByRole } : {}),
	};
}
