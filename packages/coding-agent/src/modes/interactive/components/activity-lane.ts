import type { Component } from "@caupulican/pi-tui";
import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { LaneRecord } from "../../../core/autonomy/lane-tracker.ts";
import { type GoalState, isGoalUnfinishedStatus } from "../../../core/goals/goal-state.ts";
import type { TaskStep, TaskStepsState } from "../../../core/tasks/task-state.ts";
import type { Theme, ThemeColor } from "../theme/theme.ts";

export type ActivityLaneKind = "runtime" | "tool" | "task" | "worker" | "goal" | "queue" | "notice";
export type ActivityLaneStatus = "active" | "waiting" | "success" | "failure" | "neutral";

export interface ActivityLaneItem {
	id: string;
	kind: ActivityLaneKind;
	label: string;
	status: ActivityLaneStatus;
}

export interface ActivityLaneCanonicalSnapshot {
	goalState?: GoalState;
	taskState?: TaskStepsState;
	laneRecords: readonly LaneRecord[];
}

export interface ActivityLaneProjection {
	active: ActivityLaneItem[];
	terminal: ActivityLaneItem[];
}

const DEFAULT_TERMINAL_HOLD_MS = 2_000;
const MAX_ACTIVITY_LABEL_LENGTH = 240;
const MAX_SEEN_TERMINALS = 512;

const KIND_COLORS: Record<ActivityLaneKind, ThemeColor> = {
	runtime: "thinkingText",
	tool: "mdLink",
	task: "accent",
	worker: "customMessageLabel",
	goal: "mdHeading",
	queue: "muted",
	notice: "text",
};

const STATUS_COLORS: Record<ActivityLaneStatus, ThemeColor> = {
	active: "muted",
	waiting: "warning",
	success: "success",
	failure: "error",
	neutral: "muted",
};

function boundedLabel(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= MAX_ACTIVITY_LABEL_LENGTH
		? normalized
		: `${normalized.slice(0, MAX_ACTIVITY_LABEL_LENGTH - 1)}…`;
}

function taskLabel(step: TaskStep, state: TaskStepsState): string {
	const total = state.steps.length + state.archive.completed + state.archive.cancelled;
	const activeIndex = state.steps.findIndex((candidate) => candidate.id === step.id);
	const archived = state.archive.completed + state.archive.cancelled;
	const position = Math.min(total, archived + Math.max(0, activeIndex) + 1);
	const prefix = step.status === "blocked" ? "Blocked" : step.status === "pending" ? "Next" : "Step";
	const content = step.status === "in_progress" ? (step.activeForm ?? step.content) : step.content;
	return boundedLabel(`${prefix} ${position}/${total} · ${content}`);
}

function projectTaskState(state: TaskStepsState | undefined): ActivityLaneProjection {
	if (!state) return { active: [], terminal: [] };
	const inProgress = state.steps.find((step) => step.status === "in_progress");
	const blocked = state.steps.find((step) => step.status === "blocked");
	const pending = state.steps.find((step) => step.status === "pending");
	const current = inProgress ?? blocked ?? pending;
	const active = current
		? [
				{
					id: `task:${current.id}`,
					kind: "task" as const,
					label: taskLabel(current, state),
					status: current.status === "blocked" ? ("waiting" as const) : ("active" as const),
				},
			]
		: [];
	const terminal = state.steps
		.filter((step) => step.status === "completed" || step.status === "cancelled")
		.map(
			(step): ActivityLaneItem => ({
				id: `terminal:task:${step.id}:${step.status}:${step.updatedAt}`,
				kind: "task",
				label: boundedLabel(
					step.status === "completed" ? `Completed · ${step.content}` : `Cancelled · ${step.content}`,
				),
				status: step.status === "completed" ? "success" : "neutral",
			}),
		);
	return { active, terminal };
}

function projectGoalState(state: GoalState | undefined): ActivityLaneProjection {
	if (!state) return { active: [], terminal: [] };
	const satisfied = state.requirements.filter((requirement) => requirement.status === "satisfied").length;
	const progress = state.requirements.length > 0 ? ` ${satisfied}/${state.requirements.length}` : "";
	if (isGoalUnfinishedStatus(state.status)) {
		const stopped = state.status === "active" ? "" : ` ${state.status.replace("_", " ")}`;
		return {
			active: [
				{
					id: `goal:${state.goalId}`,
					kind: "goal",
					label: boundedLabel(`Goal${stopped}${progress} · ${state.userGoal}`),
					status: state.status === "active" ? "active" : "waiting",
				},
			],
			terminal: [],
		};
	}
	return {
		active: [],
		terminal: [
			{
				id: `terminal:goal:${state.goalId}:${state.status}:${state.updatedAt}`,
				kind: "goal",
				label: state.status === "completed" ? "Goal achieved" : "Goal closed",
				status: state.status === "completed" ? "success" : "neutral",
			},
		],
	};
}

