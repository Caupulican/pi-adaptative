/**
 * Session runtime settings: the per-turn cost guard and its normalizer, the logging bounds, the skill curator, the
 * provider retry and stream stall budgets, the self-modification switch, and the workbench layout. Each resolver is
 * pure over the settings slice it is given; the manager delegates to them.
 */

import { isLogLevel, type LogLevel } from "../../kernel/harness-log.ts";
import { type CostGuardSettings, DEFAULT_COST_GUARD_SETTINGS } from "../cost-guard.ts";
import {
	DEFAULT_WORKBENCH_SETTINGS,
	isWorkbenchGraphView,
	MAX_GRAPH_FRACTION,
	MIN_GRAPH_FRACTION,
	parseStallBoundMs,
	sanitizeIntegerSetting,
	sanitizeNumberSetting,
} from "./settings-rules.ts";
import type { Settings, StreamStallModelClass, StreamStallSettings, WorkbenchSettings } from "./settings-schema.ts";

/** The cost guard as written to settings: explicit enablement, a finite non-negative ceiling and a known action. */
export function normalizeCostGuardSettings(settings: CostGuardSettings): CostGuardSettings {
	return {
		enabled: settings.enabled === true,
		maxTurnUsd:
			Number.isFinite(settings.maxTurnUsd) && settings.maxTurnUsd >= 0
				? settings.maxTurnUsd
				: DEFAULT_COST_GUARD_SETTINGS.maxTurnUsd,
		action: settings.action === "downgrade" ? "downgrade" : "warn",
	};
}

/** The optional per-turn cost guard: explicit enablement, a finite non-negative ceiling and the action on breach. */
export function resolveCostGuardSettings(settings: Pick<Settings, "costGuard">): CostGuardSettings {
	const configuredMaxTurnUsd = settings.costGuard?.maxTurnUsd;
	return {
		enabled: settings.costGuard?.enabled === true,
		maxTurnUsd:
			typeof configuredMaxTurnUsd === "number" && Number.isFinite(configuredMaxTurnUsd) && configuredMaxTurnUsd >= 0
				? configuredMaxTurnUsd
				: DEFAULT_COST_GUARD_SETTINGS.maxTurnUsd,
		action: settings.costGuard?.action === "downgrade" ? "downgrade" : DEFAULT_COST_GUARD_SETTINGS.action,
	};
}

/** The logging bounds: level, categories, file size and retention, each kept only when valid. */
export function resolveLoggingSettings(settings: Pick<Settings, "logging">): {
	level?: LogLevel;
	categories?: string[];
	maxFileMb?: number;
	retainDays?: number;
} {
	const logging = settings.logging;
	if (!logging || typeof logging !== "object") return {};
	const categories = Array.isArray(logging.categories)
		? logging.categories.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		: undefined;
	return {
		...(isLogLevel(logging.level) ? { level: logging.level } : {}),
		...(categories && categories.length > 0 ? { categories } : {}),
		...(typeof logging.maxFileMb === "number" && logging.maxFileMb > 0 && logging.maxFileMb <= 1024
			? { maxFileMb: logging.maxFileMb }
			: {}),
		...(typeof logging.retainDays === "number" && logging.retainDays > 0 && logging.retainDays <= 365
			? { retainDays: logging.retainDays }
			: {}),
	};
}

/** The skill curator: auto-archive switch and stale-day threshold. */
export function resolveCuratorSettings(settings: Pick<Settings, "curator">): {
	autoArchive: boolean;
	staleDays: number;
} {
	return {
		autoArchive: settings.curator?.autoArchive ?? true,
		staleDays: settings.curator?.staleDays ?? 30,
	};
}

/** Provider-level retry bounds: timeout, retry count and maximum delay. */
export function resolveProviderRetrySettings(settings: Pick<Settings, "retry">): {
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs: number;
} {
	return {
		timeoutMs: settings.retry?.provider?.timeoutMs,
		maxRetries: settings.retry?.provider?.maxRetries,
		maxRetryDelayMs: settings.retry?.provider?.maxRetryDelayMs ?? 60000,
	};
}

