import type { Component } from "@caupulican/pi-tui";
import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { LaneRecord } from "../../../core/autonomy/lane-tracker.ts";
import { type GoalState, isGoalExecutionActive, isGoalUnfinishedStatus } from "../../../core/goals/goal-state.ts";
import type { TaskStep, TaskStepsState } from "../../../core/tasks/task-state.ts";
import type { Theme, ThemeColor } from "../theme/theme.ts";

export type ActivityLaneKind = "runtime" | "tool" | "task" | "worker" | "goal" | "queue" | "notice";
export type ActivityLaneStatus = "active" | "waiting" | "success" | "warning" | "failure" | "neutral";

function isActivityRunning(status: ActivityLaneStatus): boolean {
	return status === "active";
}

export interface ActivityLaneItem {
	id: string;
	kind: ActivityLaneKind;
	label: string;
	status: ActivityLaneStatus;
	/** Short aggregation key (e.g. "bash", "python", "agent") for the concurrency slot. */
	tag?: string;
	toolCallId?: string;
	phase?: "input";
	scope?: "foreground" | "background" | "worker";
	/** Epoch ms when the work began; the live row shows the elapsed time next to its subject. */
	startedAt?: number;
	/**
	 * Epoch ms when this turn's first provider token arrived (`ActivityLaneController.markFirstToken`).
	 * Belongs to the turn that owns `startedAt`: a fresh clock always begins unmarked.
	 */
	firstTokenAt?: number;
	/** Frozen display-clock end, independent of terminal retention. */
	completedAt?: number;
	/** Producer wall-clock origin, converted once into `startedAt`. */
	originAt?: string;
	/** Validated milliseconds to subtract from `originAt` (background handoff). */
	elapsedBeforeMs?: number;
	/** `observed` means first-seen, not a trustworthy producer start. */
	clockKind?: "known" | "observed";
	timingRole?: "oldest";
}

export interface ActivityLaneCanonicalSnapshot {
	goalState?: GoalState;
	taskState?: TaskStepsState;
	laneRecords: readonly LaneRecord[];
}

/** Input and external admission waits have independent owners, even when the parent is hidden or settled. */
function isParentRuntimeItem(item: ActivityLaneItem): boolean {
	return item.kind === "runtime" && item.phase !== "input" && item.scope !== "background" && item.scope !== "worker";
}

export interface ActivityLaneProjection {
	active: ActivityLaneItem[];
	terminal: ActivityLaneItem[];
}

const DEFAULT_TERMINAL_HOLD_MS = 2_000;
const ELAPSED_TICK_MS = 1_000;
/**
 * Below this, the wait for the first token is not news and the row stays exactly as it was: one
 * elapsed figure. Above it the operator can no longer tell "the provider has not answered" from
 * "it is writing", which is the whole reason the mark exists (measured: p50 11.5 s to first token
 * on a slow-first-token provider, ~40 % of the turn's active time).
 */
const FIRST_TOKEN_NOTICE_MS = 3_000;

/** `12s`, `1m12s`, `1h02m`: the coarsest unit the operator needs to judge "is it stuck". */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}
const MAX_ACTIVITY_LABEL_LENGTH = 240;
const MAX_SEEN_TERMINALS = 512;
const MAX_TRANSIENT_ITEMS = 32;

export const BACKGROUND_TOOL_ACTIVITY_ID_PREFIX = "background-tool:";

/** The one live item that brackets a whole assistant turn, and so the only one that awaits a first token. */
export const RUNTIME_TURN_ACTIVITY_ID = "runtime:turn";

