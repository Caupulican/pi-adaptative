import type { Component } from "@caupulican/pi-tui";
import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import { renderTitleBadge, type TitleBadgeStatus } from "../../modes/interactive/components/tool-title.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { TaskStep, TaskStepsState } from "../tasks/task-state.ts";

export type OrchestrationRowStatus =
	| "pending"
	| "queued"
	| "running"
	| "in_progress"
	| "completed"
	| "succeeded"
	| "blocked"
	| "failed"
	| "timeout"
	| "budget_exhausted"
	| "cancelled"
	| "canceled"
	| "reviewed"
	| "info";

export interface OrchestrationPanelRow {
	status: OrchestrationRowStatus;
	label: string;
	section?: string;
	meta?: readonly string[];
	details?: readonly string[];
}

export interface OrchestrationPanelNotice {
	status: "info" | "success" | "warning" | "error";
	text: string;
}

export interface OrchestrationPanelModel {
	label: string;
	action?: string;
	status?: TitleBadgeStatus;
	summary?: readonly string[];
	rows?: readonly OrchestrationPanelRow[];
	notices?: readonly OrchestrationPanelNotice[];
	emptyText?: string;
	hiddenRowCount?: number;
}

interface RowStyle {
	icon: string;
	color: ThemeColor;
	strike?: boolean;
	bold?: boolean;
}

const ROW_STYLES: Record<OrchestrationRowStatus, RowStyle> = {
	pending: { icon: "○", color: "muted" },
	queued: { icon: "◌", color: "warning" },
	running: { icon: "●", color: "accent", bold: true },
	in_progress: { icon: "●", color: "accent", bold: true },
	completed: { icon: "✓", color: "success", strike: true },
	succeeded: { icon: "✓", color: "success" },
	blocked: { icon: "!", color: "warning", bold: true },
	failed: { icon: "×", color: "error", bold: true },
	timeout: { icon: "×", color: "warning" },
	budget_exhausted: { icon: "!", color: "warning" },
	cancelled: { icon: "–", color: "muted", strike: true },
	canceled: { icon: "–", color: "muted", strike: true },
	reviewed: { icon: "✓", color: "success" },
	info: { icon: "·", color: "muted" },
};

const NOTICE_STYLES: Record<OrchestrationPanelNotice["status"], { icon: string; color: ThemeColor }> = {
	info: { icon: "·", color: "muted" },
	success: { icon: "✓", color: "success" },
	warning: { icon: "!", color: "warning" },
	error: { icon: "×", color: "error" },
};

export function taskStepPanelRow(step: TaskStep): OrchestrationPanelRow {
	const meta = [
		step.priority === "high" ? "high priority" : undefined,
		step.owner ? `@${step.owner}` : undefined,
		step.requirementIds?.length
			? `${step.requirementIds.length} requirement${step.requirementIds.length === 1 ? "" : "s"}`
			: undefined,
		step.evidence.length ? `${step.evidence.length} evidence` : undefined,
	].filter((value): value is string => value !== undefined);
	const details = [
		...step.notes.slice(-2).map((note) => `note: ${note}`),
		...step.evidence.slice(-2).map((evidence) => `evidence: ${evidence}`),
	];
	return {
		status: step.status,
		label: step.status === "in_progress" ? (step.activeForm ?? step.content) : step.content,
		meta,
		details,
	};
}

