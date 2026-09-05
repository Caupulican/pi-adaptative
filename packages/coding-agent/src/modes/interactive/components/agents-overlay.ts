import { type Component, truncateToWidth } from "@caupulican/pi-tui";
import type { LaneRecord } from "../../../core/autonomy/lane-tracker.ts";
import type { GoalState } from "../../../core/goals/goal-state.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { TaskStepsState } from "../../../core/tasks/task-state.ts";
import {
	goalEvidencePanelRow,
	goalRequirementPanelRow,
	type OrchestrationPanelModel,
	type OrchestrationPanelRow,
	renderOrchestrationPanelLines,
	taskStepPanelRow,
} from "../../../core/tools/orchestration-panel.ts";
import { theme } from "../theme/theme.ts";
import { type ActivityLaneItem, isBackgroundToolActivityItem } from "./activity-lane.ts";
import { formatKeyText } from "./keybinding-hints.ts";

/**
 * On-demand work inspector behind the compact activity lane. One canonical snapshot
 * exposes goal, requirements, plan, workers, and background tools without duplicating
 * lifecycle state. The viewport is scrollable; the same key that opens it closes it.
 */

export interface AgentsOverlaySnapshot {
	goalState?: GoalState;
	taskState?: TaskStepsState;
	laneRecords: readonly LaneRecord[];
	items: readonly ActivityLaneItem[];
}

export interface AgentsOverlayOptions {
	keybindings: KeybindingsManager;
	snapshot: () => AgentsOverlaySnapshot;
	requestRender: () => void;
	onClose: () => void;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Terminal row budget used by the scrollable inspector. */
	viewportRows?: () => number;
}

const MAX_ROWS = 12;
const MAX_FINISHED_WORKERS = 4;
const ELAPSED_REDRAW_INTERVAL_MS = 1_000;

export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function workerElapsed(record: LaneRecord, nowMs: number): string {
	if (!record.startedAt) return "";
	const started = Date.parse(record.startedAt);
	if (Number.isNaN(started)) return "";
	const end = record.completedAt ? Date.parse(record.completedAt) : nowMs;
	if (Number.isNaN(end)) return "";
	return formatElapsed(end - started);
}

function workerRow(record: LaneRecord, nowMs: number): OrchestrationPanelRow {
	const meta = [
		record.type === "tmux-worker" ? "tmux" : "agent",
		record.profileId,
		record.modelRef,
		record.thinkingLevel,
		workerElapsed(record, nowMs),
		record.costUsd !== undefined ? `$${record.costUsd.toFixed(2)}` : undefined,
	].filter((value): value is string => value !== undefined && value !== "");
	const details = [
		`lane: ${record.laneId}`,
		record.goalId ? `goal: ${record.goalId}` : undefined,
		record.reasonCode ? `reason: ${record.reasonCode}` : undefined,
		record.worktreeLaneKey ? `worktree: ${record.worktreeLaneKey}` : undefined,
		record.evidenceEntryId ? `evidence: ${record.evidenceEntryId}` : undefined,
		record.startedAt ? `started: ${record.startedAt}` : undefined,
		record.completedAt ? `completed: ${record.completedAt}` : undefined,
	].filter((value): value is string => value !== undefined);
	return {
		status: record.status,
		label: record.label ?? record.laneId,
		section: "Workers",
		meta,
		details,
	};
}

function backgroundToolRow(item: ActivityLaneItem): OrchestrationPanelRow {
	return {
		status: item.status === "waiting" ? "queued" : "running",
		label: item.label,
		section: "Background tools",
		meta: item.tag ? [item.tag] : [],
	};
}

const ACTIVE_WORKER_STATUSES = new Set<LaneRecord["status"]>(["queued", "running"]);
const ACTIVE_BACKGROUND_TOOL_STATUSES = new Set<ActivityLaneItem["status"]>(["active", "waiting"]);

interface WorkActivityProjection {
	workers: LaneRecord[];
	activeWorkers: LaneRecord[];
	rows: OrchestrationPanelRow[];
	summary: string[];
}

