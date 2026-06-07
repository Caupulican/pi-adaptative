import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "../theme/theme.ts";

export type TitleBadgeStatus =
	| "pending"
	| "running"
	| "success"
	| "warning"
	| "error"
	| "failed"
	| "failure"
	| "blocked"
	| "cancelled"
	| "persistent"
	| "idle"
	| "disabled"
	| "muted"
	| "info";

export interface TitleBadgeSegment {
	text: string | number | undefined | null;
	color?: ThemeColor;
	bold?: boolean;
	italic?: boolean;
}

export interface TitleBadgeOptions {
	/** Human-facing label rendered inside the badge, e.g. "skill" or "background script". */
	label: string;
	/** Optional glyph rendered before the badge. Keep it one display cell when possible. */
	icon?: string;
	/** Primary action or state, e.g. start/status/logs. */
	action?: string | number | undefined | null;
	/** Secondary details shown after the action. */
	details?: Array<TitleBadgeSegment | string | number | undefined | null>;
	/** Status controls badge/accent color. */
	status?: TitleBadgeStatus;
	/** Override badge color when status is not enough. */
	badgeColor?: ThemeColor;
	/** Override action color. */
	actionColor?: ThemeColor;
}

export type ToolTitleStatus = TitleBadgeStatus;
export type ToolTitleSegment = TitleBadgeSegment;
export type ToolTitleOptions = TitleBadgeOptions;

const STATUS_BADGE_COLORS: Record<TitleBadgeStatus, ThemeColor> = {
	pending: "warning",
	running: "accent",
	success: "success",
	warning: "warning",
	error: "error",
	failed: "error",
	failure: "error",
	blocked: "error",
	cancelled: "warning",
	persistent: "warning",
	idle: "muted",
	disabled: "muted",
	muted: "muted",
	info: "customMessageLabel",
};

const STATUS_ACTION_COLORS: Record<TitleBadgeStatus, ThemeColor> = {
	pending: "warning",
	running: "accent",
	success: "success",
	warning: "warning",
	error: "error",
	failed: "error",
	failure: "error",
	blocked: "error",
	cancelled: "warning",
	persistent: "warning",
	idle: "dim",
	disabled: "muted",
	muted: "muted",
	info: "accent",
};

function styleSegment(theme: Theme, segment: TitleBadgeSegment): string {
	if (segment.text === undefined || segment.text === null || segment.text === "") return "";
	const raw = String(segment.text);
	let text = segment.bold ? theme.bold(raw) : raw;
	if (segment.italic) text = theme.italic(text);
	return segment.color ? theme.fg(segment.color, text) : text;
}

function normalizeDetail(
	detail: TitleBadgeSegment | string | number | undefined | null,
): TitleBadgeSegment | undefined {
	if (detail === undefined || detail === null || detail === "") return undefined;
	if (typeof detail === "object" && "text" in detail) return detail;
	return { text: detail, color: "dim" };
}

export function renderTitleBadge(theme: Theme, options: TitleBadgeOptions): string {
	const status = options.status ?? "info";
	const badgeColor = options.badgeColor ?? STATUS_BADGE_COLORS[status];
	const actionColor = options.actionColor ?? STATUS_ACTION_COLORS[status];
	const icon = options.icon ? `${theme.fg(badgeColor, options.icon)} ` : "";
	const badge = theme.fg(badgeColor, theme.bold(`[${options.label}]`));
	const parts = [icon + badge];

	if (options.action !== undefined && options.action !== null && options.action !== "") {
		parts.push(theme.fg(actionColor, String(options.action)));
	}

	for (const detail of options.details ?? []) {
		const normalized = normalizeDetail(detail);
		if (!normalized) continue;
		const styled = styleSegment(theme, normalized);
		if (styled) parts.push(styled);
	}

	return parts.join(" ");
}

export function renderToolTitle(theme: Theme, options: ToolTitleOptions): string {
	return renderTitleBadge(theme, options);
}

export class TitleBadgeComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly theme: Theme;
	private readonly options: TitleBadgeOptions;

	constructor(theme: Theme, options: TitleBadgeOptions) {
		this.theme = theme;
		this.options = options;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const safeWidth = Math.max(0, width);
		const title = renderTitleBadge(this.theme, this.options);
		this.cachedLines = [truncateToWidth(title, safeWidth, "")];
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export const ToolTitleComponent = TitleBadgeComponent;

export function titleBadge(theme: Theme, options: TitleBadgeOptions): TitleBadgeComponent {
	return new TitleBadgeComponent(theme, options);
}

export function toolTitle(theme: Theme, options: ToolTitleOptions): TitleBadgeComponent {
	return titleBadge(theme, options);
}
