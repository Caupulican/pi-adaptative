/**
 * Fleet capacity settings: the fleet ceilings, budgets and brake, the worktree sync gate, the process matrix and the
 * provider admission limits. Each resolver is pure over the settings slice it is given; the manager delegates to them.
 */

import { isPlainRecord } from "../util/value-guards.ts";
import {
	DEFAULT_FLEET_BRAKE_MIN_USD,
	DEFAULT_FLEET_CEILING_RUNNING,
	DEFAULT_FLEET_CEILING_TREE,
	DEFAULT_FLEET_CEILING_WRITERS,
	DEFAULT_FLEET_METERED_USD_PER_DAY,
	DEFAULT_FLEET_METERED_USD_PER_GOAL,
	DEFAULT_FLEET_QUEUE_HORIZON_MS,
	DEFAULT_FLEET_RESERVE_MEMORY_PERCENT,
	DEFAULT_PROCESS_MATRIX_ADOPTION_GRACE_MS,
	DEFAULT_PROCESS_MATRIX_HEARTBEAT_MS,
	DEFAULT_PROCESS_MATRIX_WATCHER_POLL_MS,
	DEFAULT_PROVIDER_ADMISSION_ENABLED,
	DEFAULT_PROVIDER_ADMISSION_FOREGROUND_LIMIT_WAIT_MS,
	DEFAULT_PROVIDER_ADMISSION_LIMITS,
	DEFAULT_PROVIDER_ADMISSION_MAX_WAIT_MS,
	DEFAULT_WORKTREE_SYNC_GATE_TIMEOUT_MS,
	DEFAULT_WORKTREE_SYNC_MAX_LANES,
	DEFAULT_WORKTREE_SYNC_POLICY,
	MAX_PROVIDER_ADMISSION_LIMIT,
	MAX_PROVIDER_ADMISSION_MAX_WAIT_MS,
	sanitizeIntegerSetting,
	sanitizeNumberSetting,
} from "./settings-rules.ts";
import type {
	ResolvedFleetSettings,
	ResolvedProcessMatrixSettings,
	ResolvedProviderAdmissionSettings,
	ResolvedWorktreeSyncSettings,
	Settings,
} from "./settings-schema.ts";

/** The fleet ceilings, metered budgets, brake and queue horizon, each clamped to its range. */
export function resolveFleetSettings(settings: Pick<Settings, "fleet">): ResolvedFleetSettings {
	const configured = settings.fleet ?? {};
	const ceiling = (value: unknown, fallback: number) =>
		sanitizeIntegerSetting(value, fallback, 1, Number.MAX_SAFE_INTEGER);
	const dollars = (value: unknown, fallback: number) =>
		sanitizeNumberSetting(value, fallback, 0, Number.MAX_SAFE_INTEGER);
	return {
		ceiling: {
			running: ceiling(configured.ceiling?.running, DEFAULT_FLEET_CEILING_RUNNING),
			writers: ceiling(configured.ceiling?.writers, DEFAULT_FLEET_CEILING_WRITERS),
			tree: ceiling(configured.ceiling?.tree, DEFAULT_FLEET_CEILING_TREE),
		},
		reserve: {
			memoryPercent: sanitizeNumberSetting(
				configured.reserve?.memoryPercent,
				DEFAULT_FLEET_RESERVE_MEMORY_PERCENT,
				0,
				90,
			),
		},
		budgets: {
			meteredUsdPerDay: dollars(configured.budgets?.meteredUsdPerDay, DEFAULT_FLEET_METERED_USD_PER_DAY),
			meteredUsdPerGoal: dollars(configured.budgets?.meteredUsdPerGoal, DEFAULT_FLEET_METERED_USD_PER_GOAL),
		},
		brake: { minUsd: dollars(configured.brake?.minUsd, DEFAULT_FLEET_BRAKE_MIN_USD) },
		queueHorizonMs: sanitizeIntegerSetting(
			configured.queueHorizonMs,
			DEFAULT_FLEET_QUEUE_HORIZON_MS,
			0,
			Number.MAX_SAFE_INTEGER,
		),
	};
}