/** The stream-stall bounds one model class sets; unset fields stay undefined for the wiring site to default. */
export function resolveStreamStallSettings(
	settings: Pick<Settings, "retry">,
	modelClass: StreamStallModelClass,
): StreamStallSettings {
	const stall = settings.retry?.stall;
	const named = modelClass === "local" ? stall?.local : stall?.cloud;
	const read = (field: keyof StreamStallSettings): number | undefined => {
		if (named?.[field] !== undefined) {
			return parseStallBoundMs(named[field], `retry.stall.${modelClass}.${field}`);
		}
		// Only the local budget inherits the pre-split keys; a cloud stream never did.
		return modelClass === "local" ? parseStallBoundMs(stall?.[field], `retry.stall.${field}`) : undefined;
	};
	return {
		connectMs: read("connectMs"),
		activeIdleMs: read("activeIdleMs"),
		quietIdleMs: read("quietIdleMs"),
	};
}

/** The workbench layout, every stored value clamped to its range and unknown values replaced by the default. */
export function resolveWorkbenchSettings(settings: Pick<Settings, "workbench">): Required<WorkbenchSettings> {
	const stored = settings.workbench ?? {};
	const rows = typeof stored.rows === "number" && Number.isFinite(stored.rows) ? stored.rows : undefined;
	return {
		mouse: stored.mouse ?? DEFAULT_WORKBENCH_SETTINGS.mouse,
		rows: rows === undefined ? "auto" : Math.max(2, Math.min(60, Math.floor(rows))),
		collapsed: stored.collapsed ?? DEFAULT_WORKBENCH_SETTINGS.collapsed,
		inspector: stored.inspector ?? DEFAULT_WORKBENCH_SETTINGS.inspector,
		executionMaximized: stored.executionMaximized ?? DEFAULT_WORKBENCH_SETTINGS.executionMaximized,
		inspectorFraction: sanitizeNumberSetting(
			stored.inspectorFraction,
			DEFAULT_WORKBENCH_SETTINGS.inspectorFraction,
			0.2,
			0.45,
		),
		layout: stored.layout === "columns" ? "columns" : DEFAULT_WORKBENCH_SETTINGS.layout,
		conversationFraction: sanitizeNumberSetting(
			stored.conversationFraction,
			DEFAULT_WORKBENCH_SETTINGS.conversationFraction,
			0.3,
			0.7,
		),
		previews: sanitizeIntegerSetting(stored.previews, DEFAULT_WORKBENCH_SETTINGS.previews, 4, 200),
		// The left pane has its own flag: a stored `graph: "hidden"` hides only the graph, never the Chats list.
		leftPane: stored.leftPane === "hidden" ? "hidden" : DEFAULT_WORKBENCH_SETTINGS.leftPane,
		graph: stored.graph === "hidden" ? "hidden" : DEFAULT_WORKBENCH_SETTINGS.graph,
		graphFraction: sanitizeNumberSetting(
			stored.graphFraction,
			DEFAULT_WORKBENCH_SETTINGS.graphFraction,
			MIN_GRAPH_FRACTION,
			MAX_GRAPH_FRACTION,
		),
		graphView: isWorkbenchGraphView(stored.graphView) ? stored.graphView : DEFAULT_WORKBENCH_SETTINGS.graphView,
	};
}

/** The self-modification switch and the source paths it may modify. */
export function resolveSelfModificationSettings(settings: Pick<Settings, "selfModification">): {
	enabled: boolean;
	sourcePath?: string;
	sourcePaths?: string[];
} {
	return {
		enabled: settings.selfModification?.enabled ?? false,
		sourcePath: settings.selfModification?.sourcePath,
		sourcePaths: settings.selfModification?.sourcePaths,
	};
}