function laneLabel(record: LaneRecord): string {
	const runtime = record.type === "tmux-worker" ? "tmux" : "agent";
	const label = record.label ?? record.laneId;
	return boundedLabel(`${runtime} · ${label}`);
}

function projectLaneRecords(records: readonly LaneRecord[]): ActivityLaneProjection {
	const workers = records.filter((record) => record.type === "worker" || record.type === "tmux-worker");
	const active = workers
		.filter((record) => record.status === "queued" || record.status === "running")
		.map(
			(record): ActivityLaneItem => ({
				id: `worker:${record.laneId}`,
				kind: "worker",
				label: laneLabel(record),
				status: record.status === "queued" ? "waiting" : "active",
			}),
		);
	const terminal = workers
		.filter(
			(record) =>
				record.status === "succeeded" ||
				record.status === "failed" ||
				record.status === "timeout" ||
				record.status === "budget_exhausted" ||
				record.status === "canceled",
		)
		.map(
			(record): ActivityLaneItem => ({
				id: `terminal:worker:${record.laneId}:${record.status}:${record.completedAt ?? "unknown"}`,
				kind: "worker",
				label: boundedLabel(
					`${record.status === "succeeded" ? "Finished" : record.status} · ${record.label ?? record.laneId}`,
				),
				status: record.status === "succeeded" ? "success" : record.status === "canceled" ? "neutral" : "failure",
			}),
		);
	return { active, terminal };
}

export function projectActivityLane(snapshot: ActivityLaneCanonicalSnapshot): ActivityLaneProjection {
	const task = projectTaskState(snapshot.taskState);
	const lanes = projectLaneRecords(snapshot.laneRecords);
	const goal = projectGoalState(snapshot.goalState);
	return {
		active: [...task.active, ...lanes.active, ...goal.active],
		terminal: [...task.terminal, ...lanes.terminal, ...goal.terminal],
	};
}

function renderItem(theme: Theme, item: ActivityLaneItem, maxWidth: number): string {
	const dot = theme.fg(STATUS_COLORS[item.status], "●");
	const color =
		item.status === "success" || item.status === "failure" ? STATUS_COLORS[item.status] : KIND_COLORS[item.kind];
	const labelWidth = Math.max(1, maxWidth - 2);
	return `${dot} ${theme.fg(color, truncateToWidth(item.label, labelWidth, "…"))}`;
}

export function renderActivityLaneLine(theme: Theme, items: readonly ActivityLaneItem[], width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (items.length === 0 || safeWidth < 3) return [];
	const indent = " ";
	const separator = theme.fg("dim", "  ·  ");
	const hiddenLabel = (count: number) => theme.fg("dim", `+${count}`);
	const parts: string[] = [];
	let used = visibleWidth(indent);
	let hidden = 0;

	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const gap = parts.length === 0 ? "" : separator;
		const gapWidth = visibleWidth(gap);
		const remainingItems = items.length - index - 1;
		const reserve = remainingItems > 0 ? visibleWidth(separator) + visibleWidth(hiddenLabel(remainingItems)) : 0;
		const available = safeWidth - used - gapWidth - reserve;
		if (available < 5) {
			hidden = items.length - index;
			break;
		}
		const rendered = renderItem(theme, item, available);
		parts.push(`${gap}${rendered}`);
		used += gapWidth + visibleWidth(rendered);
		if (visibleWidth(rendered) < Math.min(available, visibleWidth(renderItem(theme, item, safeWidth)))) {
			hidden = remainingItems;
			break;
		}
	}

	if (hidden > 0) {
		const suffix = `${separator}${hiddenLabel(hidden)}`;
		if (used + visibleWidth(suffix) <= safeWidth) parts.push(suffix);
	}
	return [truncateToWidth(`${indent}${parts.join("")}`, safeWidth, "")];
}

export class ActivityLaneComponent implements Component {
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly terminalHoldMs: number;
	private sessionKey: string | undefined;
	private readonly canonical = new Map<string, ActivityLaneItem>();
	private readonly live = new Map<string, ActivityLaneItem>();
	private readonly transient = new Map<string, ActivityLaneItem>();
	private readonly transientTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly seenTerminalKeys = new Set<string>();
	private transientSequence = 0;

