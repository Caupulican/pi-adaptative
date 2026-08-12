import type { Component } from "@caupulican/pi-tui";
import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { LaneRecord } from "../../../core/autonomy/lane-tracker.ts";
import { type GoalState, isGoalUnfinishedStatus } from "../../../core/goals/goal-state.ts";
import type { TaskStep, TaskStepsState } from "../../../core/tasks/task-state.ts";
import type { Theme, ThemeColor } from "../theme/theme.ts";

export type ActivityLaneKind = "runtime" | "tool" | "task" | "worker" | "goal" | "queue" | "notice";
export type ActivityLaneStatus = "active" | "waiting" | "success" | "warning" | "failure" | "neutral";

export interface ActivityLaneItem {
	id: string;
	kind: ActivityLaneKind;
	label: string;
	status: ActivityLaneStatus;
	/** Short aggregation key (e.g. "bash", "python", "agent") for the concurrency slot. */
	tag?: string;
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

export const BACKGROUND_TOOL_ACTIVITY_ID_PREFIX = "background-tool:";

export function backgroundToolActivityId(taskId: string): string {
	return `${BACKGROUND_TOOL_ACTIVITY_ID_PREFIX}${taskId}`;
}

export function isBackgroundToolActivityItem(item: Pick<ActivityLaneItem, "id" | "kind">): boolean {
	return item.kind === "tool" && item.id.startsWith(BACKGROUND_TOOL_ACTIVITY_ID_PREFIX);
}

const STATUS_COLORS: Record<ActivityLaneStatus, ThemeColor> = {
	active: "muted",
	waiting: "warning",
	success: "success",
	warning: "warning",
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
				tag: record.type === "tmux-worker" ? "tmux" : "agent",
			}),
		);
	const terminal = workers
		.filter(
			(record) =>
				record.status === "succeeded" ||
				record.status === "partial" ||
				record.status === "blocked" ||
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
				status:
					record.status === "succeeded"
						? "success"
						: record.status === "partial" || record.status === "blocked"
							? "warning"
							: record.status === "canceled"
								? "neutral"
								: "failure",
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

/**
 * Slot layout. One row, fixed slot order and anchors, left to right by stability:
 *
 *   ● working  Step 2/5 · Confirming duplicate-charge risk      2 bash  Queued 1  ● Read finished
 *   turn       plan (only elastic slot)                         concurrency/queue  last event
 *
 * Only the plan slot truncates. When width runs out, whole slots drop right-to-left
 * (event, then concurrency) so surviving slots never shift position mid-turn.
 * Color carries status only; labels stay in the text/muted hierarchy.
 */
const TURN_TEXT_MAX = 32;
const EVENT_TEXT_MAX = 36;
const QUEUE_TEXT_MAX = 32;
const AGGREGATE_GROUP_MAX = 3;
const PLAN_TEXT_MIN = 24;
const SLOT_GAP_WIDTH = 2;

function isTerminalStatus(status: ActivityLaneStatus): boolean {
	return status === "success" || status === "warning" || status === "failure" || status === "neutral";
}

interface AggregateGroup {
	tag: string;
	count: number;
	waiting: boolean;
}

interface LaneSlots {
	turn: ActivityLaneItem | undefined;
	plan: ActivityLaneItem | undefined;
	groups: AggregateGroup[];
	queue: ActivityLaneItem | undefined;
	event: ActivityLaneItem | undefined;
}

function normalizeActivityTag(tag: string | undefined, fallback: "tool" | "worker"): string {
	const normalized = (tag ?? fallback)
		.replace(/[_\s-]+/g, " ")
		.trim()
		.toLowerCase();
	return normalized || fallback;
}

function classifySlots(items: readonly ActivityLaneItem[]): LaneSlots {
	let turn: ActivityLaneItem | undefined;
	let plan: ActivityLaneItem | undefined;
	let goal: ActivityLaneItem | undefined;
	let queue: ActivityLaneItem | undefined;
	let event: ActivityLaneItem | undefined;
	const groups = new Map<string, AggregateGroup>();

	for (const item of items) {
		if (isTerminalStatus(item.status)) {
			event = item; // last one wins: transients are ordered oldest-first
			continue;
		}
		switch (item.kind) {
			case "runtime":
				// Waiting states (retry countdowns) outrank plain working states.
				if (!turn || (item.status === "waiting" && turn.status !== "waiting")) turn = item;
				break;
			case "task":
				plan ??= item;
				break;
			case "goal":
				goal ??= item;
				break;
			case "queue":
				queue ??= item;
				break;
			case "tool":
			case "worker": {
				const tag = normalizeActivityTag(item.tag, item.kind);
				const group = groups.get(tag) ?? { tag, count: 0, waiting: false };
				group.count += 1;
				if (item.status === "waiting") group.waiting = true;
				groups.set(tag, group);
				break;
			}
			case "notice":
				break;
		}
	}

	return { turn, plan: plan ?? goal, groups: [...groups.values()], queue, event };
}

function renderConcurrency(theme: Theme, groups: readonly AggregateGroup[]): string {
	const parts: string[] = [];
	const shown = groups.slice(0, AGGREGATE_GROUP_MAX);
	for (const group of shown) {
		parts.push(theme.fg(group.waiting ? "warning" : "muted", `${group.count} ${group.tag}`));
	}
	const overflow = groups.length - shown.length;
	if (overflow > 0) parts.push(theme.fg("dim", `+${overflow}`));
	return parts.join(theme.fg("dim", " · "));
}

export function renderActivityLaneLine(theme: Theme, items: readonly ActivityLaneItem[], width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (items.length === 0 || safeWidth < 3) return [];
	const slots = classifySlots(items);
	if (!slots.turn && !slots.plan && slots.groups.length === 0 && !slots.queue && !slots.event) return [];

	const indent = " ";
	const gap = " ".repeat(SLOT_GAP_WIDTH);

	// Turn slot: alive-anchor glyph plus a short state. The generic working state keeps the
	// word "working"; load-bearing runtime labels (retry, compaction, routing) pass through.
	let turnPart = "";
	const planFromTurn = slots.turn?.id === "runtime:turn" ? slots.turn.label : undefined;
	if (slots.turn) {
		const text = slots.turn.id === "runtime:turn" ? "working" : slots.turn.label;
		const dotColor: ThemeColor = slots.turn.status === "waiting" ? "warning" : "accent";
		turnPart = `${theme.fg(dotColor, "●")} ${theme.fg("muted", truncateToWidth(text, TURN_TEXT_MAX, "…"))}`;
	}

	// Plan slot content: task step, else goal, else the live working message.
	const planItem = slots.plan;
	const planText = planItem?.label ?? planFromTurn ?? "";
	const planColor: ThemeColor = planItem ? (planItem.status === "waiting" ? "warning" : "text") : "muted";

	// Right-aligned slots at natural size. Events and concurrency drop before the plan
	// shrinks below its preferred width; the user-owned queue state remains visible.
	let concurrencyPart = renderConcurrency(theme, slots.groups);
	const queuePart = slots.queue ? theme.fg("warning", truncateToWidth(slots.queue.label, QUEUE_TEXT_MAX, "…")) : "";
	let eventPart = slots.event
		? `${theme.fg(STATUS_COLORS[slots.event.status], "●")} ${theme.fg(
				"muted",
				truncateToWidth(slots.event.label, EVENT_TEXT_MAX, "…"),
			)}`
		: "";

	const leftBase = visibleWidth(indent) + (turnPart ? visibleWidth(turnPart) : 0);
	const planGap = turnPart && planText ? SLOT_GAP_WIDTH : 0;
	const rightPart = (): string => [concurrencyPart, queuePart, eventPart].filter(Boolean).join(gap);
	const planBudget = (): number => {
		let right = visibleWidth(rightPart());
		if (right > 0) right += SLOT_GAP_WIDTH; // breathing room before the right block
		return safeWidth - leftBase - planGap - right;
	};

	if (planText && planBudget() < PLAN_TEXT_MIN && eventPart) eventPart = "";
	if (planText && planBudget() < PLAN_TEXT_MIN && concurrencyPart) concurrencyPart = "";

	const planAvailable = Math.max(0, planBudget());
	const planPart = planText ? theme.fg(planColor, truncateToWidth(planText, planAvailable, "…")) : "";

	const renderedRightPart = rightPart();

	let line = indent + turnPart + (turnPart && planPart ? gap : "") + planPart;
	if (renderedRightPart) {
		const pad = Math.max(SLOT_GAP_WIDTH, safeWidth - visibleWidth(line) - visibleWidth(renderedRightPart));
		line += " ".repeat(pad) + renderedRightPart;
	}
	return [truncateToWidth(line, safeWidth, "")];
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
		// Slot classification decides visibility; the turn state always feeds the turn slot.
		return [...this.transient.values(), ...this.live.values(), ...this.canonical.values()];
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