export function isTurnActivityItem(item: Pick<ActivityLaneItem, "id" | "kind">): boolean {
	return item.kind === "runtime" && item.id === RUNTIME_TURN_ACTIVITY_ID;
}

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
	if (isGoalUnfinishedStatus(state.status)) {
		const goalActive = isGoalExecutionActive(state.status);
		return {
			active: [
				{
					id: `goal:${state.goalId}`,
					kind: "goal",
					label: goalActive ? "active" : state.status.replaceAll("_", " "),
					status: goalActive ? "active" : "waiting",
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
				tag:
					record.type === "tmux-worker"
						? record.status === "queued"
							? "tmux agent queued"
							: "tmux agent running"
						: record.status === "queued"
							? "agent queued"
							: "agent running",
				...(record.startedAt ? { originAt: record.startedAt } : {}),
			}),
		);
	// Terminal workers are projected only after the foreground delivery owner resolves the
	// observation receipt. This prevents already-read events from flashing in the TUI.
	return { active, terminal: [] };
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
/** The subject keeps at least this much of the slot when the timing suffix is long. */
const TURN_TEXT_MIN_LABEL = 8;
const EVENT_TEXT_MAX = 36;
/** The queue label carries its delivery boundary and the send-now key; it is the operator's own state and must read whole. */
const QUEUE_TEXT_MAX = 80;
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
	overlay: ActivityLaneItem | undefined;
	externalWait: ActivityLaneItem | undefined;
	/** The one live tool or worker when exactly one runs: it becomes the subject of the turn slot. */
	soloTool: ActivityLaneItem | undefined;
	running: ActivityLaneItem[];
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
	let overlay: ActivityLaneItem | undefined;
	let externalWait: ActivityLaneItem | undefined;
	let plan: ActivityLaneItem | undefined;
	let goal: ActivityLaneItem | undefined;
	let queue: ActivityLaneItem | undefined;
	let event: ActivityLaneItem | undefined;
	const groups = new Map<string, AggregateGroup>();
	const running: ActivityLaneItem[] = [];
	const inputCalls = new Set(items.filter((item) => item.phase === "input").map((item) => `tool:${item.toolCallId}`));

	for (const item of items) {
		if (isTerminalStatus(item.status)) {
			event = item; // last one wins: transients are ordered oldest-first
			continue;
		}
		switch (item.kind) {
			case "runtime":
				if (isTurnActivityItem(item)) turn = item;
				else if (item.scope === "background" || item.scope === "worker") externalWait ??= item;
				else if (item.phase === "input" || !overlay || (item.status === "waiting" && overlay.phase !== "input"))
					overlay = item;
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
				const waiting = item.status === "waiting" || inputCalls.has(item.id);
				running.push(waiting ? { ...item, status: "waiting" } : item);
				const tag = normalizeActivityTag(item.tag, item.kind);
				const group = groups.get(tag) ?? { tag, count: 0, waiting: false };
				group.count += 1;
				if (waiting) group.waiting = true;
				groups.set(tag, group);
				break;
			}
			case "notice":
				break;
		}
	}

	return {
		turn,
		overlay,
		externalWait,
		soloTool: running.length === 1 ? running[0] : undefined,
		running,
		plan: plan ?? goal,
		groups: [...groups.values()],
		queue,
		event,
	};
}

function oldestTimedItem(items: readonly ActivityLaneItem[]): ActivityLaneItem | undefined {
	const active = items.filter((item) => isActivityRunning(item.status));
	const candidates = active.length ? active : items;
	const known = candidates.filter((item) => item.startedAt !== undefined && item.clockKind !== "observed");
	const timed = known.length ? known : candidates.filter((item) => item.startedAt !== undefined);
	if (timed.length === 0) {
		const first = items[0];
		return first ? { ...first, clockKind: first.clockKind ?? "observed" } : undefined;
	}
	const oldest = timed.reduce((current, item) =>
		(item.startedAt ?? Number.POSITIVE_INFINITY) < (current.startedAt ?? Number.POSITIVE_INFINITY) ? item : current,
	);
	return {
		...oldest,
		timingRole:
			oldest.clockKind === "observed" || (oldest.kind === "tool" && !isBackgroundToolActivityItem(oldest))
				? undefined
				: "oldest",
	};
}