function projectWorkActivity(snapshot: AgentsOverlaySnapshot, nowMs: number): WorkActivityProjection {
	const workers = snapshot.laneRecords.filter((record) => record.type === "worker" || record.type === "tmux-worker");
	const activeWorkers = workers.filter((record) => ACTIVE_WORKER_STATUSES.has(record.status));
	const finishedWorkers = workers
		.filter((record) => !ACTIVE_WORKER_STATUSES.has(record.status))
		.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
		.slice(0, MAX_FINISHED_WORKERS);
	const backgroundTools = snapshot.items.filter(
		(item) => isBackgroundToolActivityItem(item) && ACTIVE_BACKGROUND_TOOL_STATUSES.has(item.status),
	);
	const running = activeWorkers.filter((record) => record.status === "running").length;
	const queued = activeWorkers.length - running;
	return {
		workers,
		activeWorkers,
		rows: [
			...activeWorkers.map((record) => workerRow(record, nowMs)),
			...finishedWorkers.map((record) => workerRow(record, nowMs)),
			...backgroundTools.map(backgroundToolRow),
		],
		summary: [
			running > 0 ? `${running} running` : undefined,
			queued > 0 ? `${queued} queued` : undefined,
			backgroundTools.length > 0
				? `${backgroundTools.length} background tool${backgroundTools.length === 1 ? "" : "s"}`
				: undefined,
		].filter((value): value is string => value !== undefined),
	};
}

export function buildAgentsPanelModel(snapshot: AgentsOverlaySnapshot, nowMs: number): OrchestrationPanelModel {
	const activity = projectWorkActivity(snapshot, nowMs);
	const shown = activity.rows.slice(0, MAX_ROWS);
	return {
		label: "Agents",
		status: activity.workers.some((record) => record.status === "failed") ? "error" : "info",
		summary: activity.summary,
		rows: shown,
		hiddenRowCount: activity.rows.length - shown.length,
		emptyText: "No agents or background work right now",
	};
}

/** Complete, bounded projection for the interactive work inspector. */
export function buildWorkPanelModel(snapshot: AgentsOverlaySnapshot, nowMs: number): OrchestrationPanelModel {
	const goal = snapshot.goalState;
	const task = snapshot.taskState;
	const activity = projectWorkActivity(snapshot, nowMs);
	const satisfied = goal?.requirements.filter((requirement) => requirement.status === "satisfied").length ?? 0;
	const rows: OrchestrationPanelRow[] = [
		...(goal?.requirements.map(goalRequirementPanelRow) ?? []),
		...(goal?.evidence.map(goalEvidencePanelRow) ?? []),
		...(task?.steps.map((step) => ({ ...taskStepPanelRow(step), section: "Plan" })) ?? []),
		...activity.rows,
	];
	const summary = [
		goal ? `goal ${goal.status.replace("_", " ")}` : undefined,
		goal ? `${satisfied}/${goal.requirements.length} requirements` : undefined,
		task ? `${task.steps.length + task.archive.completed + task.archive.cancelled} plan steps` : undefined,
		...activity.summary,
	].filter((value): value is string => value !== undefined);
	return {
		label: "Work",
		status:
			goal?.status === "blocked" ||
			goal?.status === "paused" ||
			activity.workers.some((record) => record.status === "failed")
				? "warning"
				: activity.activeWorkers.length > 0 || task?.steps.some((step) => step.status === "in_progress")
					? "running"
					: "info",
		summary,
		description: goal?.userGoal,
		wrapRows: true,
		rows,
		notices: goal?.blockedReason ? [{ status: "warning", text: goal.blockedReason }] : [],
		emptyText: "No goal, plan, agents, or background work right now",
	};
}

/** Content-sized preview of the same inspector model. Detail remains in the work inspector. */
export function compactWorkPanel(model: OrchestrationPanelModel, limit = 6): OrchestrationPanelModel {
	const rows = model.rows ?? [];
	const urgent = rows.filter((row) =>
		["blocked", "failed", "timeout", "budget_exhausted", "partial"].includes(row.status),
	);
	const active = rows.filter((row) => ["running", "in_progress", "queued"].includes(row.status));
	const pending = rows.filter((row) => row.status === "pending");
	const shown = [...urgent, ...active, ...pending].slice(0, limit);
	return {
		...model,
		label: "Work / Team",
		rows: shown.map((row) => ({ ...row, meta: undefined, details: undefined })),
		summary:
			shown.length === 0 && rows.length > 0 ? [...(model.summary ?? []), `${rows.length} finished`] : model.summary,
		description: undefined,
		wrapRows: false,
		emptyText: undefined,
		hiddenRowCount: shown.length ? rows.length - shown.length : 0,
	};
}

export class AgentsOverlay implements Component {
	private readonly options: AgentsOverlayOptions;
	private mounted = false;
	private elapsedRedrawEnabled = false;
	private elapsedRedrawTimer: ReturnType<typeof setTimeout> | undefined;
	private scrollTop = 0;
	private lastPageRows = 1;
	private lastMaxScroll = 0;

