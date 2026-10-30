import type { Usage } from "@caupulican/pi-ai";
import { isUnknownRecoveredToolResult } from "../../kernel/session/lifecycle-ledger.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { getSessionEntryUsage, getSessionEntryUsageComponents } from "../../kernel/usage.ts";
import { type GoalStatus, isGoalExecutionActive, isGoalTerminalStatus } from "../goals/goal-state.ts";
import {
	decodeGoalJournalPayload,
	GOAL_STATE_CUSTOM_TYPE,
	getLatestGoalStateSnapshot,
} from "../goals/session-goal-state.ts";
import { WORK_UNIT_CUSTOM_TYPE, type WorkUnitRecord } from "../work-units.ts";
import type { AccountingOrigin } from "./accounting-evidence.ts";
import { measureTaskExecutionTiming } from "./task-execution-timing.ts";
import {
	hasUnknownUsageModel,
	isMaintenanceUsageRoute,
	resolveEffectiveEntryCost,
	resolveSemanticUsageEntry,
	resolveSpawnedUsageComponents,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
} from "./usage-records.ts";

export interface ModelCostBreakdownRow {
	readonly model: string;
	readonly role: "root" | "subagent" | "icm" | "system_one";
	readonly calls: number;
	readonly tokens: number;
	readonly costUsd: number;
	readonly reportedCostUsd: number;
}

export interface TaskExecutionMetrics {
	readonly modelUnknownTokens?: number;
	readonly modelUnknownOperations?: number;
	readonly apiEquivalentPartial?: boolean;
	readonly id: string;
	readonly kind: "goal" | "task" | "worker";
	readonly title: string;
	readonly status: "active" | "completed" | "blocked" | "paused" | "cancelled" | "inactive" | "unknown";
	/** Older transcripts lack execution lease timing; their activity gaps are estimates. */
	readonly timingEstimated: boolean;
	readonly timingSource: "lifecycle" | "goal_ledger" | "worker_ledger" | "historical_estimate";
	readonly unresolvedTimedOperations: number;
	/** The goal lease accumulator is a distinct measure from provider/tool interval union. */
	readonly goalActiveMs?: number;
	readonly workerActiveMs?: number;
	/** Cumulative active execution time; timingEstimated identifies inferred historical activity. */
	readonly activeMs: number;
	/** Total wall-clock elapsed time in ms from task start to completion (or `nowMs` while active). */
	readonly wallMs: number;
	/** Assistant rounds (provider turns) executed for this task. */
	readonly rounds: number;
	/** Tool invocations executed during this task. */
	readonly toolCalls: number;
	readonly stepsCompleted?: number;
	readonly stepsTotal?: number;
	readonly tokens: number;
	readonly rootCostUsd: number;
	readonly subagentCostUsd: number;
	readonly icmCostUsd: number;
	readonly totalCostUsd: number;
}

export interface SessionTaskAndModelSummary {
	readonly modelUnknownTokens: number;
	readonly modelUnknownOperations: number;
	readonly apiEquivalentPartial: boolean;
	readonly currentTask?: TaskExecutionMetrics;
	readonly tasks: readonly TaskExecutionMetrics[];
	readonly models: readonly ModelCostBreakdownRow[];
	readonly systemOneCostUsd: number;
	readonly systemOneReports: number;
	readonly totalRounds: number;
	readonly totalToolCalls: number;
	readonly unassignedCostUsd: number;
}

export function isTaskExecutionActive(status: TaskExecutionMetrics["status"]): boolean {
	return status !== "inactive" && status !== "unknown" && isGoalExecutionActive(status);
}

export interface TaskMetricsGoalInput {
	readonly goalId: string;
	readonly revision?: number;
	readonly userGoal: string;
	readonly status: GoalStatus;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly continuationWallClockMs?: number;
	readonly continuationTurnsUsed?: number;
	readonly tokensUsed?: number;
	readonly continuationSpendUsd?: number;
	readonly continuationWorkerSpendUsd?: number;
	readonly requirements: readonly { readonly status: string }[];
}

export interface TaskMetricsPlanInput {
	readonly steps: readonly { readonly status: string }[];
	readonly archive: { readonly completed: number; readonly cancelled: number };
}

