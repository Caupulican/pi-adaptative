/**
 * Worker delegation settings: the delegation budget and switches, the worker thinking policy and the account routing,
 * resolved from the merged `workerDelegation` layer. Pure; the manager delegates to them.
 */

import type { OrchestrationModelBinding } from "../orchestration/contracts.ts";
import { compileWorkerModelPinPolicy, type WorkerModelPinsSettings } from "../orchestration/worker-model-pins.ts";
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
	SettingsScope,
	WorkerAccountRouting,
	WorkerDelegationSettings,
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

/**
 * Scope-local partial update to `workerDelegation`: only own keys present on the patch are written or cleared
 * (`undefined` deletes that key in the target scope), leaving untouched keys and sibling pins intact.
 */
export type WorkerDelegationSettingsPatch = Partial<Omit<WorkerDelegationSettings, "modelPins">> & {
	modelPins?: WorkerModelPinsSettings | undefined;
	/** Set or clear only `modelPins.default` while preserving `modelPins.leader` and `modelPins.roles`. */
	defaultModelPin?: OrchestrationModelBinding | undefined;
};

const PATCHABLE_WORKER_DELEGATION_KEYS = [
	"enabled",
	"orchestrationProfile",
	"maxUsd",
	"maxWallClockMs",
	"writeEnabled",
	"reportHandshake",
	"haltReportDeadlineMs",
	"thinking",
	"account",
	"routeProviders",
	"routeProvidersByRole",
	"outcomes",
] as const;

function hasAnyModelPin(pins: WorkerModelPinsSettings | undefined): boolean {
	if (!pins) return false;
	return (
		pins.default !== undefined ||
		pins.leader !== undefined ||
		(pins.roles !== undefined && Object.keys(pins.roles).length > 0)
	);
}

/**
 * Apply a scope-local patch onto `existing` (that scope's raw `workerDelegation` layer only, never the merged
 * effective settings). Returns `undefined` when clearing fields leaves the scope layer empty.
 */
export function applyWorkerDelegationPatch(
	existing: WorkerDelegationSettings | undefined,
	patch: WorkerDelegationSettingsPatch,
	scope: SettingsScope,
): WorkerDelegationSettings | undefined {
	const next: WorkerDelegationSettings = existing ? structuredClone(existing) : {};

	for (const key of PATCHABLE_WORKER_DELEGATION_KEYS) {
		if (!Object.hasOwn(patch, key)) continue;
		const value = patch[key];
		if (value === undefined) {
			delete next[key];
			continue;
		}
		const normalized = normalizeWorkerDelegationLayer({ [key]: value });
		if (normalized && Object.hasOwn(normalized, key)) {
			(next as Record<string, unknown>)[key] = structuredClone((normalized as Record<string, unknown>)[key]);
		}
	}

	if (Object.hasOwn(patch, "modelPins")) {
		if (patch.modelPins === undefined || !hasAnyModelPin(patch.modelPins)) {
			delete next.modelPins;
		} else {
			const policy = compileWorkerModelPinPolicy({ [scope]: patch.modelPins });
			if (policy.status === "invalid") {
				throw new Error(`Invalid worker model pin settings: ${policy.diagnostics.join("; ")}`);
			}
			next.modelPins = structuredClone(patch.modelPins);
		}
	}

	if (Object.hasOwn(patch, "defaultModelPin")) {
		const nextPins: WorkerModelPinsSettings = next.modelPins ? structuredClone(next.modelPins) : {};
		if (patch.defaultModelPin === undefined) {
			delete nextPins.default;
		} else {
			nextPins.default = structuredClone(patch.defaultModelPin);
			const policy = compileWorkerModelPinPolicy({ [scope]: nextPins });
			if (policy.status === "invalid") {
				throw new Error(`Invalid worker model pin settings: ${policy.diagnostics.join("; ")}`);
			}
		}
		if (hasAnyModelPin(nextPins)) {
			next.modelPins = nextPins;
		} else {
			delete next.modelPins;
		}
	}

	return Object.keys(next).length > 0 ? next : undefined;
}
