import { type Component, Container, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import { theme } from "../theme/theme.ts";
import { ActionTranscriptComponent } from "./action-transcript.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { ConversationWindow } from "./conversation-window.ts";
import { keyText } from "./keybinding-hints.ts";
import { labelRow, surfaceRow, WorkbenchPane } from "./workbench-pane.ts";

export type WorkbenchRunState = "working" | "waiting" | "idle";

export interface WorkbenchHeadline {
	/** Plan or goal naming the current work; the host fallback names the session otherwise. */
	title?: string;
	state: WorkbenchRunState;
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
const EXECUTION_META = "File effects and command outcomes";
const RUN_STATE_LABEL: Record<WorkbenchRunState, string> = { working: "WORKING", waiting: "WAITING", idle: "IDLE" };
const MIN_INSPECTOR_WIDTH = 24;
const SIDE_BY_SIDE_MIN_COLUMNS = 80;
const DEFAULT_UPPER_ROWS = 10;

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
	private headlineState: WorkbenchHeadline = { state: "idle" };
	private execution?: Component;
	private executionEvidence?: Component;
	private displayedShell?: BashExecutionComponent;
	private upperLimit = DEFAULT_UPPER_ROWS;
	private collapsed = false;
	private executionCompact = false;
	private readonly inspectorPane = new WorkbenchPane();
	private readonly executionPane = new WorkbenchPane();
	private inspectorFraction = 0.3;
	private dismissedShell?: BashExecutionComponent;
	private headerButtons: { action: "latest" | "copyAll"; start: number; end: number }[] = [];
	conversationTop = 0;
	conversationLeft = 1;
	conversationWidth = 0;
	conversationHeight = 0;
	/** First row of the work area; rows above it are the title strip and live activity. */
	upperTop = 0;
	upperHeight = 0;
	/** Row of the divider that collapses or expands the work area; -1 in the native fallback. */
	dividerRow = -1;
	/** Key labels resolve once; the keybinding manager is static after startup. */
	private keyLabels?: { toggle: string; resize: string; hint: string };

	private keys(): { toggle: string; resize: string; hint: string } {
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
				key("app.transcript.open", "transcript"),
				key("app.conversation.copy", "copy conversation"),
			]
				.filter(Boolean)
				.join(" · "),
		};
		return this.keyLabels;
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
	setInspector(sections: WorkbenchSection[]): void {
		this.sections = sections;
		if (!sections.length) this.inspectorPane.reset();
	}
	setHeadline(headline: WorkbenchHeadline): void {
		this.headlineState = headline;
	}
	setExecution(component: Component | undefined, compact = false, evidence = component): void {
		if (evidence !== this.executionEvidence || compact !== this.executionCompact) this.executionPane.reset();
		this.execution = component;
		this.executionEvidence = evidence;
		this.executionCompact = compact;
	}
	scrollUpper(column: number, row: number, delta: number): boolean {
		return this.inspectorPane.scrollAt(column, row, delta) || this.executionPane.scrollAt(column, row, delta);
	}
	dismissUserShell(): void {
		this.dismissedShell = this.options.conversation.children.findLast(
			(child): child is BashExecutionComponent => child instanceof BashExecutionComponent,
		);
	}
	toggleUpper(): void {
		this.collapsed = !this.collapsed;
	}
	resizeUpper(rows: number): void {
		this.upperLimit = Math.max(2, Math.min(60, rows));
	}
	growUpper(): void {
		this.resizeUpper(this.upperLimit + 1);
	}
	shrinkUpper(): void {
		this.resizeUpper(this.upperLimit - 1);
	}
	resizeInspector(fraction: number): void {
		this.inspectorFraction = Math.max(0.2, Math.min(0.45, fraction));
	}
	headerAction(column: number): "latest" | "copyAll" | undefined {
		return this.headerButtons.find((button) => column >= button.start && column < button.end)?.action;
	}

	override invalidate(): void {
		super.invalidate();
		this.conversation.invalidate();
		this.execution?.invalidate();
		this.options.activity?.invalidate();
		for (const section of this.sections) if (!Array.isArray(section.body)) section.body.invalidate();
	}

	private headline(columns: number): string {
		const inner = Math.max(0, columns - 2);
		const { state } = this.headlineState;
		const badgeText = RUN_STATE_LABEL[state];
		const badge = theme.fg(state === "working" ? "accent" : state === "waiting" ? "warning" : "dim", badgeText);
		const fallback = this.options.title?.() ?? "";
		const title = this.headlineState.title || (fallback === this.options.brand ? "" : fallback);
		let left = theme.bold(theme.fg("accent", this.options.brand));
		let leftWidth = visibleWidth(this.options.brand);
		if (title) {
			const room = inner - leftWidth - 2 - badgeText.length - 2;
			if (room >= 4) {
				const shown = truncateToWidth(title, room, "…");
				left += `  ${theme.fg("muted", shown)}`;
				leftWidth += 2 + visibleWidth(shown);
			}
		}
		if (leftWidth + 2 + badgeText.length > inner) return truncateToWidth(` ${left}`, columns, "");
		return ` ${left}${" ".repeat(inner - leftWidth - badgeText.length)}${badge} `;
	}

	private conversationHeader(columns: number): string {
		const inner = Math.max(0, columns - 2);
		const following = this.conversation.following;
		const stateText = following ? " · Following latest" : " · Reading";
		const heading = theme.bold(theme.fg("text", "Conversation")) + theme.fg("muted", stateText);
		const headingWidth = "Conversation".length + stateText.length;
		// Terminal-native selection already copies on release; only whole-conversation copy needs a target.
		const buttons: { action: "latest" | "copyAll"; label: string }[] = [
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
		const { toggle, resize } = this.keys();
		const summary = expanded
			? ["↕ work area", toggle && `${toggle} collapse`, resize && `${resize} rows`].filter(Boolean).join(" · ")
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
		return truncateToWidth(` ${theme.fg("dim", this.keys().hint)}`, columns, "");
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

	private renderUpper(columns: number, height: number, top: number): string[] {
		this.inspectorPane.hide();
		this.executionPane.hide();
		const shell = this.options.conversation.children.findLast(
			(child): child is BashExecutionComponent => child instanceof BashExecutionComponent,
		);
		const visibleShell = shell && shell !== this.dismissedShell ? shell : undefined;
		if (visibleShell !== this.displayedShell) this.executionPane.reset();
		this.displayedShell = visibleShell;
		const executionSource = visibleShell ? visibleShell.getWorkbenchPreview() : this.execution;
		const executionLines = (width: number): string[] =>
			executionSource?.render(width) ?? [`  ${theme.fg("dim", "No file effects or command outcomes yet")}`];
		if (columns >= SIDE_BY_SIDE_MIN_COLUMNS) {
			const leftWidth = Math.max(MIN_INSPECTOR_WIDTH, Math.floor(columns * this.inspectorFraction));
			const rightX = leftWidth + 2;
			const rightWidth = columns - rightX;
			const inspector = this.inspectorContent(leftWidth - 2);
			const left = this.inspectorPane.render(
				inspector.title,
				inspector.meta,
				inspector.lines,
				0,
				top,
				leftWidth,
				height,
			);
			const right = this.executionPane.render(
				"Execution",
				EXECUTION_META,
				executionLines(rightWidth - 2),
				rightX,
				top,
				rightWidth,
				height,
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
			return this.executionPane.render("Execution", EXECUTION_META, lines, 0, top, columns, height);
		}
		const executionHeight = Math.ceil((height - 1) / 2);
		const inspectorHeight = height - 1 - executionHeight;
		return [
			...this.executionPane.render(
				"Execution",
				EXECUTION_META,
				executionLines(width),
				0,
				top,
				columns,
				executionHeight,
			),
			"",
			...this.inspectorPane.render(
				inspector.title,
				inspector.meta,
				inspector.lines,
				0,
				top + executionHeight + 1,
				columns,
				inspectorHeight,
			),
		];
	}

	override render(width: number): string[] {
		// Publish composition changes; mounted children retain their focus/lifecycle owners.
		this.frameRevision++;
		this.inspectorPane.hide();
		this.executionPane.hide();
		this.headerButtons = [];
		const columns = Math.max(1, width);
		const inner = Math.max(1, columns - 2);
		const total = Math.max(1, this.options.viewportRows());
		const editor = this.options.editor.render(inner);
		// Tiny terminals cannot afford gutters. Keep native input/status bottom-anchored;
		// oversized dialogs retain their complete cursor-bearing output, never a sliced editor.
		if (columns < 4 || editor.length >= total - 5) {
			this.conversationTop = this.conversationHeight = this.conversationWidth = this.upperTop = this.upperHeight = 0;
			this.dividerRow = -1;
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
		// Title strip, activity, divider, conversation header and three conversation rows stay.
		const dockBudget = Math.max(0, total - editor.length - 8);
		const above = this.options.dock.flatMap((component) => component.render(inner)).slice(-dockBudget);
		const below = (this.options.dockBelow ?? [])
			.flatMap((component) => component.render(inner))
			.slice(0, Math.max(0, dockBudget - above.length));
		const dockRows = [
			...above.map((line) => surfaceRow(gutter(line), columns)),
			...editor.map(gutter),
			...below.map(gutter),
			this.hintRow(columns),
		];
		const activity = this.options.activity?.render(inner).slice(0, 1) ?? [];
		const head = [this.headline(columns), activity.length ? gutter(activity[0]!) : ""];
		const available = total - head.length - dockRows.length;
		const upperRows = this.collapsed ? 0 : Math.min(this.upperLimit, Math.floor((available - 4) * 0.5));
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
		return [...head, ...upper, this.divider(columns, upper.length > 0), header, ...body, ...dockRows];
	}
}