/** Max idle gap between consecutive messages still counted as continuous active turn work when no lease clock exists. */
const MAX_ACTIVE_TURN_GAP_MS = 10 * 60_000;

interface MutableTaskWindow {
	modelUnknownTokens?: number;
	modelUnknownOperations?: number;
	id: string;
	kind: TaskExecutionMetrics["kind"];
	goalId?: string;
	title: string;
	status: TaskExecutionMetrics["status"];
	startMs: number;
	endMs: number;
	activeMs: number;
	lastActivityMs?: number;
	tokens: number;
	rootCostUsd: number;
	subagentCostUsd: number;
	icmCostUsd: number;
	provisionalUserPrompt: boolean;
	goalState?: TaskMetricsGoalInput;
	goalWindowClosed?: boolean;
	workerActiveMs?: number;
}

function extractUserText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) return text.trim();
		}
	}
	return "";
}

function isContinuationUserMessage(text: string): boolean {
	return (
		text.startsWith("Continue active goal.") ||
		text.startsWith("System One route:") ||
		text.startsWith("[Automated Recovery]")
	);
}

function cleanTaskTitle(raw: string): string {
	const cleaned = raw
		.replace(/^<chat>[\s\S]*?<\/chat>\s*/u, "")
		.replace(/^Current time:[^\n]*\n?/u, "")
		.replace(/\s+/gu, " ")
		.trim();
	if (!cleaned) return "Session task";
	return cleaned.length <= 96 ? cleaned : `${cleaned.slice(0, 95)}…`;
}

function mapGoalStatus(status: string | undefined): TaskExecutionMetrics["status"] {
	if (status === "completed") return "completed";
	if (status === "blocked" || status === "usage_limited" || status === "budget_limited") return "blocked";
	if (status === "paused") return "paused";
	if (status === "cancelled") return "cancelled";
	return "active";
}

function makeTaskWindow(
	id: string,
	kind: TaskExecutionMetrics["kind"],
	title: string,
	startMs: number,
	provisionalUserPrompt: boolean,
	goalId?: string,
): MutableTaskWindow {
	return {
		id,
		kind,
		...(goalId ? { goalId } : {}),
		title: cleanTaskTitle(title),
		status: "active",
		startMs,
		endMs: startMs,
		activeMs: 0,
		lastActivityMs: startMs,
		tokens: 0,
		rootCostUsd: 0,
		subagentCostUsd: 0,
		icmCostUsd: 0,
		provisionalUserPrompt,
	};
}

export function formatCompactTaskDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes > 0 ? `${hours}h${String(remMinutes).padStart(2, "0")}m` : `${hours}h`;
}

