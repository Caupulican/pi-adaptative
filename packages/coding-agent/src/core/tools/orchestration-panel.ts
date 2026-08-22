import type { Component } from "@caupulican/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@caupulican/pi-tui";
import { renderTitleBadge, type TitleBadgeStatus } from "../../modes/interactive/components/tool-title.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";
import type { GoalEvidenceRef, Requirement } from "../goals/goal-state.ts";
import type { TaskStep } from "../tasks/task-state.ts";

export type OrchestrationRowStatus =
	| "pending"
	| "queued"
	| "running"
	| "in_progress"
	| "completed"
	| "succeeded"
	| "partial"
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
	/** Full context shown beneath the title. Detailed inspector surfaces wrap this instead of truncating it. */
	description?: string;
	/** Preserve complete row/detail text across wrapped lines. Compact tool surfaces keep the legacy one-line form. */
	wrapRows?: boolean;
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
	partial: { icon: "!", color: "warning" },
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

export function goalRequirementPanelRow(requirement: Requirement): OrchestrationPanelRow {
	return {
		status:
			requirement.status === "satisfied" ? "completed" : requirement.status === "blocked" ? "blocked" : "pending",
		label: requirement.text,
		section: "Requirements",
		meta: [
			requirement.id,
			requirement.evidenceIds.length > 0 ? `${requirement.evidenceIds.length} evidence` : undefined,
			requirement.boundLaneId ? `worker: ${requirement.boundLaneId}` : undefined,
		].filter((value): value is string => value !== undefined),
		details: [
			requirement.blockedReason ? `blocked: ${requirement.blockedReason}` : undefined,
			requirement.dependencies?.length ? `depends on: ${requirement.dependencies.join(", ")}` : undefined,
			requirement.evidenceIds.length ? `evidence: ${requirement.evidenceIds.join(", ")}` : undefined,
		].filter((value): value is string => value !== undefined),
	};
}

export function goalEvidencePanelRow(evidence: GoalEvidenceRef): OrchestrationPanelRow {
	return {
		status: "reviewed",
		label: evidence.summary,
		section: "Evidence",
		meta: [
			evidence.id,
			evidence.kind,
			evidence.verified === true ? "verified" : evidence.verified === false ? "unverified" : undefined,
		].filter((value): value is string => value !== undefined),
		details: evidence.uri ? [`source: ${evidence.uri}`] : undefined,
	};
}

export function taskStepPanelRow(step: TaskStep): OrchestrationPanelRow {
	const meta = [
		step.priority === "high" ? "high priority" : undefined,
		step.owner ? `@${step.owner}` : undefined,
		step.requirementIds?.length
			? `${step.requirementIds.length} requirement${step.requirementIds.length === 1 ? "" : "s"}`
			: undefined,
		step.pipelineRunId && step.pipelineStageId ? `${step.pipelineRunId}/${step.pipelineStageId}` : undefined,
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

function styledRowLabel(theme: Theme, text: string, style: RowStyle): string {
	let label = style.bold ? theme.bold(text) : text;
	if (style.strike) label = theme.strikethrough(label);
	return theme.fg(style.strike ? "dim" : "text", label);
}

function renderRow(
	theme: Theme,
	row: OrchestrationPanelRow,
	width: number,
	expanded: boolean,
	wrap: boolean,
): string[] {
	const style = ROW_STYLES[row.status];
	const prefix = `  ${theme.fg(style.color, style.icon)} `;
	const continuationPrefix = " ".repeat(visibleWidth(prefix));
	const meta = row.meta?.filter(Boolean).join(" · ") ?? "";
	const suffix = meta ? `  ${theme.fg("dim", meta)}` : "";
	const labelWidth = Math.max(4, width - visibleWidth(prefix) - visibleWidth(suffix));
	const labelLines = wrap ? wrapTextWithAnsi(row.label, labelWidth) : [truncateToWidth(row.label, labelWidth, "…")];
	const firstLabel = labelLines[0] ?? "";
	const lines = [`${prefix}${styledRowLabel(theme, firstLabel, style)}${suffix}`];
	for (const continuation of labelLines.slice(1)) {
		lines.push(`${continuationPrefix}${styledRowLabel(theme, continuation, style)}`);
	}
	if (expanded) {
		for (const detail of row.details ?? []) {
			const detailLines = wrap
				? wrapTextWithAnsi(detail, Math.max(4, width - 4))
				: [truncateToWidth(detail, Math.max(4, width - 4), "…")];
			for (const detailLine of detailLines) lines.push(`    ${theme.fg("dim", detailLine)}`);
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
	if (model.description) {
		const descriptionLines = model.wrapRows
			? wrapTextWithAnsi(model.description, Math.max(4, safeWidth - 2))
			: [truncateToWidth(model.description, Math.max(4, safeWidth - 2), "…")];
		for (const line of descriptionLines) lines.push(`  ${theme.fg("text", line)}`);
	}
	const rows = model.rows ?? [];
	if (rows.length > 0) {
		let section: string | undefined;
		for (const row of rows) {
			if (row.section && row.section !== section) {
				section = row.section;
				lines.push(`  ${theme.fg("muted", theme.bold(row.section))}`);
			}
			lines.push(...renderRow(theme, row, safeWidth, expanded, model.wrapRows === true));
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
