import { type Component, Container, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import { theme } from "../theme/theme.ts";
import { ActionTranscriptComponent } from "./action-transcript.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { ConversationWindow } from "./conversation-window.ts";
import { keyText } from "./keybinding-hints.ts";
import { fitRow, labelRow, surfaceRow, WorkbenchPane, type WorkbenchPaneTitleButton } from "./workbench-pane.ts";

/** The title strip names the work; the run state lives on the live row inside the conversation zone. */
export interface WorkbenchHeadline {
	title?: string;
}

/** One inspector block: a titled group of rows (plan steps, team members). */
export interface WorkbenchSection {
	title: string;
	meta?: string;
	body: Component | string[];
}

export interface WorkbenchOptions {
	conversation: Container;
	editor: Container;
	/** Rows directly above the input, in order: transient notices, widgets, session status. */
	dock: Component[];
	/** Rows directly below the input. */
	dockBelow?: Component[];
	/** Live activity line under the title strip. */
	activity?: Component;
	brand: string;
	/** Fallback title when no plan or goal names the work. */
	title?: () => string;
	viewportRows: () => number;
	/** Mounted for focus/lifecycle but not permanently reserved above the conversation. */
	header?: Component;
}

export const PLAN_SECTION = "Work plan";
export const TEAM_SECTION = "Team";
export const CHECKS_SECTION = "Checks";
export const EDGE_SECTION = "Edge";
const EXECUTION_META = "File effects and command outcomes";
const MIN_INSPECTOR_WIDTH = 24;
const SIDE_BY_SIDE_MIN_COLUMNS = 80;
export const DEFAULT_INSPECTOR_FRACTION = 0.3;
export const MIN_INSPECTOR_FRACTION = 0.2;
export const MAX_INSPECTOR_FRACTION = 0.45;
export const DEFAULT_CONVERSATION_FRACTION = 0.5;
export const MIN_CONVERSATION_FRACTION = 0.3;
export const MAX_CONVERSATION_FRACTION = 0.7;
/** Until the operator resizes, evidence and conversation share the rows evenly. */
export const DEFAULT_UPPER_ROWS: WorkAreaRows = "half";
/** The conversation never drops below this many rows, whatever the operator gives the work area. */
export const MIN_CONVERSATION_ROWS = 6;
export const MAX_UPPER_ROWS = 60;

/** Explicit rows the operator chose, or "half": an even split that follows the terminal's height. */
export type WorkAreaRows = number | "half";

/** Everything the operator owns about the work area; persisted as-is across sessions. */
export type WorkbenchHit =
	| "conversation"
	| "conversationHeader"
	| "divider"
	| "split"
	| "columnSplit"
	| "inspectorTitle"
	| "executionTitle"
	| "upper"
	| "other";

export type WorkbenchLayout = "stacked" | "columns";

export interface WorkbenchGeometry {
	rows: WorkAreaRows;
	collapsed: boolean;
	inspector: "shown" | "hidden";
	executionMaximized: boolean;
	inspectorFraction?: number;
	layout?: WorkbenchLayout;
	conversationFraction?: number;
}

export function clampUpperRows(rows: number): number {
	return Math.max(2, Math.min(MAX_UPPER_ROWS, Math.floor(rows)));
}

/** The even split for a given budget: half of what is left after the divider and the header. */
export function halfWorkAreaRows(available: number): number {
	return Math.max(0, Math.floor((available - 2) / 2));
}

/**
 * Rows the work area takes out of `available` (the rows left after the title strip, the live row
 * and the dock; the divider and the conversation header come out of it too). Pure so the budget is
 * testable without a frame: collapsed takes none, maximized takes everything the conversation
 * minimum leaves, otherwise the operator's rows (or the even split) up to that cap.
 */
export function workAreaRows(available: number, geometry: WorkbenchGeometry): number {
	if (geometry.collapsed) return 0;
	const cap = Math.max(0, available - 2 - MIN_CONVERSATION_ROWS);
	const rows = geometry.rows === "half" ? halfWorkAreaRows(available) : geometry.rows;
	return geometry.executionMaximized ? cap : Math.min(rows, cap);
}

/**
 * Human-facing composition only. The original transcript still owns all messages and actions.
 *
 * Rows, top to bottom: title strip, live activity, the work area (inspector left, execution right)
 * at a fixed height unless the operator collapses it, its divider, conversation header, conversation
 * rows, the status band, input, rows below the input and a key hint. Zones separate by surface tone
 * and spacing, never by frames. Only the operator changes the work area's size or visibility.
 */
export class WorkbenchComponent extends Container {
	private frameRevision = 0;
	override get renderRevision(): number {
		return this.frameRevision;
	}
	readonly conversation: ConversationWindow;
	private readonly options: WorkbenchOptions;
	private sections: WorkbenchSection[] = [];
	private headlineState: WorkbenchHeadline = {};
	private execution?: Component;
	private executionMeta = EXECUTION_META;
	private executionEvidence?: Component;
	private displayedShell?: BashExecutionComponent;
	private upperLimit: WorkAreaRows = DEFAULT_UPPER_ROWS;
	/** Row budget of the last frame; an even split resolves against it when the operator resizes. */
	private lastAvailable = 0;
	private collapsed = false;
	private inspectorHidden = false;
	private executionMaximized = false;
	private executionCompact = false;
	/** Who owns the mouse; the hint row reports it so a silent wheel is never a mystery. */
	private mouseMode = false;
	private readonly inspectorPane = new WorkbenchPane();
	private readonly executionPane = new WorkbenchPane();
	private inspectorFraction = DEFAULT_INSPECTOR_FRACTION;
	private conversationFraction = DEFAULT_CONVERSATION_FRACTION;
	private columns = false;
	private lastColumns = 0;
	private workLeft = 0;
	private workWidth = 0;
	private dismissedShell?: BashExecutionComponent;
	private headerButtons: { action: "latest" | "copyAll" | "layout"; start: number; end: number }[] = [];
	conversationTop = 0;
	conversationLeft = 1;
	conversationWidth = 0;
	conversationHeight = 0;
	/** First row of the work area; the row above it is the title strip. */
	upperTop = 0;
	upperHeight = 0;
	/** Row of the divider that collapses or expands the work area; -1 in the native fallback. */
	dividerRow = -1;
	/** Inclusive start of the inspector/execution drag handle; -1 when the panes are not side by side. */
	splitStart = -1;
	/** Exclusive end of the inspector/execution drag handle. */
	splitEnd = -1;
	/** Inclusive start of the conversation/execution column gutter; -1 in stacked layout. */
	columnSplitStart = -1;
	/** Exclusive end of the conversation/execution column gutter. */
	columnSplitEnd = -1;
	/** Key labels resolve once; the keybinding manager is static after startup. */
	private keyLabels?: {
		toggle: string;
		resize: string;
		hint: string;
		mouse: string;
		inspector: string;
		maximize: string;
	};

	private keys(): {
		toggle: string;
		resize: string;
		hint: string;
		mouse: string;
		inspector: string;
		maximize: string;
	} {
		if (this.keyLabels) return this.keyLabels;
		const key = (binding: Parameters<typeof keyText>[0], text: string) => {
			const keys = keyText(binding);
			return keys ? `${keys} ${text}` : "";
		};
		this.keyLabels = {
			toggle: keyText("app.execution.toggle"),
			resize: [keyText("app.workbench.grow"), keyText("app.workbench.shrink")].filter(Boolean).join(" "),
			hint: [
				"/ commands",
				key("app.interrupt", "interrupt"),
				// Windows Terminal swallows alt+enter; the `>>` prefix is the follow-up gesture there.
				process.env.WT_SESSION ? ">> follow-up" : key("app.message.followUp", "follow-up"),
				key("app.transcript.open", "transcript"),
				key("app.conversation.copy", "copy conversation"),
			]
				.filter(Boolean)
				.join(" · "),
			mouse: keyText("app.mouse.toggle"),
			inspector: keyText("app.inspector.toggle"),
			maximize: keyText("app.execution.maximize"),
		};
		return this.keyLabels;
	}

	setMouseMode(enabled: boolean): void {
		this.mouseMode = enabled;
	}

	constructor(options: WorkbenchOptions) {
		super();
		this.options = options;
		for (const child of [
			options.header,
			options.conversation,
			options.activity,
			...options.dock,
			options.editor,
			...(options.dockBelow ?? []),
		]) {
			if (child) this.addChild(child);
		}
		this.conversation = new ConversationWindow(() => [
			...(options.header ? [options.header] : []),
			...options.conversation.children.flatMap((child) =>
				child instanceof ActionTranscriptComponent
					? [...child.conversationComponents()]
					: child instanceof BashExecutionComponent
						? []
						: [child],
			),
		]);
	}

	get isCollapsed(): boolean {
		return this.collapsed;
	}

	replaceDockComponent(current: Component, next: Component): void {
		if (current === next) return;
		const dockIndex = this.options.dock.indexOf(current);
		if (dockIndex === -1) return;
		this.options.dock[dockIndex] = next;
		const childIndex = this.children.indexOf(current);
		if (childIndex !== -1) this.children[childIndex] = next;
		else this.addChild(next);
		this.frameRevision++;
	}
	setInspector(sections: WorkbenchSection[]): void {
		this.sections = sections;
		if (!sections.length) this.inspectorPane.reset();
	}
	setHeadline(headline: WorkbenchHeadline): void {
		this.headlineState = headline;
	}
	setExecution(
		component: Component | undefined,
		compact = false,
		evidence = component,
		meta: string = EXECUTION_META,
	): void {
		if (evidence !== this.executionEvidence || compact !== this.executionCompact) this.executionPane.reset();
		this.execution = component;
		this.executionEvidence = evidence;
		this.executionCompact = compact;
		this.executionMeta = meta;
	}
	scrollUpper(column: number, row: number, delta: number): boolean {
		return this.inspectorPane.scrollAt(column, row, delta) || this.executionPane.scrollAt(column, row, delta);
	}
	/** Page the Execution pane from the keyboard; paging to the end resumes following new evidence. */
	pageExecution(direction: number): boolean {
		return this.executionPane.pageBy(direction);
	}
	dismissUserShell(): void {
		this.dismissedShell = this.options.conversation.children.findLast(
			(child): child is BashExecutionComponent => child instanceof BashExecutionComponent,
		);
	}
	toggleUpper(): void {
		this.collapsed = !this.collapsed;
	}
	/** Hide the Work plan / Team inspector so Execution takes the full width, or show it again. */
	toggleInspector(): void {
		this.inspectorHidden = !this.inspectorHidden;
	}
	/** Give Execution every row the conversation minimum leaves (inspector hidden meanwhile), or return to the operator's rows. */
	toggleExecutionMaximized(): void {
		this.executionMaximized = !this.executionMaximized;
		if (this.executionMaximized) this.collapsed = false;
	}
	/** Stacked (work above conversation) stays the default; columns puts conversation left and execution right. */
	toggleLayout(): void {
		this.columns = !this.columns;
		if (this.columns) this.collapsed = false;
	}
	geometry(): WorkbenchGeometry {
		return {
			rows: this.upperLimit,
			collapsed: this.collapsed,
			inspector: this.inspectorHidden ? "hidden" : "shown",
			executionMaximized: this.executionMaximized,
			inspectorFraction: this.inspectorFraction,
			layout: this.columns ? "columns" : "stacked",
			conversationFraction: this.conversationFraction,
		};
	}
	applyGeometry(geometry: WorkbenchGeometry): void {
		this.upperLimit = geometry.rows === "half" ? "half" : clampUpperRows(geometry.rows);
		this.collapsed = geometry.collapsed;
		this.inspectorHidden = geometry.inspector === "hidden";
		this.executionMaximized = geometry.executionMaximized;
		if (geometry.inspectorFraction !== undefined) this.resizeInspector(geometry.inspectorFraction);
		if (geometry.layout !== undefined) this.columns = geometry.layout === "columns";
		if (geometry.conversationFraction !== undefined) this.resizeConversation(geometry.conversationFraction);
	}
	resizeUpper(rows: number): void {
		this.upperLimit = clampUpperRows(rows);
	}
	/** The rows the work area has now: the operator's number, or the even split of the last frame. */
	private currentUpperRows(): number {
		return this.upperLimit === "half" ? halfWorkAreaRows(this.lastAvailable) : this.upperLimit;
	}
	growUpper(): void {
		this.resizeUpper(this.currentUpperRows() + 1);
	}
	shrinkUpper(): void {
		this.resizeUpper(this.currentUpperRows() - 1);
	}
	resizeInspector(fraction: number): void {
		this.inspectorFraction = Math.max(MIN_INSPECTOR_FRACTION, Math.min(MAX_INSPECTOR_FRACTION, fraction));
	}
	/** Pointer row on the horizontal divider: grow or shrink the work area, or collapse below two rows. */
	resizeUpperFromPointer(row: number): void {
		this.executionMaximized = false;
		const rows = row - this.upperTop;
		if (rows < 2) {
			this.collapsed = true;
			return;
		}
		this.collapsed = false;
		this.resizeUpper(rows);
	}
	/** Pointer column on the vertical split: the inspector's share of the work column. */
	resizeInspectorFromPointer(column: number): void {
		const width = this.workWidth > 0 ? this.workWidth : this.lastColumns;
		if (width <= 0) return;
		this.resizeInspector((column - this.workLeft) / width);
	}
	resizeConversation(fraction: number): void {
		this.conversationFraction = Math.max(MIN_CONVERSATION_FRACTION, Math.min(MAX_CONVERSATION_FRACTION, fraction));
	}
	/** Pointer column on the conversation/execution gutter. */
	resizeConversationFromPointer(column: number): void {
		if (this.lastColumns <= 0) return;
		this.resizeConversation(column / this.lastColumns);
	}
	paneTitleAction(column: number, row?: number): WorkbenchPaneTitleButton["action"] | undefined {
		if (row !== undefined) {
			if (this.inspectorPane.containsTitle(column, row)) return this.inspectorPane.titleAction(column);
			if (this.executionPane.containsTitle(column, row)) return this.executionPane.titleAction(column);
			return undefined;
		}
		return this.inspectorPane.titleAction(column) ?? this.executionPane.titleAction(column);
	}
	inspectorHasTitleActions(): boolean {
		return this.inspectorPane.hasTitleActions();
	}
	executionHasTitleActions(): boolean {
		return this.executionPane.hasTitleActions();
	}
	private inspectorTitleButtons(): WorkbenchPaneTitleButton[] {
		return [{ action: "hideInspector", label: "Hide" }];
	}
	private executionTitleButtons(): WorkbenchPaneTitleButton[] {
		const buttons: WorkbenchPaneTitleButton[] = [];
		if (this.inspectorHidden && !this.executionMaximized) {
			buttons.push({ action: "showInspector", label: "Show plan" });
		}
		if (!this.columns) {
			buttons.push({ action: "maximize", label: this.executionMaximized ? "Restore" : "Maximize" });
		}
		if (this.columns || this.lastColumns >= SIDE_BY_SIDE_MIN_COLUMNS) {
			buttons.push({ action: "layout", label: this.columns ? "Stacked" : "Columns" });
		}
		return buttons;
	}
	headerAction(column: number): "latest" | "copyAll" | "layout" | undefined {
		return this.headerButtons.find((button) => column >= button.start && column < button.end)?.action;
	}

	hitTest(column: number, row: number): WorkbenchHit {
		if (
			row >= this.conversationTop &&
			row < this.conversationTop + this.conversationHeight &&
			column >= this.conversationLeft &&
			column < this.conversationLeft + this.conversationWidth
		) {
			return "conversation";
		}
		if (row === this.conversationTop - 1 && (this.columnSplitStart < 0 || column < this.columnSplitStart)) {
			return "conversationHeader";
		}
		if (row === this.dividerRow) {
			return "divider";
		}
		if (
			this.columnSplitStart >= 0 &&
			row >= this.upperTop &&
			row < this.upperTop + this.upperHeight &&
			column >= this.columnSplitStart &&
			column < this.columnSplitEnd
		) {
			return "columnSplit";
		}
		if (
			this.splitStart >= 0 &&
			row >= this.upperTop &&
			row < this.upperTop + this.upperHeight &&
			column >= this.splitStart &&
			column < this.splitEnd
		) {
			return "split";
		}
		if (this.inspectorPane.containsTitle(column, row)) return "inspectorTitle";
		if (this.executionPane.containsTitle(column, row)) return "executionTitle";
		if (row >= this.upperTop && row < this.upperTop + this.upperHeight) {
			return "upper";
		}
		return "other";
	}

	toConversationPoint(column: number, row: number): { row: number; column: number } {
		return {
			row: Math.max(0, Math.min(this.conversationHeight - 1, row - this.conversationTop)),
			column: Math.max(0, Math.min(this.conversationWidth, column - this.conversationLeft)),
		};
	}

	override invalidate(): void {
		super.invalidate();
		this.conversation.invalidate();
		this.execution?.invalidate();
		this.options.activity?.invalidate();
		for (const section of this.sections) if (!Array.isArray(section.body)) section.body.invalidate();
	}

	/** Identity only: brand and the work's name. State belongs to the live row, where the answer lands. */
	private headline(columns: number): string {
		const inner = Math.max(0, columns - 2);
		const fallback = this.options.title?.() ?? "";
		const title = this.headlineState.title || (fallback === this.options.brand ? "" : fallback);
		let left = theme.bold(theme.fg("accent", this.options.brand));
		const leftWidth = visibleWidth(this.options.brand);
		if (title) {
			const room = inner - leftWidth - 2;
			if (room >= 4) left += `  ${theme.fg("muted", truncateToWidth(title, room, "…"))}`;
		}
		return truncateToWidth(` ${left}`, columns, "");
	}

	private conversationHeader(columns: number): string {
		const inner = Math.max(0, columns - 2);
		const following = this.conversation.following;
		const stateText = following ? " · Following latest" : " · Reading";
		const heading = theme.bold(theme.fg("text", "Conversation")) + theme.fg("muted", stateText);
		const headingWidth = "Conversation".length + stateText.length;
		// Terminal-native selection already copies on release; only whole-conversation copy needs a target.
		const buttons: { action: "latest" | "copyAll" | "layout"; label: string }[] = [
			...(this.columns ? [{ action: "layout" as const, label: "Stacked" }] : []),
			...(following ? [] : [{ action: "latest" as const, label: "Latest ↓" }]),
			{ action: "copyAll", label: "Copy conversation" },
		];
		for (let count = buttons.length; count >= 0; count--) {
			const shown = buttons.slice(0, count);
			const widths = shown.map((button) => visibleWidth(button.label) + 2);
			const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, shown.length - 1) * 2;
			if (headingWidth + (shown.length ? 2 : 0) + total > inner) continue;
			let column = 1 + inner - total;
			const parts: string[] = [];
			shown.forEach((button, index) => {
				this.headerButtons.push({ action: button.action, start: column, end: column + widths[index]! });
				parts.push(theme.bg("workbenchSurface", theme.fg("accent", ` ${button.label} `)));
				column += widths[index]! + 2;
			});
			return ` ${heading}${" ".repeat(inner - headingWidth - total)}${parts.join("  ")} `;
		}
		return truncateToWidth(` ${heading}`, columns, "");
	}

	private divider(columns: number, expanded: boolean): string {
		const { toggle, resize, inspector, maximize } = this.keys();
		const summary = expanded
			? [
					this.executionMaximized ? "↕ execution maximized" : this.mouseMode ? "↕ drag to resize" : "↕ work area",
					toggle && `${toggle} collapse`,
					inspector && `${inspector} inspector`,
					maximize && `${maximize} ${this.executionMaximized ? "restore" : "maximize"}`,
					resize && `${resize} rows`,
					this.mouseMode && "Hide · Maximize",
				]
					.filter(Boolean)
					.join(" · ")
			: [
					`▸ ${[
						...this.sections.map((section) =>
							section.meta ? `${section.title} ${section.meta}` : section.title,
						),
						this.execution ? "Execution" : "",
					]
						.filter(Boolean)
						.join(" · ")}`,
					toggle && `${toggle} expand`,
				]
					.filter(Boolean)
					.join(" · ");
		const label = truncateToWidth(` ${summary} `, Math.max(0, columns - 2), "…");
		const labelWidth = visibleWidth(label);
		const left = Math.max(1, Math.floor((columns - labelWidth) / 2));
		const right = Math.max(0, columns - labelWidth - left);
		return truncateToWidth(
			theme.fg("borderMuted", "─".repeat(left)) +
				theme.fg("muted", label) +
				theme.fg("borderMuted", "─".repeat(right)),
			columns,
			"",
		);
	}

	private hintRow(columns: number): string {
		const { hint, mouse } = this.keys();
		const owner = ` · ${mouse ? `${mouse} ` : ""}mouse: ${this.mouseMode ? "on" : "off"}`;
		return truncateToWidth(` ${theme.fg("dim", hint + owner)}`, columns, "");
	}

	private inspectorContent(width: number): { title: string; meta: string; lines: string[] } {
		const body = (section: WorkbenchSection | undefined, placeholder: string): string[] =>
			section
				? Array.isArray(section.body)
					? section.body
					: section.body.render(width)
				: [`  ${theme.fg("dim", placeholder)}`];
		const plan = this.sections.find((section) => section.title === PLAN_SECTION);
		const team = this.sections.find((section) => section.title === TEAM_SECTION);
		const others = this.sections.filter((section) => section !== plan && section !== team);
		const lines = [...body(plan, "No open steps")];
		for (const section of [{ section: team, title: TEAM_SECTION, placeholder: "No agents" }]) {
			lines.push(
				"",
				labelRow(section.title, section.section?.meta ?? "", width),
				...body(section.section, section.placeholder),
			);
		}
		for (const section of others)
			lines.push("", labelRow(section.title, section.meta ?? "", width), ...body(section, ""));
		return { title: PLAN_SECTION, meta: plan?.meta ?? "", lines };
	}

	private renderUpper(columns: number, height: number, top: number, originX = 0): string[] {
		this.inspectorPane.hide();
		this.executionPane.hide();
		this.splitStart = -1;
		this.splitEnd = -1;
		const shell = this.options.conversation.children.findLast(
			(child): child is BashExecutionComponent => child instanceof BashExecutionComponent,
		);
		const visibleShell = shell && shell !== this.dismissedShell ? shell : undefined;
		if (visibleShell !== this.displayedShell) this.executionPane.reset();
		this.displayedShell = visibleShell;
		const executionSource = visibleShell ? visibleShell.getWorkbenchPreview() : this.execution;
		const placeholder = `  ${theme.fg("dim", "No file effects or command outcomes yet")}`;
		const executionLines = (width: number): string[] => {
			const lines = executionSource?.render(width) ?? [];
			return lines.length ? lines : [placeholder];
		};
		const executionMeta = visibleShell ? EXECUTION_META : this.executionMeta;
		// A user shell opens at its command; the cycle's evidence follows its newest rows instead.
		const follow = !visibleShell;
		if (this.inspectorHidden || this.executionMaximized) {
			return this.executionPane.render(
				"Execution",
				executionMeta,
				executionLines(Math.max(1, columns - 2)),
				originX,
				top,
				columns,
				height,
				follow,
				this.executionTitleButtons(),
			);
		}
		if (columns >= SIDE_BY_SIDE_MIN_COLUMNS) {
			const leftWidth = Math.max(MIN_INSPECTOR_WIDTH, Math.floor(columns * this.inspectorFraction));
			const rightX = leftWidth + 2;
			this.splitStart = originX + Math.max(0, leftWidth - 1);
			this.splitEnd = originX + Math.min(columns, rightX + 1);
			const rightWidth = columns - rightX;
			const inspector = this.inspectorContent(leftWidth - 2);
			const left = this.inspectorPane.render(
				inspector.title,
				inspector.meta,
				inspector.lines,
				originX,
				top,
				leftWidth,
				height,
				false,
				this.inspectorTitleButtons(),
			);
			const right = this.executionPane.render(
				"Execution",
				executionMeta,
				executionLines(rightWidth - 2),
				originX + rightX,
				top,
				rightWidth,
				height,
				follow,
				this.executionTitleButtons(),
			);
			return left.map((line, row) => `${line}  ${right[row]}`);
		}
		const width = Math.max(1, columns - 2);
		const inspector = this.inspectorContent(width);
		if (height < 5) {
			// Too short for two surfaces: evidence leads and the inspector follows inside the same viewport.
			const lines = [
				...executionLines(width),
				"",
				labelRow(inspector.title, inspector.meta, width),
				...inspector.lines,
			];
			return this.executionPane.render(
				"Execution",
				executionMeta,
				lines,
				originX,
				top,
				columns,
				height,
				false,
				this.executionTitleButtons(),
			);
		}
		const executionHeight = Math.ceil((height - 1) / 2);
		const inspectorHeight = height - 1 - executionHeight;
		return [
			...this.executionPane.render(
				"Execution",
				executionMeta,
				executionLines(width),
				originX,
				top,
				columns,
				executionHeight,
				follow,
				this.executionTitleButtons(),
			),
			"",
			...this.inspectorPane.render(
				inspector.title,
				inspector.meta,
				inspector.lines,
				originX,
				top + executionHeight + 1,
				columns,
				inspectorHeight,
				false,
				this.inspectorTitleButtons(),
			),
		];
	}

	private renderColumns(
		columns: number,
		available: number,
		head: string[],
		liveRow: string,
		dockRows: string[],
	): string[] {
		const minLeft = 30;
		const minRight = MIN_INSPECTOR_WIDTH + 2;
		let leftWidth = Math.max(minLeft, Math.floor(columns * this.conversationFraction));
		if (columns - leftWidth - 2 < minRight) leftWidth = Math.max(minLeft, columns - 2 - minRight);
		const rightX = leftWidth + 2;
		const rightWidth = Math.max(1, columns - rightX);
		this.workLeft = rightX;
		this.workWidth = rightWidth;
		this.columnSplitStart = Math.max(0, leftWidth - 1);
		this.columnSplitEnd = Math.min(columns, rightX + 1);
		this.upperTop = head.length;
		this.upperHeight = available;
		this.dividerRow = -1;
		const leftInner = Math.max(1, leftWidth - 2);
		this.conversationLeft = 1;
		this.conversationWidth = leftInner;
		this.conversationTop = head.length + 1;
		this.conversationHeight = Math.max(0, available - 1);
		const gutterLeft = (line: string) =>
			line ? ` ${visibleWidth(line) <= leftInner ? line : truncateToWidth(line, leftInner, "")}` : "";
		const header = this.conversationHeader(leftWidth);
		const body = this.conversation.render(leftInner, this.conversationHeight).map(gutterLeft);
		while (body.length < this.conversationHeight) body.push("");
		const left = [header, ...body].map((line) => fitRow(line, leftWidth));
		const right = this.renderUpper(rightWidth, available, head.length, rightX);
		const main = left.map((line, row) => `${line}  ${fitRow(right[row] ?? "", rightWidth)}`);
		return [...head, ...main, liveRow, ...dockRows];
	}

	override render(width: number): string[] {
		// Publish composition changes; mounted children retain their focus/lifecycle owners.
		this.frameRevision++;
		this.inspectorPane.hide();
		this.executionPane.hide();
		this.splitStart = -1;
		this.splitEnd = -1;
		this.columnSplitStart = -1;
		this.columnSplitEnd = -1;
		this.headerButtons = [];
		const columns = Math.max(1, width);
		this.lastColumns = columns;
		const inner = Math.max(1, columns - 2);
		const total = Math.max(1, this.options.viewportRows());
		const editor = this.options.editor.render(inner);
		// Tiny terminals cannot afford gutters. Keep native input/status bottom-anchored;
		// oversized dialogs retain their complete cursor-bearing output, never a sliced editor.
		if (columns < 4 || editor.length >= total - 5) {
			this.conversationTop = this.conversationHeight = this.conversationWidth = this.upperTop = this.upperHeight = 0;
			this.dividerRow = this.splitStart = this.splitEnd = this.columnSplitStart = this.columnSplitEnd = -1;
			const nativeEditor = this.options.editor.render(columns);
			const remaining = Math.max(0, total - nativeEditor.length);
			const dock = remaining
				? this.options.dock.flatMap((component) => component.render(columns)).slice(-remaining)
				: [];
			return [...Array.from({ length: remaining - dock.length }, () => ""), ...dock, ...nativeEditor];
		}
		// Rows that already fit skip the grapheme scan; the width lookup is cached per string.
		const gutter = (line: string) =>
			line ? ` ${visibleWidth(line) <= inner ? line : truncateToWidth(line, inner, "")}` : "";
		// Title strip, divider, conversation header, three conversation rows, the live row and the
		// status boundary stay.
		const dockBudget = Math.max(0, total - editor.length - 9);
		const above = this.options.dock.flatMap((component) => component.render(inner)).slice(-dockBudget);
		const below = (this.options.dockBelow ?? [])
			.flatMap((component) => component.render(inner))
			.slice(0, Math.max(0, dockBudget - above.length));
		// The status band opens with a rule so its boundary reads at a glance.
		const dockRows = [
			...(above.length ? [theme.fg("borderMuted", "─".repeat(columns))] : []),
			...above.map((line) => surfaceRow(gutter(line), columns)),
			...editor.map(gutter),
			...below.map(gutter),
			this.hintRow(columns),
		];
		// The live row is reserved even when idle so the geometry never jumps between turns.
		const activity = this.options.activity?.render(inner).slice(0, 1) ?? [];
		const liveRow = activity.length ? gutter(activity[0]!) : "";
		const head = [this.headline(columns)];
		const available = total - head.length - 1 - dockRows.length;
		this.lastAvailable = available;
		this.workLeft = 0;
		this.workWidth = columns;
		if (this.columns && columns >= SIDE_BY_SIDE_MIN_COLUMNS && !this.collapsed && available >= 2) {
			return this.renderColumns(columns, available, head, liveRow, dockRows);
		}
		const upperRows = workAreaRows(available, this.geometry());
		const upper = upperRows >= 2 ? this.renderUpper(columns, upperRows, head.length) : [];
		this.upperTop = head.length;
		this.upperHeight = upper.length;
		this.dividerRow = head.length + upper.length;
		this.conversationTop = this.dividerRow + 2;
		this.conversationWidth = inner;
		this.conversationHeight = Math.max(0, available - upper.length - 2);
		const header = this.conversationHeader(columns);
		const body = this.conversation.render(inner, this.conversationHeight).map(gutter);
		while (body.length < this.conversationHeight) body.push("");
		return [...head, ...upper, this.divider(columns, upper.length > 0), header, ...body, liveRow, ...dockRows];
	}
}