function resolveDisplayClock(
	item: Omit<ActivityLaneItem, "status">,
	now: number,
	previous: ActivityLaneItem | undefined,
	observedIfMissing: boolean,
	wallNow = now,
): Pick<ActivityLaneItem, "startedAt" | "clockKind"> {
	if (
		previous?.startedAt !== undefined &&
		item.originAt === previous.originAt &&
		item.elapsedBeforeMs === previous.elapsedBeforeMs &&
		item.startedAt === undefined
	) {
		return { startedAt: previous.startedAt, clockKind: previous.clockKind };
	}
	const extra = item.elapsedBeforeMs;
	if (extra !== undefined && (!Number.isFinite(extra) || extra < 0)) {
		return { startedAt: previous?.startedAt ?? now, clockKind: "observed" };
	}
	if (item.originAt) {
		const parsed = Date.parse(item.originAt);
		if (!Number.isFinite(parsed)) return { startedAt: previous?.startedAt ?? now, clockKind: "observed" };
		if (parsed > wallNow) return { startedAt: previous?.startedAt ?? now, clockKind: "observed" };
		const origin = now - (wallNow - parsed + (extra ?? 0));
		const startedAt = previous?.startedAt !== undefined ? Math.min(previous.startedAt, origin) : origin;
		return { startedAt, clockKind: "known" };
	}
	if (item.startedAt !== undefined) {
		if (!Number.isFinite(item.startedAt) || item.startedAt < 0 || item.startedAt > now) {
			return { startedAt: previous?.startedAt ?? now, clockKind: "observed" };
		}
		const startedAt =
			previous?.startedAt !== undefined ? Math.min(previous.startedAt, item.startedAt) : item.startedAt;
		return { startedAt, clockKind: item.clockKind ?? previous?.clockKind ?? "known" };
	}
	if (previous?.startedAt !== undefined) {
		return { startedAt: previous.startedAt, clockKind: previous.clockKind };
	}
	if (item.kind === "runtime" || item.kind === "tool" || item.kind === "worker") {
		return { startedAt: now, clockKind: observedIfMissing ? "observed" : "known" };
	}
	return {};
}

function sameActivityItem(a: ActivityLaneItem | undefined, b: ActivityLaneItem): boolean {
	return (
		a !== undefined &&
		a.id === b.id &&
		a.kind === b.kind &&
		a.label === b.label &&
		a.status === b.status &&
		a.tag === b.tag &&
		a.toolCallId === b.toolCallId &&
		a.phase === b.phase &&
		a.scope === b.scope &&
		a.startedAt === b.startedAt &&
		a.firstTokenAt === b.firstTokenAt &&
		a.completedAt === b.completedAt &&
		a.originAt === b.originAt &&
		a.elapsedBeforeMs === b.elapsedBeforeMs &&
		a.clockKind === b.clockKind &&
		a.timingRole === b.timingRole
	);
}

function renderConcurrency(theme: Theme, groups: readonly AggregateGroup[]): string {
	const parts: string[] = [];
	const shown = groups.slice(0, AGGREGATE_GROUP_MAX);
	for (const group of shown) {
		const tag = group.count === 1 ? group.tag : group.tag.replace(/\bagent\b/, "agents");
		parts.push(theme.fg(group.waiting ? "warning" : "muted", `${group.count} ${tag}`));
	}
	const overflow = groups.length - shown.length;
	if (overflow > 0) parts.push(theme.fg("dim", `+${overflow}`));
	return parts.join(theme.fg("dim", " · "));
}