/** The worktree sync policy, gate and lane limits, each clamped to its range. */
export function resolveWorktreeSyncSettings(settings: Pick<Settings, "worktreeSync">): ResolvedWorktreeSyncSettings {
	const configured = settings.worktreeSync ?? {};
	const resolved: ResolvedWorktreeSyncSettings = {
		enabled: configured.enabled !== false,
		syncPolicy:
			configured.syncPolicy === "overlap_mandatory" || configured.syncPolicy === "land_time_only"
				? configured.syncPolicy
				: DEFAULT_WORKTREE_SYNC_POLICY,
		gate: configured.gate === "off" ? "off" : "on",
		gateTimeoutMs: sanitizeIntegerSetting(
			configured.gateTimeoutMs,
			DEFAULT_WORKTREE_SYNC_GATE_TIMEOUT_MS,
			1000,
			3_600_000,
		),
		maxLanes: sanitizeIntegerSetting(
			configured.maxLanes,
			DEFAULT_WORKTREE_SYNC_MAX_LANES,
			1,
			Number.MAX_SAFE_INTEGER,
		),
		workerLand: configured.workerLand === "allow" ? "allow" : "deny",
	};
	if (typeof configured.mainBranch === "string" && configured.mainBranch.trim().length > 0) {
		resolved.mainBranch = configured.mainBranch.trim();
	}
	if (typeof configured.gateCommand === "string" && configured.gateCommand.trim().length > 0) {
		resolved.gateCommand = configured.gateCommand.trim();
	}
	if (typeof configured.worktreesRoot === "string" && configured.worktreesRoot.trim().length > 0) {
		resolved.worktreesRoot = configured.worktreesRoot.trim();
	}
	return resolved;
}

/** The process matrix heartbeat, adoption grace and watcher poll intervals, each clamped to its range. */
export function resolveProcessMatrixSettings(settings: Pick<Settings, "processMatrix">): ResolvedProcessMatrixSettings {
	const configured = settings.processMatrix ?? {};
	return {
		enabled: configured.enabled !== false,
		heartbeatMs: sanitizeIntegerSetting(configured.heartbeatMs, DEFAULT_PROCESS_MATRIX_HEARTBEAT_MS, 1000, 600_000),
		adoptionGraceMs: sanitizeIntegerSetting(
			configured.adoptionGraceMs,
			DEFAULT_PROCESS_MATRIX_ADOPTION_GRACE_MS,
			5000,
			3_600_000,
		),
		watcherPollMs: sanitizeIntegerSetting(
			configured.watcherPollMs,
			DEFAULT_PROCESS_MATRIX_WATCHER_POLL_MS,
			1000,
			600_000,
		),
	};
}

/** Provider admission: the switch, the per-provider limits (zero removes a default) and the wait bounds. */
export function resolveProviderAdmissionSettings(
	settings: Pick<Settings, "providerAdmission">,
): ResolvedProviderAdmissionSettings {
	const configured = isPlainRecord(settings.providerAdmission) ? settings.providerAdmission : {};
	const limits: Record<string, number> = { ...DEFAULT_PROVIDER_ADMISSION_LIMITS };
	if (isPlainRecord(configured.limits)) {
		for (const [provider, value] of Object.entries(configured.limits)) {
			if (!provider.trim()) continue;
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0 ||
				value > MAX_PROVIDER_ADMISSION_LIMIT
			) {
				continue;
			}
			if (value === 0) delete limits[provider];
			else limits[provider] = value;
		}
	}
	return {
		enabled: typeof configured.enabled === "boolean" ? configured.enabled : DEFAULT_PROVIDER_ADMISSION_ENABLED,
		limits,
		maxWaitMs: sanitizeIntegerSetting(
			configured.maxWaitMs,
			DEFAULT_PROVIDER_ADMISSION_MAX_WAIT_MS,
			0,
			MAX_PROVIDER_ADMISSION_MAX_WAIT_MS,
		),
		foregroundLimitWaitMs: sanitizeIntegerSetting(
			configured.foregroundLimitWaitMs,
			DEFAULT_PROVIDER_ADMISSION_FOREGROUND_LIMIT_WAIT_MS,
			0,
			MAX_PROVIDER_ADMISSION_MAX_WAIT_MS,
		),
	};
}
