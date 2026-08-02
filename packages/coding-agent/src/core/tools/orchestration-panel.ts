import type { Component } from "@caupulican/pi-tui";
import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import { renderTitleBadge, type TitleBadgeStatus } from "../../modes/interactive/components/tool-title.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import type { TaskStep } from "../tasks/task-state.ts";

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

export function renderOrchestrationToolResult(
	theme: Theme,
	model: OrchestrationPanelModel,
	options: { isPartial: boolean; collapse: boolean; expanded: boolean },
): Component {
	if (options.isPartial || options.collapse) return emptyOrchestrationCall();
	return new OrchestrationPanelComponent(theme, model, options.expanded);
}

export function emptyOrchestrationCall(): Component {
	return {
		render: () => [],
		invalidate() {},
	};
}
