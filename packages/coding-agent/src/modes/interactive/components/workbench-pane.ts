import { fitToWidth, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import { theme } from "../theme/theme.ts";

const FULL_RESET = "\x1b[0m";
const BG_RESET = "\x1b[49m";

/**
 * Pad or clip one row to exactly `width` cells. Rows that already fit skip the grapheme scan, which
 * is the per-frame hot path: the width lookup is cached per string, the scan is not.
 */
export function fitRow(content: string, width: number): string {
	return fitToWidth(content, width, true);
}

/** Paint the pane surface under one row. Inner resets re-open the surface; rows never exceed `width`. */
export function surfaceRow(content: string, width: number): string {
	if (width <= 0) return "";
	const surface = theme.getBgAnsi("workbenchSurface");
	const padded = fitRow(content, width);
	return `${surface}${padded
		.split(FULL_RESET)
		.join(FULL_RESET + surface)
		.split(BG_RESET)
		.join(BG_RESET + surface)}${BG_RESET}`;
}

/**
 * Pre-toned left content, pre-toned right content, exactly `width` cells; the right yields first.
 * `leftWidth` may be supplied by callers that already know it, since measuring is the per-frame cost.
 */
export function metaRow(left: string, right: string, width: number, leftWidth = visibleWidth(left)): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (right && leftWidth + 2 + rightWidth <= width) {
		return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	}
	return truncateToWidth(left, width, "…", true);
}

/** Bold title on the left, muted meta right-aligned, exactly `width` cells. Meta yields before the title. */
export function labelRow(title: string, meta: string, width: number): string {
	return metaRow(theme.bold(theme.fg("text", title)), theme.fg("muted", meta), width, visibleWidth(title));
}

export type WorkbenchPaneTitleAction =
	| "showInspector"
	| "hideInspector"
	| "maximize"
	| "layout"
	| "graphList"
	| "graphDiagram"
	| "hideGraph"
	| "followCurrent";

export interface WorkbenchPaneTitleButton {
	action: WorkbenchPaneTitleAction;
	label: string;
	/** A two-state choice (List | Diagram) marks the active one; plain chips leave it unset. */
	selected?: boolean;
}

/**
 * `true` follows the newest rows until the operator scrolls away. `{ row, key }` centres that row
 * when the row or key changes and otherwise leaves the operator's scroll alone. Wheel and page pin
 * a `{ row, key }` viewport even on the last page, so a later focusKey change cannot yank it.
 */
export type WorkbenchPaneFollow = boolean | { row: number; key?: string; newerProgress?: boolean };

export function titleChip(label: string, selected = false): string {
	return selected ? theme.bold(theme.fg("accent", ` ${label} `)) : theme.fg("accent", ` ${label} `);
}

/** Small current-evidence viewport on a surface tone. It owns scroll position, not task/history state. */
export class WorkbenchPane {
	private offset = 0;
	private count = 0;
	private x = 0;
	private y = 0;
	private width = 0;
	private height = 0;
	/** The operator scrolled away from the newest rows; a following pane stops following. */
	private pinned = false;
	/** The row a `{ row }` follow last centred; the pane re-anchors only when it changes. */
	private followedRow?: number;
	/** Semantic focus last followed; a new key re-anchors even when the row number is unchanged. */
	private followedKey?: string;
	/** Pinned viewport has newer progress off-screen. */
	private newerProgress = false;
	/** Last render used `{ row, key }` follow; wheel/page then pin even at the last page. */
	private followByKey = false;
	private titleActions: { action: WorkbenchPaneTitleAction; start: number; end: number }[] = [];

	unpin(): void {
		this.pinned = false;
		this.newerProgress = false;
	}

	isPinned(): boolean {
		return this.pinned;
	}

	hasNewerProgress(): boolean {
		return this.newerProgress;
	}

	reset(): void {
		this.offset = 0;
		this.pinned = false;
		this.followedRow = undefined;
		this.followedKey = undefined;
		this.newerProgress = false;
		this.followByKey = false;
		this.hide();
	}

	hide(): void {
		this.width = 0;
		this.height = 0;
		this.titleActions = [];
	}

	containsTitle(column: number, row: number): boolean {
		return this.height > 0 && row === this.y - 1 && column >= this.x - 1 && column < this.x + this.width + 1;
	}

	titleAction(column: number): WorkbenchPaneTitleAction | undefined {
		return this.titleActions.find((button) => column >= button.start && column < button.end)?.action;
	}

	hasTitleActions(): boolean {
		return this.titleActions.length > 0;
	}