/** Build the quiet below-editor view from native session truth. No active work means no widget. */
export function createOrchestrationActivityModel(
	taskState: TaskStepsState | undefined,
	laneRecords: readonly LaneRecord[],
): OrchestrationPanelModel | undefined {
	const openSteps =
		taskState?.steps.filter((step) => step.status !== "completed" && step.status !== "cancelled") ?? [];
	const orderedSteps = [
		...openSteps.filter((step) => step.status === "in_progress"),
		...openSteps.filter((step) => step.status === "blocked"),
		...openSteps.filter((step) => step.status === "pending"),
	];
	const activeLanes = laneRecords.filter(
		(lane) =>
			(lane.type === "worker" || lane.type === "tmux-worker") &&
			(lane.status === "running" || lane.status === "queued"),
	);
	if (openSteps.length === 0 && activeLanes.length === 0) return undefined;

	const taskRows = orderedSteps.slice(0, 5).map((step) => ({ ...taskStepPanelRow(step), section: "Steps" }));
	const laneRows: OrchestrationPanelRow[] = activeLanes.slice(0, 3).map((lane) => ({
		status: lane.status,
		label: lane.label ?? lane.laneId,
		section: "Agents",
		meta: [
			lane.label ? lane.laneId : undefined,
			lane.profileId ? `profile ${lane.profileId}` : undefined,
			lane.type === "tmux-worker" ? "tmux" : undefined,
		].filter((value): value is string => value !== undefined),
	}));
	const runningLanes = activeLanes.filter((lane) => lane.status === "running").length;
	const queuedLanes = activeLanes.length - runningLanes;
	const blockedSteps = openSteps.filter((step) => step.status === "blocked").length;
	const workingSteps = openSteps.filter((step) => step.status === "in_progress").length;
	const evidenceMissing = taskState?.steps.some((step) => step.status === "completed" && step.evidence.length === 0);
	return {
		label: "work",
		action: workingSteps + runningLanes > 0 ? "active" : "ready",
		status: blockedSteps > 0 ? "warning" : workingSteps + runningLanes > 0 ? "running" : "idle",
		summary: [
			openSteps.length ? `${openSteps.length} step${openSteps.length === 1 ? "" : "s"}` : undefined,
			runningLanes ? `${runningLanes} agent${runningLanes === 1 ? "" : "s"}` : undefined,
			queuedLanes ? `${queuedLanes} queued` : undefined,
		].filter((value): value is string => value !== undefined),
		rows: [...taskRows, ...laneRows],
		hiddenRowCount: Math.max(0, openSteps.length + activeLanes.length - taskRows.length - laneRows.length),
		notices: evidenceMissing
			? [{ status: "warning", text: "Completed work still needs attached evidence." }]
			: undefined,
	};
}

function renderRow(theme: Theme, row: OrchestrationPanelRow, width: number, expanded: boolean): string[] {
	const style = ROW_STYLES[row.status];
	const prefix = `  ${theme.fg(style.color, style.icon)} `;
	const meta = row.meta?.filter(Boolean).join(" · ") ?? "";
	const suffix = meta ? `  ${theme.fg("dim", meta)}` : "";
	const labelWidth = Math.max(4, width - visibleWidth(prefix) - visibleWidth(suffix));
	const clippedLabel = truncateToWidth(row.label, labelWidth, "…");
	let label = style.bold ? theme.bold(clippedLabel) : clippedLabel;
	if (style.strike) label = theme.strikethrough(label);
	const lines = [`${prefix}${theme.fg(style.strike ? "dim" : "text", label)}${suffix}`];
	if (expanded) {
		for (const detail of row.details ?? []) {
			lines.push(`    ${theme.fg("dim", truncateToWidth(detail, Math.max(4, width - 4), "…"))}`);
		}
	}
	return lines;
}

export function renderOrchestrationPanelLines(
	theme: Theme,
	model: OrchestrationPanelModel,
	width: number,
	expanded = false,
): string[] {
	const safeWidth = Math.max(1, width);
	const title = renderTitleBadge(theme, {
		label: model.label,
		action: model.action,
		status: model.status ?? "info",
	});
	const summary = model.summary?.filter(Boolean).join(theme.fg("dim", " · ")) ?? "";
	const lines = [summary ? `${title}  ${theme.fg("dim", summary)}` : title];
	const rows = model.rows ?? [];
	if (rows.length > 0) {
		let section: string | undefined;
		for (const row of rows) {
			if (row.section && row.section !== section) {
				section = row.section;
				lines.push(`  ${theme.fg("muted", theme.bold(row.section))}`);
			}
			lines.push(...renderRow(theme, row, safeWidth, expanded));
		}
	} else if (model.emptyText) {
		lines.push(`  ${theme.fg("muted", model.emptyText)}`);
	}
	if ((model.hiddenRowCount ?? 0) > 0) {
		lines.push(`  ${theme.fg("dim", `… ${model.hiddenRowCount} more`)}`);
	}
	for (const notice of model.notices ?? []) {
		const style = NOTICE_STYLES[notice.status];
		lines.push(`  ${theme.fg(style.color, style.icon)} ${theme.fg("dim", notice.text)}`);
	}
	return lines.map((line) => truncateToWidth(line, safeWidth, ""));
}

export class OrchestrationPanelComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly theme: Theme;
	private readonly model: OrchestrationPanelModel;
	private readonly expanded: boolean;

	constructor(theme: Theme, model: OrchestrationPanelModel, expanded = false) {
		this.theme = theme;
		this.model = model;
		this.expanded = expanded;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = renderOrchestrationPanelLines(this.theme, this.model, width, this.expanded);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export function emptyOrchestrationCall(): Component {
	return {
		render: () => [],
		invalidate() {},
	};
}