export function renderActivityLaneLine(
	theme: Theme,
	items: readonly ActivityLaneItem[],
	width: number,
	now?: number,
): string[] {
	const safeWidth = Math.max(1, width);
	if (items.length === 0 || safeWidth < 3) return [];
	const slots = classifySlots(items);
	if (!slots.turn && !slots.overlay) slots.overlay = slots.externalWait;
	if (!slots.turn && !slots.overlay && !slots.plan && slots.groups.length === 0 && !slots.queue && !slots.event)
		return [];

	const indent = " ";
	const gap = " ".repeat(SLOT_GAP_WIDTH);
	// One parenthetical carries every timing fact about the subject, in one unit vocabulary, with no
	// glyph of its own: the row's only glyph is the status dot. The first-token half appears only
	// once the wait is long enough to mean something (FIRST_TOKEN_NOTICE_MS), so a fast provider
	// renders exactly what it always did.
	const elapsed = (item: ActivityLaneItem | undefined): string => {
		if (item?.startedAt === undefined || now === undefined) return "";
		const total = formatElapsed((item.completedAt ?? now) - item.startedAt);
		const kind = item.clockKind === "observed" ? "observed " : item.timingRole === "oldest" ? "oldest " : "";
		if (!isTurnActivityItem(item) || slots.overlay) return ` (${kind}${total})`;
		const waitedMs = (item.firstTokenAt ?? now) - item.startedAt;
		if (waitedMs < FIRST_TOKEN_NOTICE_MS) return ` (${kind}${total})`;
		return item.firstTokenAt === undefined
			? ` (${kind}${total}, no token yet)`
			: ` (${kind}${total}, first ${formatElapsed(waitedMs)})`;
	};

	// Turn slot: alive-anchor glyph plus the subject of the work and how long it has run. The one
	// running tool is the subject when there is exactly one; otherwise the live runtime label is.
	// A generic Working... yields its words to concurrent work, but the turn clock stays.
	let turnPart = "";
	const backgroundSubject = !slots.turn && slots.running.length > 0 ? oldestTimedItem(slots.running) : undefined;
	const externalRunning = slots.running.some((item) => isActivityRunning(item.status));
	const wait = slots.overlay?.status === "waiting" ? slots.overlay : undefined;
	const subject = slots.turn ?? backgroundSubject ?? slots.overlay;
	if (subject) {
		const status = externalRunning ? "active" : (wait?.status ?? subject.status);
		const dotColor: ThemeColor = status === "waiting" ? "warning" : "accent";
		const withTiming = (label: string, item: ActivityLaneItem): string => {
			let suffix = elapsed(item);
			const available = Math.max(0, safeWidth - 3);
			if (
				visibleWidth(suffix) + TURN_TEXT_MIN_LABEL > available &&
				item.startedAt !== undefined &&
				now !== undefined
			) {
				const kind = item.clockKind === "observed" ? "observed " : "";
				suffix = ` (${kind}${formatElapsed((item.completedAt ?? now) - item.startedAt)})`;
			}
			if (!label) return suffix.trim();
			const labelWidth = Math.max(0, Math.min(TURN_TEXT_MAX, available) - visibleWidth(suffix));
			if (safeWidth < 24 && visibleWidth(label) > labelWidth) label = status === "waiting" ? "Waiting" : "Working";
			return `${truncateToWidth(label, labelWidth, "…")}${suffix}`;
		};
		let text = "";
		if (slots.turn) {
			text = withTiming(
				wait ? (externalRunning ? "Working" : wait.label) : (slots.overlay?.label ?? slots.turn.label),
				slots.turn,
			);
		} else if (slots.overlay && !externalRunning) {
			text = withTiming(slots.overlay.label, slots.overlay);
		} else if (backgroundSubject) {
			const label =
				backgroundSubject.status === "waiting"
					? "Agents queued"
					: slots.running.length === 1 &&
							backgroundSubject.kind === "tool" &&
							!isBackgroundToolActivityItem(backgroundSubject)
						? backgroundSubject.label
						: "Background work";
			text = withTiming(label, backgroundSubject);
		} else if (slots.overlay) {
			text = withTiming(slots.overlay.label, slots.overlay);
		}
		turnPart = text ? `${theme.fg(dotColor, "●")} ${theme.fg("muted", text)}` : `${theme.fg(dotColor, "●")}`;
	} else if (slots.plan) {
		turnPart = theme.fg("muted", "Paused");
	}

	// Plan slot: task/goal only. Do not copy the turn label into the plan slot.
	const planItem = slots.plan;
	const planText = planItem?.label ?? "";
	const planColor: ThemeColor = planItem
		? planItem.kind === "goal"
			? "accent"
			: planItem.status === "waiting"
				? "warning"
				: "text"
		: "muted";

	// Right-aligned slots at natural size. Events and concurrency drop before the plan
	// shrinks below its preferred width; the user-owned queue state remains visible.
	// The solo tool already names itself in the turn slot; a "1 bash" count would repeat it.
	let concurrencyPart =
		!slots.turn && slots.soloTool?.kind === "tool" && !isBackgroundToolActivityItem(slots.soloTool)
			? ""
			: renderConcurrency(theme, slots.groups);
	const secondary =
		slots.queue?.label ??
		(externalRunning && wait
			? `${isParentRuntimeItem(wait) ? "Parent " : ""}${wait.label}`
			: slots.externalWait !== slots.overlay
				? slots.externalWait?.label
				: undefined);
	const queuePart = secondary ? theme.fg("warning", truncateToWidth(secondary, QUEUE_TEXT_MAX, "…")) : "";
	let eventPart =
		slots.event &&
		!(
			slots.event.kind === "runtime" &&
			(slots.running.length > 0 || slots.turn || slots.overlay || slots.externalWait)
		)
			? `${theme.fg(STATUS_COLORS[slots.event.status], "●")} ${theme.fg(
					"muted",
					truncateToWidth(slots.event.label + elapsed(slots.event), EVENT_TEXT_MAX, "…"),
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

	const preferredPlanWidth = Math.max(PLAN_TEXT_MIN, Math.min(visibleWidth(planText), TURN_TEXT_MAX));
	if (planText && planBudget() < preferredPlanWidth && eventPart) eventPart = "";
	if (planText && planBudget() < preferredPlanWidth && concurrencyPart) concurrencyPart = "";

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
	private readonly now: () => number;
	private readonly wallNow: () => number;
	private foregroundEpoch?: number;
	private foregroundOutcome?: { status: "success" | "failure" | "neutral"; label: string };
	private parentVisible = true;
	/** Runs only while timed work is live, so the elapsed figure advances; never keeps the process alive. */
	private ticker?: ReturnType<typeof setInterval>;
	/** Clocks on screen the lane does not own (the Decision graph's stage and System One evaluation). */
	private readonly externalClocks = new Set<string>();

	constructor(
		theme: Theme,
		requestRender: () => void,
		terminalHoldMs = DEFAULT_TERMINAL_HOLD_MS,
		wallNow: () => number = Date.now,
		monotonicNow: () => number = wallNow === Date.now ? () => performance.now() : wallNow,
	) {
		this.theme = theme;
		this.requestRender = requestRender;
		this.terminalHoldMs = terminalHoldMs;
		this.wallNow = wallNow;
		const wallAnchor = wallNow();
		const monotonicAnchor = monotonicNow();
		this.now = () => wallAnchor + Math.max(0, monotonicNow() - monotonicAnchor);
	}

	/**
	 * Registers or clears a named clock that lives outside the lane; the one existing ticker covers
	 * it too. Never a second interval, never a row.
	 */
	setExternalClock(id: string, running: boolean): void {
		if (running === this.externalClocks.has(id)) return;
		if (running) this.externalClocks.add(id);
		else this.externalClocks.delete(id);
		this.syncTicker();
	}

	private syncTicker(): void {
		const timed =
			this.externalClocks.size > 0 ||
			[...this.live.values(), ...this.canonical.values()]
				.filter((item) => this.parentVisible || !isParentRuntimeItem(item))
				.some(
					(item) => item.startedAt !== undefined && (isActivityRunning(item.status) || item.status === "waiting"),
				);
		if (timed && !this.ticker) {
			this.ticker = setInterval(() => this.requestRender(), ELAPSED_TICK_MS);
			this.ticker.unref?.();
		} else if (!timed && this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}

	private setLive(item: Omit<ActivityLaneItem, "status">, status: "active" | "waiting", publish = true): boolean {
		const previous = this.live.get(item.id);
		const clock = resolveDisplayClock(item, this.now(), previous, isBackgroundToolActivityItem(item), this.wallNow());
		const firstTokenAt = item.firstTokenAt ?? previous?.firstTokenAt;
		const next = {
			...item,
			label: boundedLabel(item.label),
			status,
			...clock,
			firstTokenAt,
		};
		if (sameActivityItem(previous, next)) return false;
		this.live.set(item.id, next);
		if (publish) {
			this.syncTicker();
			this.requestRender();
		}
		return true;
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
		while (this.transient.size >= MAX_TRANSIENT_ITEMS) {
			const oldest = this.transient.keys().next().value;
			if (oldest === undefined) break;
			clearTimeout(this.transientTimers.get(oldest));
			this.transient.delete(oldest);
			this.transientTimers.delete(oldest);
		}
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
		const keep = new Set<string>();
		let changed = false;
		for (const item of projection.active) {
			keep.add(item.id);
			const previous = this.canonical.get(item.id);
			const phaseChanged =
				previous !== undefined && (previous.status !== item.status || previous.originAt !== item.originAt);
			const clock = resolveDisplayClock(item, this.now(), phaseChanged ? undefined : previous, true, this.wallNow());
			const next = { ...item, ...clock };
			if (!sameActivityItem(previous, next)) {
				this.canonical.set(item.id, next);
				changed = true;
			}
		}
		for (const id of this.canonical.keys()) {
			if (keep.has(id)) continue;
			this.canonical.delete(id);
			changed = true;
		}
		for (const item of projection.terminal.slice(-MAX_SEEN_TERMINALS)) {
			if (showNewTerminals && !this.seenTerminalKeys.has(item.id)) {
				this.addTransient(item);
				changed = true;
			}
			this.rememberTerminal(item.id);
		}
		if (changed) {
			this.syncTicker();
			this.requestRender();
		}
	}

	replaceCanonical(sessionKey: string, snapshot: ActivityLaneCanonicalSnapshot): void {
		if (this.sessionKey !== sessionKey) {
			this.clearTransient();
			this.live.clear();
			this.canonical.clear();
			this.foregroundEpoch = undefined;
			this.foregroundOutcome = undefined;
			this.syncTicker();
			this.seenTerminalKeys.clear();
			this.sessionKey = sessionKey;
			this.requestRender();
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
		this.setLive(item, "active");
	}

	wait(item: Omit<ActivityLaneItem, "status">): void {
		this.setLive(item, "waiting");
	}

	/**
	 * Stamp the arrival of this turn's first provider token. Idempotent within the turn: the first
	 * call wins and later ones are no-ops, so the caller may mark on every content delta. A no-op for
	 * an item that is not live or has no clock to measure against.
	 */
	markFirstToken(id: string, at: number = this.now()): void {
		const current = this.live.get(id);
		if (!current || current.startedAt === undefined || current.firstTokenAt !== undefined) return;
		this.live.set(id, { ...current, firstTokenAt: at });
		this.requestRender();
	}

	update(id: string, label: string): void {
		const current = this.live.get(id);
		if (!current || current.label === boundedLabel(label)) return;
		this.live.set(id, { ...current, label: boundedLabel(label) });
		this.requestRender();
	}

	remove(id: string): void {
		if (!this.live.delete(id)) return;
		this.syncTicker();
		this.requestRender();
	}

	removeByPrefix(prefix: string): void {
		this.removeMatching((item) => item.id.startsWith(prefix));
	}

	private removeMatching(matches: (item: ActivityLaneItem) => boolean): void {
		let removed = false;
		for (const [id, item] of this.live) {
			if (!matches(item)) continue;
			this.live.delete(id);
			removed = true;
		}
		if (!removed) return;
		this.syncTicker();
		this.requestRender();
	}

	reconcileByPrefix(prefix: string, items: readonly Omit<ActivityLaneItem, "status">[]): void {
		const keep = new Set(items.map((item) => item.id));
		let changed = false;
		for (const id of [...this.live.keys()]) {
			if (!id.startsWith(prefix) || keep.has(id)) continue;
			this.live.delete(id);
			changed = true;
		}
		for (const item of items) {
			if (!item.id.startsWith(prefix)) continue;
			changed = this.setLive(item, "active", false) || changed;
		}
		if (changed) {
			this.syncTicker();
			this.requestRender();
		}
	}

	finish(id: string, status: "success" | "failure" | "neutral", fallback?: Omit<ActivityLaneItem, "status">): void {
		const current = this.live.get(id) ?? fallback;
		this.live.delete(id);
		this.syncTicker();
		if (current)
			this.addTransient({
				...current,
				label: boundedLabel(fallback?.label ?? current.label),
				status,
				completedAt: this.now(),
			});
		this.requestRender();
	}

	announce(label: string, status: "success" | "warning" | "failure" | "neutral" = "success"): void {
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

	/** Submission identity and settlement are owned by the existing foreground lease. */
	syncForegroundActivity(activity: { sessionId: string; epoch?: number; busy: boolean }, label = "Preparing"): void {
		if (this.sessionKey !== activity.sessionId) {
			this.replaceCanonical(activity.sessionId, { laneRecords: [] });
		}
		if (activity.busy && activity.epoch !== undefined) {
			if (this.foregroundEpoch === activity.epoch) return;
			this.removeMatching(isParentRuntimeItem);
			this.foregroundEpoch = activity.epoch;
			this.foregroundOutcome = undefined;
			this.start({ id: RUNTIME_TURN_ACTIVITY_ID, kind: "runtime", label });
		} else if ((!activity.busy || activity.epoch === undefined) && this.foregroundEpoch !== undefined) {
			// The submission ended when its lease did. Background work (a backgrounded tool, an armed
			// continuation, System One checking the answer) keeps the session busy, but it has its own
			// rows; holding the turn row open for it reported a finished turn as still preparing.
			const outcome = this.foregroundOutcome ?? { status: "neutral" as const, label: "Stopped" };
			this.finish(RUNTIME_TURN_ACTIVITY_ID, outcome.status, {
				id: RUNTIME_TURN_ACTIVITY_ID,
				kind: "runtime",
				label: outcome.label,
			});
			this.removeMatching(isParentRuntimeItem);
			this.foregroundEpoch = undefined;
			this.foregroundOutcome = undefined;
		}
	}

	setForegroundOutcome(status: "success" | "failure" | "neutral", label: string): void {
		if (this.foregroundEpoch !== undefined) this.foregroundOutcome = { status, label };
	}

	syncHumanInputActivity(activity: { requestId: string; toolCallId?: string; waiting: boolean }): void {
		const id = `runtime:input:${activity.requestId}`;
		if (activity.waiting) {
			this.wait({ id, kind: "runtime", phase: "input", toolCallId: activity.toolCallId, label: "Awaiting you" });
		} else {
			this.remove(id);
		}
	}

	setParentVisible(visible: boolean): void {
		if (this.parentVisible === visible) return;
		this.parentVisible = visible;
		this.syncTicker();
		this.requestRender();
	}

	render(width: number): string[] {
		return renderActivityLaneLine(
			this.theme,
			this.getItems().filter((item) => this.parentVisible || !isParentRuntimeItem(item)),
			width,
			this.now(),
		);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
		this.externalClocks.clear();
		this.clearTransient();
		this.live.clear();
		this.canonical.clear();
		this.seenTerminalKeys.clear();
	}
}