	constructor(options: AgentsOverlayOptions) {
		this.options = options;
	}

	mount(): void {
		if (this.mounted) return;
		this.mounted = true;
		this.scheduleElapsedRedraw();
	}

	private scheduleElapsedRedraw(): void {
		if (!this.mounted || !this.elapsedRedrawEnabled || this.elapsedRedrawTimer) return;
		this.elapsedRedrawTimer = setTimeout(() => {
			this.elapsedRedrawTimer = undefined;
			if (!this.mounted || !this.elapsedRedrawEnabled) return;
			this.options.requestRender();
			this.scheduleElapsedRedraw();
		}, ELAPSED_REDRAW_INTERVAL_MS);
		this.elapsedRedrawTimer.unref?.();
	}

	private setElapsedRedrawEnabled(enabled: boolean): void {
		this.elapsedRedrawEnabled = enabled;
		if (!enabled) {
			if (this.elapsedRedrawTimer) clearTimeout(this.elapsedRedrawTimer);
			this.elapsedRedrawTimer = undefined;
			return;
		}
		this.scheduleElapsedRedraw();
	}

	handleInput(data: string): void {
		if (
			this.options.keybindings.matches(data, "app.agents.close") ||
			this.options.keybindings.matches(data, "app.agents.open")
		) {
			this.dispose();
			this.options.onClose();
			return;
		}
		if (this.options.keybindings.matches(data, "app.transcript.top")) this.scrollTo(0);
		else if (this.options.keybindings.matches(data, "app.transcript.bottom")) this.scrollTo(this.lastMaxScroll);
		else if (this.options.keybindings.matches(data, "app.transcript.scrollUp")) this.scrollBy(-1);
		else if (this.options.keybindings.matches(data, "app.transcript.scrollDown")) this.scrollBy(1);
		else if (this.options.keybindings.matches(data, "app.transcript.pageUp")) this.scrollBy(-this.lastPageRows);
		else if (this.options.keybindings.matches(data, "app.transcript.pageDown")) this.scrollBy(this.lastPageRows);
	}

	render(width: number): string[] {
		const nowMs = this.options.now?.() ?? Date.now();
		const snapshot = this.options.snapshot();
		this.setElapsedRedrawEnabled(
			snapshot.laneRecords.some(
				(record) =>
					(record.type === "worker" || record.type === "tmux-worker") &&
					record.status === "running" &&
					record.startedAt !== undefined &&
					!Number.isNaN(Date.parse(record.startedAt)),
			),
		);
		const model = buildWorkPanelModel(snapshot, nowMs);
		const surface = (text: string) => theme.bg("customMessageBg", truncateToWidth(text, width, "", true));
		const key = (action: Parameters<KeybindingsManager["getKeys"]>[0]) =>
			formatKeyText(this.options.keybindings.getKeys(action).join("/"), { capitalize: true });
		const body = renderOrchestrationPanelLines(theme, model, Math.max(1, width - 2), true);
		const viewportRows = Math.max(6, this.options.viewportRows?.() ?? 24);
		const pageRows = Math.max(3, viewportRows - 2);
		this.lastPageRows = pageRows;
		this.lastMaxScroll = Math.max(0, body.length - pageRows);
		this.scrollTop = Math.min(this.scrollTop, this.lastMaxScroll);
		const visible = body.slice(this.scrollTop, this.scrollTop + pageRows);
		const position =
			this.lastMaxScroll > 0 ? ` · ${this.scrollTop + 1}-${this.scrollTop + visible.length}/${body.length}` : "";
		const footer = ` ${key("app.transcript.scrollUp")}/${key("app.transcript.scrollDown")} scroll · ${key("app.transcript.pageUp")}/${key("app.transcript.pageDown")} page · ${key("app.transcript.top")}/${key("app.transcript.bottom")} jump · ${key("app.agents.close")} close${position}`;
		return [surface(""), ...visible.map((line) => surface(` ${line}`)), surface(theme.fg("muted", footer))];
	}

	invalidate(): void {}

	private scrollBy(delta: number): void {
		this.scrollTo(this.scrollTop + delta);
	}

	private scrollTo(next: number): void {
		this.scrollTop = Math.max(0, Math.min(this.lastMaxScroll, next));
		this.options.requestRender();
	}

	dispose(): void {
		this.mounted = false;
		this.setElapsedRedrawEnabled(false);
	}
}