	/** Content-row index under a pointer, or undefined outside the content rectangle. */
	rowAt(column: number, row: number): number | undefined {
		if (column < this.x || column >= this.x + this.width || row < this.y || row >= this.y + this.height) {
			return undefined;
		}
		return this.offset + (row - this.y);
	}

	scrollAt(column: number, row: number, delta: number): boolean {
		return this.rowAt(column, row) === undefined ? false : this.scrollBy(delta);
	}

	/** Scroll without a pointer: the keyboard path for a terminal that keeps its mouse. */
	scrollBy(delta: number): boolean {
		if (this.height <= 0) return false;
		const step = Math.sign(delta) * Math.min(Math.abs(delta), this.height);
		const end = Math.max(0, this.count - this.height);
		this.offset = Math.max(0, Math.min(end, this.offset + step));
		// Tail-follow (`true`) unpins at the newest page so new rows keep landing in view.
		// `{ row, key }` follow pins on any operator scroll, including landing on the last page:
		// offset === end is not "resume auto-follow" when the followed node is not the tail.
		this.pinned = this.followByKey ? true : this.offset < end;
		return true;
	}

	/** One page is the content rows the pane shows; the direction is the sign. */
	pageBy(direction: number): boolean {
		return this.scrollBy(Math.sign(direction) * Math.max(1, this.height - 1));
	}

	/**
	 * One title row followed by `height - 1` content rows, all `width` cells wide with one-cell gutters.
	 * The visible row range joins the meta when content overflows; only content rows accept wheel input.
	 * A following pane keeps its newest rows visible until the operator scrolls up.
	 */
	render(
		title: string,
		meta: string,
		lines: string[],
		x: number,
		y: number,
		width: number,
		height: number,
		follow: WorkbenchPaneFollow = false,
		actions: readonly WorkbenchPaneTitleButton[] = [],
	): string[] {
		if (height <= 0 || width <= 0) {
			this.hide();
			return [];
		}
		this.x = x + 1;
		this.y = y + 1;
		this.width = Math.max(0, width - 2);
		this.height = Math.max(0, height - 1);
		this.count = lines.length;
		this.titleActions = [];
		this.followByKey = typeof follow === "object";
		const end = Math.max(0, lines.length - this.height);
		let target = Math.min(this.offset, end);
		if (typeof follow === "object") {
			const keyChanged = follow.key !== undefined && follow.key !== this.followedKey;
			const rowChanged = follow.row !== this.followedRow;
			if (keyChanged) this.followedKey = follow.key;
			if (rowChanged) this.followedRow = follow.row;
			if (!this.pinned && (keyChanged || rowChanged)) {
				target = follow.row - Math.floor(this.height * 0.55);
				this.newerProgress = false;
			} else if (this.pinned && (keyChanged || rowChanged || follow.newerProgress === true)) {
				this.newerProgress = true;
			}
		} else if (follow && !this.pinned) {
			target = end;
			this.newerProgress = false;
		}
		this.offset = Math.max(0, Math.min(end, target));
		if (!this.pinned) this.newerProgress = false;
		const range =
			lines.length > this.height && this.height > 0
				? `${this.offset + 1}-${Math.min(lines.length, this.offset + this.height)}/${lines.length} ↕`
				: "";
		const combinedMeta = [meta, range, this.newerProgress ? "new" : ""].filter(Boolean).join(" · ");
		const actionWidths = actions.map((action) => visibleWidth(action.label) + 2);
		const actionTotal =
			actionWidths.reduce((sum, actionWidth) => sum + actionWidth, 0) + Math.max(0, actions.length - 1) * 2;
		let heading: string;
		if (actions.length && visibleWidth(title) + 1 + actionTotal <= this.width) {
			const titleWidth = this.width - actionTotal;
			const parts: string[] = [];
			let column = x + 1 + titleWidth;
			actions.forEach((action, index) => {
				this.titleActions.push({ action: action.action, start: column, end: column + actionWidths[index]! });
				parts.push(titleChip(action.label, action.selected ?? false));
				column += actionWidths[index]! + 2;
			});
			heading = ` ${labelRow(title, combinedMeta, titleWidth)}${parts.join("  ")} `;
		} else {
			heading = ` ${labelRow(title, combinedMeta, this.width)} `;
		}
		const rows = [heading];
		for (let row = 0; row < this.height; row++) {
			rows.push(` ${fitRow(lines[this.offset + row] ?? "", this.width)} `);
		}
		return rows.map((row) => surfaceRow(row, width));
	}
}
