import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { getSessionEntryUsage } from "../../kernel/usage.ts";
import { type GoalStatus, isGoalExecutionActive, isGoalTerminalStatus } from "../goals/goal-state.ts";
import {
	decodeGoalJournalPayload,
	GOAL_STATE_CUSTOM_TYPE,
	getLatestGoalStateSnapshot,
} from "../goals/session-goal-state.ts";
import { WORK_UNIT_CUSTOM_TYPE, type WorkUnitRecord } from "../work-units.ts";
import {
	resolveEffectiveEntryCost,
	resolveSemanticUsageEntry,
	SPAWNED_USAGE_CUSTOM_TYPE,
	type SpawnedUsageReport,
} from "./usage-records.ts";

export interface ModelCostBreakdownRow {
	readonly model: string;
	readonly role: "root" | "subagent" | "icm" | "system_one";
	readonly calls: number;
	readonly tokens: number;
	readonly costUsd: number;
}

export interface TaskExecutionMetrics {
	readonly id: string;
	readonly kind: "goal" | "task";
	readonly title: string;
	readonly status: "active" | "completed" | "blocked" | "paused" | "cancelled" | "inactive" | "unknown";
	/** Older transcripts lack execution lease timing; their activity gaps are estimates. */
	readonly timingEstimated: boolean;
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
	id: string;
	kind: "goal" | "task";
	goalId?: string;
	title: string;
	status: TaskExecutionMetrics["status"];
	startMs: number;
	endMs: number;
	activeMs: number;
	lastActivityMs?: number;
	rounds: number;
	toolCalls: number;
	tokens: number;
	rootCostUsd: number;
	subagentCostUsd: number;
	icmCostUsd: number;
	provisionalUserPrompt: boolean;
	goalState?: TaskMetricsGoalInput;
	goalWindowClosed?: boolean;
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
	kind: "goal" | "task",
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
		rounds: 0,
		toolCalls: 0,
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
		{ model: string; role: ModelCostBreakdownRow["role"]; calls: number; tokens: number; costUsd: number }
	>();
	const seenSpawned = new Set<string>();
	const seenSemantic = new Set<string>();
	let systemOneCostUsd = 0;
	let systemOneReports = 0;
	let totalRounds = 0;
	let totalToolCalls = 0;
	let unassignedCostUsd = 0;

	const recordModelUsage = (
		model: string,
		role: ModelCostBreakdownRow["role"],
		tokens: number,
		costUsd: number,
	): void => {
		const key = `${role}:${model}`;
		const existing = modelMap.get(key);
		if (existing) {
			existing.calls += 1;
			existing.tokens += tokens;
			existing.costUsd += costUsd;
		} else {
			modelMap.set(key, { model, role, calls: 1, tokens, costUsd });
		}
	};