	constructor(theme: Theme, requestRender: () => void, terminalHoldMs = DEFAULT_TERMINAL_HOLD_MS) {
		this.theme = theme;
		this.requestRender = requestRender;
		this.terminalHoldMs = terminalHoldMs;
	}

	private rememberTerminal(key: string): void {
		this.seenTerminalKeys.add(key);
		while (this.seenTerminalKeys.size > MAX_SEEN_TERMINALS) {
			const oldest = this.seenTerminalKeys.values().next().value;
			if (oldest === undefined) break;
			this.seenTerminalKeys.delete(oldest);
		}
	}

	private addTransient(item: ActivityLaneItem): void {
		const id = `${item.id}:${++this.transientSequence}`;
		this.transient.set(id, { ...item, id });
		const timer = setTimeout(() => {
			this.transient.delete(id);
			this.transientTimers.delete(id);
			this.requestRender();
		}, this.terminalHoldMs);
		this.transientTimers.set(id, timer);
	}

	private applyProjection(projection: ActivityLaneProjection, showNewTerminals: boolean): void {
		this.canonical.clear();
		for (const item of projection.active) this.canonical.set(item.id, item);
		for (const item of projection.terminal.slice(-MAX_SEEN_TERMINALS)) {
			if (showNewTerminals && !this.seenTerminalKeys.has(item.id)) this.addTransient(item);
			this.rememberTerminal(item.id);
		}
		this.requestRender();
	}

	replaceCanonical(sessionKey: string, snapshot: ActivityLaneCanonicalSnapshot): void {
		if (this.sessionKey !== sessionKey) {
			this.clearTransient();
			this.live.clear();
			this.seenTerminalKeys.clear();
			this.sessionKey = sessionKey;
		}
		this.applyProjection(projectActivityLane(snapshot), false);
	}

	updateCanonical(sessionKey: string, snapshot: ActivityLaneCanonicalSnapshot): void {
		if (this.sessionKey !== sessionKey) {
			this.replaceCanonical(sessionKey, snapshot);
			return;
		}
		this.applyProjection(projectActivityLane(snapshot), true);
	}

	start(item: Omit<ActivityLaneItem, "status">): void {
		this.live.set(item.id, { ...item, label: boundedLabel(item.label), status: "active" });
		this.requestRender();
	}

	wait(item: Omit<ActivityLaneItem, "status">): void {
		this.live.set(item.id, { ...item, label: boundedLabel(item.label), status: "waiting" });
		this.requestRender();
	}

	update(id: string, label: string): void {
		const current = this.live.get(id);
		if (!current) return;
		this.live.set(id, { ...current, label: boundedLabel(label) });
		this.requestRender();
	}

	remove(id: string): void {
		if (this.live.delete(id)) this.requestRender();
	}

	removeByPrefix(prefix: string): void {
		let removed = false;
		for (const id of this.live.keys()) {
			if (!id.startsWith(prefix)) continue;
			this.live.delete(id);
			removed = true;
		}
		if (removed) this.requestRender();
	}

	finish(id: string, status: "success" | "failure" | "neutral", fallback?: Omit<ActivityLaneItem, "status">): void {
		const current = this.live.get(id) ?? fallback;
		this.live.delete(id);
		if (current) this.addTransient({ ...current, label: boundedLabel(current.label), status });
		this.requestRender();
	}

	announce(label: string, status: "success" | "failure" | "neutral" = "success"): void {
		this.addTransient({ id: "notice", kind: "notice", label: boundedLabel(label), status });
		this.requestRender();
	}

	private clearTransient(): void {
		for (const timer of this.transientTimers.values()) clearTimeout(timer);
		this.transientTimers.clear();
		this.transient.clear();
	}

	getItems(): ActivityLaneItem[] {
		const transient = [...this.transient.values()];
		const live = [...this.live.values()];
		const hasSpecificLiveWork = live.some((item) => item.kind === "tool");
		const visibleLive = hasSpecificLiveWork
			? live.filter((item) => !(item.kind === "runtime" && item.id === "runtime:turn"))
			: live;
		return [...transient, ...visibleLive, ...this.canonical.values()];
	}

	render(width: number): string[] {
		return renderActivityLaneLine(this.theme, this.getItems(), width);
	}

	invalidate(): void {}

	dispose(): void {
		this.clearTransient();
		this.live.clear();
		this.canonical.clear();
		this.seenTerminalKeys.clear();
	}
}