export function computeSessionTaskAndModelMetrics(options: {
	entries: readonly SessionEntry[];
	goalState?: TaskMetricsGoalInput;
	taskState?: TaskMetricsPlanInput;
	isStreaming?: boolean;
	nowMs?: number;
}): SessionTaskAndModelSummary {
	const nowMs = options.nowMs ?? Date.now();
	const modelMap = new Map<
		string,
		{
			model: string;
			role: ModelCostBreakdownRow["role"];
			calls: number;
			tokens: number;
			costUsd: number;
			reportedCostUsd: number;
		}
	>();
	const seenSpawned = new Set<string>();
	const seenSemantic = new Set<string>();
	let systemOneCostUsd = 0;
	let systemOneReports = 0;
	let unassignedCostUsd = 0;
	let modelUnknownTokens = 0;
	let modelUnknownOperations = 0;
	const recordUnknownModel = (
		usage: Usage,
		provider: string | undefined,
		model: string | undefined,
		owner?: MutableTaskWindow,
	): void => {
		if (!hasUnknownUsageModel(usage, provider, model)) return;
		modelUnknownTokens += usage.totalTokens;
		modelUnknownOperations++;
		if (owner) {
			owner.modelUnknownTokens = (owner.modelUnknownTokens ?? 0) + usage.totalTokens;
			owner.modelUnknownOperations = (owner.modelUnknownOperations ?? 0) + 1;
		}
	};

	const recordModelUsage = (
		model: string,
		role: ModelCostBreakdownRow["role"],
		tokens: number,
		costUsd: number,
		reportedCostUsd = costUsd,
	): void => {
		const key = `${role}:${model}`;
		const existing = modelMap.get(key);
		if (existing) {
			existing.calls += 1;
			existing.tokens += tokens;
			existing.costUsd += costUsd;
			existing.reportedCostUsd += reportedCostUsd;
		} else {
			modelMap.set(key, { model, role, calls: 1, tokens, costUsd, reportedCostUsd });
		}
	};

	const windows: MutableTaskWindow[] = [];
	const workerWindows = new Map<string, MutableTaskWindow>();
	const workerAttemptTimes = new Map<string, { owner: MutableTaskWindow; milliseconds: number }>();
	const entryOwners = new Map<string, MutableTaskWindow>();
	const receiptOwner = (
		origin: AccountingOrigin | undefined,
		goalId?: string,
		at?: number,
	): MutableTaskWindow | undefined => {
		const goal = origin?.goalId ?? goalId;
		const owner =
			(goal ? windows.find((window) => window.goalId === goal) : undefined) ??
			(origin?.entryId ? entryOwners.get(origin.entryId) : undefined);
		if (owner || !origin?.taskId) return owner;
		const id = JSON.stringify([origin.sessionId, origin.taskId]);
		let worker = workerWindows.get(id);
		if (!worker && at !== undefined && Number.isFinite(at)) {
			worker = makeTaskWindow(`worker:${id}`, "worker", `Worker task ${origin.taskId}`, at, false);
			worker.status = "unknown";
			workerWindows.set(id, worker);
			windows.push(worker);
		} else if (worker && at !== undefined && Number.isFinite(at)) {
			worker.startMs = Math.min(worker.startMs, at);
			worker.endMs = Math.max(worker.endMs, at);
		}
		return worker;
	};
	let currentWindow: MutableTaskWindow | undefined;
	let latestGoalEntry: Extract<SessionEntry, { type: "custom" }> | undefined;
	const previousGoalEntries = new Map<string, Extract<SessionEntry, { type: "custom" }> | undefined>();
	const goalSource = {
		getLatestCustomEntryOnBranch: (_type: string, before?: string | null) =>
			before ? previousGoalEntries.get(before) : latestGoalEntry,
	};

	const advanceWindowClock = (win: MutableTaskWindow, entryMs: number): void => {
		if (!Number.isFinite(entryMs) || entryMs <= 0) return;
		if (entryMs < win.startMs) win.startMs = entryMs;
		if (entryMs > win.endMs) win.endMs = entryMs;
		if (win.lastActivityMs !== undefined && entryMs > win.lastActivityMs) {
			const delta = entryMs - win.lastActivityMs;
			if (delta <= MAX_ACTIVE_TURN_GAP_MS) win.activeMs += delta;
		}
		win.lastActivityMs = entryMs;
	};
	const openGoalWindow = (goalId: string, title: string, startMs: number, resumedAt = startMs): MutableTaskWindow => {
		if (currentWindow?.goalId === goalId) return currentWindow;
		const existing = windows.find((window) => window.goalId === goalId);
		if (existing) {
			if (currentWindow && isTaskExecutionActive(currentWindow.status)) currentWindow.status = "inactive";
			currentWindow = existing;
			currentWindow.goalWindowClosed = false;
			currentWindow.lastActivityMs = resumedAt;
			return currentWindow;
		}
		if (currentWindow?.provisionalUserPrompt && !currentWindow.goalId) {
			currentWindow.id = goalId;
			currentWindow.kind = "goal";
			currentWindow.goalId = goalId;
			currentWindow.title = cleanTaskTitle(title);
			currentWindow.provisionalUserPrompt = false;
			advanceWindowClock(currentWindow, startMs);
		} else {
			if (currentWindow && isTaskExecutionActive(currentWindow.status)) currentWindow.status = "inactive";
			currentWindow = makeTaskWindow(goalId, "goal", title, startMs, false, goalId);
			windows.push(currentWindow);
		}
		return currentWindow;
	};

	for (const entry of options.entries) {
		const entryMs = Date.parse(entry.timestamp) || nowMs;
		if (currentWindow) entryOwners.set(entry.id, currentWindow);
		if (entry.type === "custom" && entry.customType === "accounting_worker_time") {
			const data = entry.data as {
				milliseconds: number;
				taskId?: string;
				goalId?: string;
				origin?: AccountingOrigin;
			};
			const owner = receiptOwner(data.origin, data.goalId);
			if (
				owner &&
				data.origin?.operationId &&
				typeof data.taskId === "string" &&
				data.origin.taskId === data.taskId &&
				Number.isFinite(data.milliseconds) &&
				data.milliseconds >= 0
			) {
				const key = JSON.stringify([data.origin.sessionId, data.taskId, data.origin.operationId]);
				const prior = workerAttemptTimes.get(key);
				if (prior) prior.milliseconds = Math.max(prior.milliseconds, data.milliseconds);
				else workerAttemptTimes.set(key, { owner, milliseconds: data.milliseconds });
			}
			continue;
		}
		const predecessor = entry.parentId ? previousGoalEntries.get(entry.parentId) : undefined;
		previousGoalEntries.set(entry.id, predecessor);
		if (entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE) {
			latestGoalEntry = entry;
			previousGoalEntries.set(entry.id, latestGoalEntry);
			const state = getLatestGoalStateSnapshot(goalSource);
			const window = state
				? openGoalWindow(state.goalId, state.userGoal, Date.parse(state.createdAt) || entryMs, entryMs)
				: undefined;
			if (state && window) {
				entryOwners.set(entry.id, window);
				window.goalState = state;
				window.status = mapGoalStatus(state.status);
				window.title = cleanTaskTitle(state.userGoal);
				window.endMs = Math.max(window.endMs, Date.parse(state.updatedAt) || entryMs);
			} else if (currentWindow?.kind === "goal") {
				const journal = decodeGoalJournalPayload(entry.data);
				if (journal?.kind === "cleared" && journal.goalId === currentWindow.goalId) {
					currentWindow.status = "inactive";
					currentWindow.endMs = Math.max(currentWindow.endMs, Date.parse(journal.clearedAt) || entryMs);
				} else currentWindow.status = "unknown";
				currentWindow.goalWindowClosed = true;
			}
			continue;
		}
		if (entry.type === "custom" && entry.customType === WORK_UNIT_CUSTOM_TYPE) {
			const data = entry.data as WorkUnitRecord | undefined;
			if (data?.kind === "declared" && typeof data.goalId === "string") {
				const openedAt =
					typeof data.openedAt === "number" && Number.isFinite(data.openedAt) ? data.openedAt : entryMs;
				openGoalWindow(data.goalId, data.reason ?? data.goalId, openedAt);
				if (currentWindow) entryOwners.set(entry.id, currentWindow);
				continue;
			}
		}

		if (entry.type === "message" && entry.message.role === "user") {
			const text = extractUserText(entry.message.content);
			const canStartNew =
				!isContinuationUserMessage(text) &&
				(!currentWindow ||
					currentWindow.kind === "task" ||
					currentWindow.status === "inactive" ||
					currentWindow.status === "unknown" ||
					(currentWindow.goalState !== undefined &&
						isGoalTerminalStatus(currentWindow.goalState.status) &&
						entryMs > (Date.parse(currentWindow.goalState.updatedAt) || 0)));
			if (canStartNew) {
				if (currentWindow && isTaskExecutionActive(currentWindow.status)) currentWindow.status = "inactive";
				currentWindow = makeTaskWindow(`task-${windows.length + 1}`, "task", text, entryMs, true);
				windows.push(currentWindow);
				entryOwners.set(entry.id, currentWindow);
			} else if (currentWindow) {
				currentWindow.lastActivityMs = entryMs;
				if (entryMs > currentWindow.endMs) currentWindow.endMs = entryMs;
			}
			continue;
		}

		if (entry.type === "custom" && entry.customType === SPAWNED_USAGE_CUSTOM_TYPE) {
			const report = entry.data as SpawnedUsageReport | undefined;
			if (!report) continue;
			if (report.reportId) {
				if (seenSpawned.has(report.reportId)) continue;
				seenSpawned.add(report.reportId);
			}
			const owner = receiptOwner(report.origin, report.goalId, Date.parse(entry.timestamp));
			for (const { part, cost: resolved } of resolveSpawnedUsageComponents(report, entry.timestamp)) {
				const tok = part.usage.input + part.usage.output + part.usage.cacheRead + part.usage.cacheWrite;
				recordUnknownModel(part.usage, part.provider, part.model, owner);
				if (owner) {
					owner.tokens += tok;
					owner.subagentCostUsd += resolved.total;
				} else unassignedCostUsd += resolved.total;
				recordModelUsage(
					part.model
						? `${part.provider ?? "unknown"}/${part.model}${report.costBasis === "response" || report.usageComponents !== undefined ? "" : " subtree"}`
						: (report.label ?? "subagent subtree"),
					"subagent",
					tok,
					resolved.total,
					resolved.reportedTotal,
				);
			}
			continue;
		}

		const semantic = resolveSemanticUsageEntry(entry);
		if (semantic) {
			const { report, cost: resolved } = semantic;
			if (seenSemantic.has(report.reportId)) continue;
			seenSemantic.add(report.reportId);
			const tok = report.usage.input + report.usage.output + report.usage.cacheRead + report.usage.cacheWrite;
			const role =
				report.route === "history_summary" ? "icm" : isMaintenanceUsageRoute(report.route) ? "root" : "system_one";
			recordModelUsage(
				`${report.provider}/${report.model || role}`,
				role,
				tok,
				resolved.total,
				resolved.reportedTotal,
			);
			const owner = receiptOwner(report.origin, undefined, Date.parse(report.responseTimestamp ?? entry.timestamp));
			recordUnknownModel(report.usage, report.provider, report.model, owner);
			if (owner) {
				owner.tokens += tok;
				if (role === "icm") owner.icmCostUsd += resolved.total;
				else owner.rootCostUsd += resolved.total;
			} else unassignedCostUsd += resolved.total;
			if (role === "system_one") {
				systemOneCostUsd += resolved.total;
				systemOneReports += 1;
			}
			continue;
		}

		if (!currentWindow) {
			if (!getSessionEntryUsage(entry)) continue;
			currentWindow = makeTaskWindow(
				options.goalState?.goalId ?? "task-1",
				options.goalState ? "goal" : "task",
				options.goalState?.userGoal ?? "Session work",
				entryMs,
				true,
				options.goalState?.goalId,
			);
			windows.push(currentWindow);
			entryOwners.set(entry.id, currentWindow);
		}

		const assistant = entry.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
		if (assistant) {
			advanceWindowClock(currentWindow, entryMs);
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			if (!isUnknownRecoveredToolResult(entry.message)) advanceWindowClock(currentWindow, entryMs);
		}
		for (const part of getSessionEntryUsageComponents(entry)) {
			const usage = part.usage;
			const cost = resolveEffectiveEntryCost(usage, {
				model: part.model,
				provider: part.provider,
				kind: "own",
			});
			if (!cost) continue;
			const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
			currentWindow.tokens += tokens;
			currentWindow.rootCostUsd += cost.total;
			recordUnknownModel(usage, part.provider, part.model, currentWindow);
			const model = part.model
				? `${part.provider ?? "unknown"}/${part.model}`
				: entry.type === "message"
					? "tool usage (model unreported)"
					: `${entry.type === "compaction" ? "compaction" : "branch summary"} (model unrecorded)`;
			recordModelUsage(model, "root", tokens, cost.total, cost.reportedTotal);
		}
	}

	const goal = options.goalState;
	for (const { owner, milliseconds } of workerAttemptTimes.values())
		owner.workerActiveMs = (owner.workerActiveMs ?? 0) + milliseconds;
	if (goal) {
		let goalWin = windows.find((w) => w.goalId === goal.goalId);
		if (!goalWin && windows.length > 0 && windows[windows.length - 1]!.provisionalUserPrompt) {
			goalWin = windows[windows.length - 1]!;
			goalWin.id = goal.goalId;
			goalWin.kind = "goal";
			goalWin.goalId = goal.goalId;
			goalWin.provisionalUserPrompt = false;
		}
		const createdMs = Date.parse(goal.createdAt) || nowMs;
		const updatedMs = Date.parse(goal.updatedAt) || createdMs;
		if (!goalWin) {
			goalWin = makeTaskWindow(goal.goalId, "goal", goal.userGoal, createdMs, false, goal.goalId);
			windows.push(goalWin);
		}
		goalWin.title = cleanTaskTitle(goal.userGoal);
		goalWin.status = mapGoalStatus(goal.status);
		if (createdMs > 0 && createdMs < goalWin.startMs) goalWin.startMs = createdMs;
		if (updatedMs > goalWin.endMs) goalWin.endMs = updatedMs;
		goalWin.goalState = goal;
		currentWindow = goalWin;
	}

	const plan = options.taskState;
	const planTotal = plan ? plan.steps.length + plan.archive.completed + plan.archive.cancelled : 0;
	const planDone = plan ? plan.archive.completed + plan.steps.filter((s) => s.status === "completed").length : 0;

	const operationTimings = measureTaskExecutionTiming(options.entries, entryOwners);
	const tasks: TaskExecutionMetrics[] = windows.map((win) => {
		const isLast = win === currentWindow;
		const isGoalMatch = goal !== undefined && win.goalId === goal.goalId;
		const recordedGoal = win.goalState;
		const isRunningNow =
			!win.goalWindowClosed &&
			isLast &&
			(options.isStreaming === true || (isGoalMatch && isGoalExecutionActive(goal.status)));
		const timing = operationTimings.get(win);
		const endedAt = Math.max(win.endMs, timing?.lastEndMs ?? win.endMs);
		const wallMs = Math.max(0, (isRunningNow ? Math.max(endedAt, nowMs) : endedAt) - win.startMs);
		const measuredActive = recordedGoal?.continuationWallClockMs;
		const activeMs = timing?.hasLifecycle
			? timing.activeMs
			: win.kind === "worker"
				? (win.workerActiveMs ?? 0)
				: Math.min(wallMs, measuredActive ?? win.activeMs);
		const status = win.goalWindowClosed
			? win.status
			: recordedGoal
				? mapGoalStatus(recordedGoal.status)
				: isRunningNow
					? "active"
					: win.kind === "goal" || win.kind === "worker"
						? win.status
						: "inactive";
		const stepsCompleted =
			(isLast || isGoalMatch) && planTotal > 0
				? planDone
				: isGoalMatch && goal.requirements.length > 0
					? goal.requirements.filter((r) => r.status === "satisfied").length
					: undefined;
		const stepsTotal =
			(isLast || isGoalMatch) && planTotal > 0
				? planTotal
				: isGoalMatch && goal.requirements.length > 0
					? goal.requirements.length
					: undefined;
		return {
			modelUnknownTokens: win.modelUnknownTokens,
			modelUnknownOperations: win.modelUnknownOperations,
			apiEquivalentPartial: (win.modelUnknownTokens ?? 0) > 0,
			id: win.id,
			kind: win.kind,
			title: win.title,
			status,
			timingEstimated: !timing?.hasLifecycle && measuredActive === undefined && win.workerActiveMs === undefined,
			timingSource: timing?.hasLifecycle
				? "lifecycle"
				: measuredActive !== undefined
					? "goal_ledger"
					: win.kind === "worker" && win.workerActiveMs !== undefined
						? "worker_ledger"
						: "historical_estimate",
			unresolvedTimedOperations: timing?.unresolvedIntervals ?? 0,
			...(measuredActive !== undefined ? { goalActiveMs: measuredActive } : {}),
			...(win.workerActiveMs !== undefined ? { workerActiveMs: win.workerActiveMs } : {}),
			activeMs,
			wallMs: Math.max(activeMs, wallMs),
			rounds: timing?.requests ?? 0,
			toolCalls: timing?.toolCalls ?? 0,
			...(stepsTotal !== undefined && stepsCompleted !== undefined ? { stepsCompleted, stepsTotal } : {}),
			tokens: win.tokens,
			rootCostUsd: win.rootCostUsd,
			subagentCostUsd: win.subagentCostUsd,
			icmCostUsd: win.icmCostUsd,
			totalCostUsd: win.rootCostUsd + win.subagentCostUsd + win.icmCostUsd,
		};
	});

	const models = [...modelMap.values()].sort(
		(a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.model.localeCompare(b.model),
	);
	const currentTask = tasks.find((task) => task.id === currentWindow?.id);
	return {
		modelUnknownTokens,
		modelUnknownOperations,
		apiEquivalentPartial: modelUnknownTokens > 0,
		...(currentTask ? { currentTask } : {}),
		tasks,
		models,
		systemOneCostUsd,
		systemOneReports,
		totalRounds: tasks.reduce((sum, task) => sum + task.rounds, 0),
		totalToolCalls: tasks.reduce((sum, task) => sum + task.toolCalls, 0),
		unassignedCostUsd,
	};
}