	const windows: MutableTaskWindow[] = [];
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
	const openGoalWindow = (goalId: string, title: string, startMs: number): MutableTaskWindow => {
		if (currentWindow?.goalId === goalId) return currentWindow;
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
		const predecessor = entry.parentId ? previousGoalEntries.get(entry.parentId) : undefined;
		previousGoalEntries.set(entry.id, predecessor);
		if (entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE) {
			latestGoalEntry = entry;
			previousGoalEntries.set(entry.id, latestGoalEntry);
			const state = getLatestGoalStateSnapshot(goalSource);
			const window = state
				? (windows.find((candidate) => candidate.goalId === state.goalId) ??
					openGoalWindow(state.goalId, state.userGoal, Date.parse(state.createdAt) || entryMs))
				: undefined;
			if (state && window) {
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
			} else if (currentWindow) {
				currentWindow.lastActivityMs = entryMs;
				if (entryMs > currentWindow.endMs) currentWindow.endMs = entryMs;
			}
			continue;
		}

		if (entry.type === "custom" && entry.customType === SPAWNED_USAGE_CUSTOM_TYPE) {
			const report = entry.data as SpawnedUsageReport | undefined;
			const resolved = resolveEffectiveEntryCost(report?.usage, {
				model: report?.model,
				provider: report?.provider,
				kind: "spawned",
			});
			if (!resolved || !report) continue;
			if (report.reportId) {
				if (seenSpawned.has(report.reportId)) continue;
				seenSpawned.add(report.reportId);
			}
			const tok = report.usage.input + report.usage.output + report.usage.cacheRead + report.usage.cacheWrite;
			const owner = report.goalId ? windows.find((window) => window.goalId === report.goalId) : undefined;
			if (owner) {
				owner.tokens += tok;
				owner.subagentCostUsd += resolved.total;
			} else unassignedCostUsd += resolved.total;
			recordModelUsage(
				report.model
					? `${report.provider ?? "unknown"}/${report.model} subtree`
					: (report.label ?? "subagent subtree"),
				"subagent",
				tok,
				resolved.total,
			);
			continue;
		}

		const semantic = resolveSemanticUsageEntry(entry);
		if (semantic) {
			const { report, cost: resolved } = semantic;
			if (seenSemantic.has(report.reportId)) continue;
			seenSemantic.add(report.reportId);
			const tok = report.usage.input + report.usage.output + report.usage.cacheRead + report.usage.cacheWrite;
			const role = report.route === "history_summary" ? "icm" : "system_one";
			recordModelUsage(`${report.provider}/${report.model || role}`, role, tok, resolved.total);
			unassignedCostUsd += resolved.total;
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
		}

		const assistant = entry.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
		if (assistant) {
			totalRounds += 1;
			currentWindow.rounds += 1;
			advanceWindowClock(currentWindow, entryMs);
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			totalToolCalls += 1;
			currentWindow.toolCalls += 1;
			advanceWindowClock(currentWindow, entryMs);
		}
		const usage = getSessionEntryUsage(entry);
		if (!usage) continue;
		const cost = resolveEffectiveEntryCost(usage, {
			model: assistant?.model,
			provider: assistant?.provider,
			kind: "own",
		});
		if (!cost) continue;
		const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		currentWindow.tokens += tokens;
		currentWindow.rootCostUsd += cost.total;
		const model = assistant
			? `${assistant.provider}/${assistant.model}`
			: entry.type === "message"
				? "tool usage (model unreported)"
				: "compaction / branch summary";
		recordModelUsage(model, "root", tokens, cost.total);
	}

	const goal = options.goalState;
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
	}

	const plan = options.taskState;
	const planTotal = plan ? plan.steps.length + plan.archive.completed + plan.archive.cancelled : 0;
	const planDone = plan ? plan.archive.completed + plan.steps.filter((s) => s.status === "completed").length : 0;

	const tasks: TaskExecutionMetrics[] = windows.map((win, idx) => {
		const isLast = idx === windows.length - 1;
		const isGoalMatch = goal !== undefined && win.goalId === goal.goalId;
		const recordedGoal = win.goalState;
		const isRunningNow =
			!win.goalWindowClosed &&
			isLast &&
			(options.isStreaming === true || (isGoalMatch && isGoalExecutionActive(goal.status)));
		const wallMs = Math.max(0, (isRunningNow ? Math.max(win.endMs, nowMs) : win.endMs) - win.startMs);
		const measuredActive = recordedGoal?.continuationWallClockMs;
		const activeMs = Math.min(wallMs, measuredActive ?? win.activeMs);
		const status = win.goalWindowClosed
			? win.status
			: recordedGoal
				? mapGoalStatus(recordedGoal.status)
				: isRunningNow
					? "active"
					: win.kind === "goal"
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
			id: win.id,
			kind: win.kind,
			title: win.title,
			status,
			timingEstimated: measuredActive === undefined,
			activeMs,
			wallMs: Math.max(activeMs, wallMs),
			rounds: win.rounds,
			toolCalls: win.toolCalls,
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
	const currentTask = tasks.at(-1);
	return {
		...(currentTask ? { currentTask } : {}),
		tasks,
		models,
		systemOneCostUsd,
		systemOneReports,
		totalRounds,
		totalToolCalls,
		unassignedCostUsd,
	};
}
