import { type Component, Container, hyperlink, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type {
	ActiveChatTarget,
	PersistentBotView,
	PersistentTeamRecord,
} from "../../../core/delegation/persistent-bot-team-store.ts";
import type { DecisionStage } from "../../../core/operator-projection/decision-stage-log.ts";
import type { PullRequestView } from "../../../core/pull-request-view.ts";
import {
	DEFAULT_GRAPH_FRACTION,
	MAX_GRAPH_FRACTION,
	MIN_GRAPH_FRACTION,
} from "../../../core/settings/settings-rules.ts";
import { WORKBENCH_GRAPH_VIEWS, type WorkbenchGraphView } from "../../../core/settings/settings-schema.ts";
import { keyText } from "../../../presentation/keybinding-hints.ts";
import { getSelectionStyle, theme } from "../../../presentation/theme-model.ts";
import { ActionTranscriptComponent } from "./action-transcript.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { ConversationWindow } from "./conversation-window.ts";
import { type DecisionGraphModel, graphHasContent } from "./decision-graph-model.ts";
import { DecisionGraphPane } from "./decision-graph-pane.ts";
import { FlowAnimator } from "./flow-animator.ts";
import { fitRow, labelRow, surfaceRow, WorkbenchPane, type WorkbenchPaneTitleButton } from "./workbench-pane.ts";

/** The title strip names the work; the run state lives on the live row inside the conversation zone. */
export interface WorkbenchHeadline {
	title?: string;
}

/** The model on the status line; `thinking` is absent for a model that does not reason. */
export interface WorkbenchModelStatus {
	name: string;
	thinking?: string;
}

/** One inspector block: a titled group of rows (plan steps, team members). */
export interface WorkbenchSection {
	title: string;
	meta?: string;
	body: Component | string[];
	/** Standing facts with no work in them (an idle team): listed beside real work, never a reason to open the panel. */
	quiet?: boolean;
}

export type WorkbenchHeaderButtonAction = "latest" | "layout" | "showGraph" | "switchChat";

/** What the left pane shows: the Decision graph, or the Chats & Teams roster. */
export type WorkbenchLeftPaneMode = "chats" | "graph";

/** The live facts behind the Chats & Teams roster: the active target, the Brain's state, every bot and team. */
export interface WorkbenchChatRosterSnapshot {
	readonly activeTarget: ActiveChatTarget;
	readonly rootModelLabel: string;
	readonly rootRunning: boolean;
	readonly bots: readonly PersistentBotView[];
	readonly teams: readonly PersistentTeamRecord[];
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
	/** The live conversation's name in the header, e.g. the active bot or team; "Conversation" when absent. */
	conversationTitle?: () => string;
	/** Label of the header chip that opens the Bot & Team chat switcher; absent hides the chip. */
	switchChatChip?: () => string | undefined;
	/** The Chats & Teams roster for the left pane: Brain, teams and bots. Absent, the pane offers only the Graph. */
	chatRoster?: () => WorkbenchChatRosterSnapshot | undefined;
	/** The checked-out branch, shown at the left of the status line under the input. */
	branch?: () => string | null;
	/** The current branch's pull request, shown after the branch; absent when there is none. */
	pullRequest?: () => PullRequestView | undefined;
	/** The model answering and its thinking level, shown at the right of the status line. */
	model?: () => WorkbenchModelStatus | undefined;
	viewportRows: () => number;
	/** Mounted for focus/lifecycle but not permanently reserved above the conversation. */
	header?: Component;
	/** The operator POV bar: the first row of the status band, above the editor's rules. */
	operatorStatus?: Component;
}

/** Where a vertical rule meets the divider: the glyph is composed into the rule run, never typed. */
export interface WorkbenchDividerJunction {
	readonly column: number;
	readonly glyph: "┴" | "┬" | "┼";
}

const GRAPH_VIEW_NAMES: Readonly<Record<WorkbenchGraphView, string>> = {
	list: "List",
	diagram: "Diagram",
	lanes: "Lanes",
};

const THINKING_METER_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];
const THINKING_METER_CELLS = THINKING_METER_LEVELS.length;

export const PLAN_SECTION = "Work plan";
export const TEAM_SECTION = "Team";
export const CHECKS_SECTION = "Checks";
export const EDGE_SECTION = "Edge";
const MIN_INSPECTOR_WIDTH = 24;
const SIDE_BY_SIDE_MIN_COLUMNS = 80;
export const DEFAULT_INSPECTOR_FRACTION = 0.3;
export const MIN_INSPECTOR_FRACTION = 0.2;
export const MAX_INSPECTOR_FRACTION = 0.45;
export const DEFAULT_CONVERSATION_FRACTION = 0.5;
export const MIN_CONVERSATION_FRACTION = 0.3;
export const MAX_CONVERSATION_FRACTION = 0.7;
/** Until the operator resizes, the work area takes this share of the rows and the conversation keeps the rest. */
export const AUTO_WORK_AREA_SHARE = 0.35;
export const DEFAULT_UPPER_ROWS: WorkAreaRows = "auto";
/** The conversation never drops below this many rows, whatever the operator gives the work area. */
export const MIN_CONVERSATION_ROWS = 6;
export const MAX_UPPER_ROWS = 60;
/** The diagram's node block plus the pane's gutters; below this the drawing would clip, so the graph folds. */
export const MIN_GRAPH_WIDTH = 48;
/** The chat keeps a readable measure: the graph folds before the conversation is squeezed under this many columns. */
export const MIN_CHAT_WIDTH = 60;
/** The Chats & Teams roster keeps its names and state glyphs readable at this many columns. */
export const MIN_CHAT_ROSTER_WIDTH = 26;

/** Explicit rows the operator chose, or "auto": a proportional split that follows the terminal's height. */
export type WorkAreaRows = number | "auto";

/** Everything the operator owns about the work area; persisted as-is across sessions. */
export type WorkbenchHit =
	| "conversation"
	| "conversationHeader"
	| "divider"
	| "split"
	| "columnSplit"
	| "graph"
	| "graphTitle"
	| "graphSplit"
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
	graph?: "shown" | "hidden";
	graphFraction?: number;
	graphView?: WorkbenchGraphView;
}

/** One-cell left gutter; rows that already fit skip the grapheme scan (the width lookup is cached per string). */
function gutter(line: string, inner: number): string {
	return line ? ` ${visibleWidth(line) <= inner ? line : truncateToWidth(line, inner, "")}` : "";
}

export function clampUpperRows(rows: number): number {
	return Math.max(2, Math.min(MAX_UPPER_ROWS, Math.floor(rows)));
}

/** The proportional split for a given budget: the work area's share of what is left after the divider and the header. */
export function autoWorkAreaRows(available: number): number {
	return Math.max(0, Math.floor((available - 2) * AUTO_WORK_AREA_SHARE));
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
	const rows = geometry.rows === "auto" ? autoWorkAreaRows(available) : geometry.rows;
	return geometry.executionMaximized ? cap : Math.min(rows, cap);
}

/**
 * Human-facing composition only. The original transcript still owns all messages and actions.
 *
 * Rows, top to bottom: title strip, live activity, the work area (inspector left, execution right)
 * at a fixed height unless the operator collapses it, its divider, conversation header, conversation
 * rows, the status band, input, rows below the input and the status line. Zones separate by surface tone
 * and spacing, never by frames. Only the operator changes the work area's size or visibility.
 */
export class WorkbenchComponent extends Container {
	private frameRevision = 0;
	override get renderRevision(): number {
		return this.frameRevision;
	}
	readonly conversation: ConversationWindow;
	private readonly options: WorkbenchOptions;
	private operatorStatus?: Component;
	private sections: WorkbenchSection[] = [];
	private headlineState: WorkbenchHeadline = {};
	private execution?: Component;
	private executionMeta = "";
	private executionEvidence?: Component;
	private displayedShell?: BashExecutionComponent;
	private upperLimit: WorkAreaRows = DEFAULT_UPPER_ROWS;
	/** Row budget of the last frame; the automatic split resolves against it when the operator resizes. */
	private lastAvailable = 0;
	private collapsed = false;
	private inspectorHidden = false;
	private executionMaximized = false;
	private executionCompact = false;
	/** Who owns the mouse; the status line reports the terminal owning it so a silent wheel is never a mystery. */
	private mouseMode = false;
	private readonly inspectorPane = new WorkbenchPane();
	private readonly executionPane = new WorkbenchPane();
	private readonly graphPane = new DecisionGraphPane();
	/** The left pane's Chats & Teams roster; drawn in the same place as the Decision graph, one of the two at a time. */
	private readonly chatRosterPane = new WorkbenchPane();
	private leftPaneMode: WorkbenchLeftPaneMode = "chats";
	/** The roster row index → the chat target it selects; aligned with the rows the roster drew this frame. */
	private chatTargetsByRow: readonly (ActiveChatTarget | undefined)[] = [];
	/** What the left pane drew this frame; undefined while folded or hidden. */
	private leftPaneKind?: WorkbenchLeftPaneMode;
	/** Composes the Decision graph's model per frame; unset, the zone is chat only. */
	private graphSource?: () => DecisionGraphModel | undefined;
	/** This frame's graph model: composed once, and only when the graph is wanted and has something to show. */
	private frameGraphModel?: DecisionGraphModel;
	/** This frame's chat roster: composed once per frame when the left pane is shown. */
	private frameChatRoster?: WorkbenchChatRosterSnapshot;
	/** Told after every frame whether the drawn graph carries a running clock (the lane's ticker). */
	private graphClock?: (running: boolean) => void;
	/** The one timer that moves the flow views' carriers; present while the graph has a render trigger. */
	private graphAnimator?: FlowAnimator;
	/** The conversation zone of the last frame; the graph gutter drag resolves against it. */
	private zoneLeft = 0;
	private zoneWidth = 0;
	private inspectorFraction = DEFAULT_INSPECTOR_FRACTION;
	private conversationFraction = DEFAULT_CONVERSATION_FRACTION;
	private graphHidden = false;
	private graphFraction = DEFAULT_GRAPH_FRACTION;
	private graphView: WorkbenchGraphView = "diagram";
	private columns = false;
	private lastColumns = 0;
	private workLeft = 0;
	private workWidth = 0;
	private dismissedShell?: BashExecutionComponent;
	private readonly frameExecutionLines = new Map<string, string[]>();
	private headerButtons: { action: WorkbenchHeaderButtonAction; start: number; end: number }[] = [];
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
	/** Column of the inspector | Execution rule; -1 when the panes are not side by side. */
	private paneRuleColumn = -1;
	/** Column of the Decision graph | chat rule; -1 while the graph is folded or hidden. */
	private graphRuleColumn = -1;
	/** Key labels resolve once; the keybinding manager is static after startup. */
	setMouseMode(enabled: boolean): void {
		this.mouseMode = enabled;
	}

	constructor(options: WorkbenchOptions) {
		super();
		this.options = options;
		this.operatorStatus = options.operatorStatus;
		for (const child of [
			options.header,
			options.operatorStatus,
			options.conversation,
			options.activity,
			...options.dock,
			options.editor,
			...(options.dockBelow ?? []),
		]) {
			if (child) this.addChild(child);
		}
		this.conversation = new ConversationWindow(
			() => [
				...(options.header ? [options.header] : []),
				...options.conversation.children.flatMap((child) =>
					child instanceof ActionTranscriptComponent
						? [...child.conversationComponents()]
						: child instanceof BashExecutionComponent
							? []
							: [child],
				),
			],
			undefined,
			getSelectionStyle,
		);
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
		// Work starting opens the plan even for an operator who hid it during earlier work; hiding holds until the next start.
		if (!this.sections.some((section) => !section.quiet) && sections.some((section) => !section.quiet)) {
			this.inspectorHidden = false;
		}
		this.sections = sections;
		if (!sections.length) this.inspectorPane.reset();
	}
	setHeadline(headline: WorkbenchHeadline): void {
		this.headlineState = headline;
	}
	setOperatorStatus(component: Component | undefined): void {
		if (this.operatorStatus === component) return;
		if (this.operatorStatus) this.removeChild(this.operatorStatus);
		this.operatorStatus = component;
		if (component) this.addChild(component);
		this.frameRevision++;
	}
	getOperatorStatus(): Component | undefined {
		return this.operatorStatus;
	}
	setExecution(component: Component | undefined, compact = false, evidence = component, meta = ""): void {
		this.frameExecutionLines.clear();
		if (evidence !== this.executionEvidence || compact !== this.executionCompact) this.executionPane.reset();
		this.execution = component;
		this.executionEvidence = evidence;
		this.executionCompact = compact;
		this.executionMeta = meta;
	}
	/** The Execution content row under a pointer, or undefined outside the pane's content. */
	executionRowAt(column: number, row: number): number | undefined {
		return this.executionPane.rowAt(column, row);
	}
	scrollUpper(column: number, row: number, delta: number): boolean {
		return this.inspectorPane.scrollAt(column, row, delta) || this.executionPane.scrollAt(column, row, delta);
	}
	/** The Decision graph's model source; the pane draws whatever it returns each frame. */
	setDecisionGraph(
		source: (() => DecisionGraphModel | undefined) | undefined,
		clock?: (running: boolean) => void,
		requestRender?: () => void,
	): void {
		this.graphSource = source;
		this.graphClock = clock;
		this.graphAnimator?.dispose();
		this.graphAnimator = source && requestRender ? new FlowAnimator({ requestRender }) : undefined;
		if (!source) {
			this.graphPane.reset();
			clock?.(false);
		}
	}
	/** Stops the carrier timer; the controller calls it when the workbench is disposed. */
	disposeGraphMotion(): void {
		this.graphAnimator?.dispose();
	}
	/** Whether the Decision graph is shown (drawn in the current/last frame, or active at the current zone width with content). */
	get graphShown(): boolean {
		if (this.graphRuleColumn >= 0) return this.leftPaneKind === "graph";
		const zoneWidth = this.zoneWidth > 0 ? this.zoneWidth : this.lastColumns > 0 ? this.lastColumns : 120;
		return (
			this.frameGraphModel !== undefined &&
			this.effectiveLeftPaneMode() === "graph" &&
			this.resolvedGraphWidth(zoneWidth) > 0
		);
	}
	scrollGraph(column: number, row: number, delta: number): boolean {
		return this.graphPane.scrollAt(column, row, delta) || this.chatRosterPane.scrollAt(column, row, delta);
	}
	/** The stage under a pointer on the Decision graph, for click-to-expand. */
	graphStageAt(column: number, row: number): DecisionStage | undefined {
		return this.graphPane.stageAtPoint(column, row);
	}
	/** The chat target under a pointer on the Chats & Teams roster; undefined while the roster is not the left pane. */
	chatTargetAt(column: number, row: number): ActiveChatTarget | undefined {
		if (this.effectiveLeftPaneMode() !== "chats") return undefined;
		const index = this.chatRosterPane.rowAt(column, row);
		return index !== undefined ? this.chatTargetsByRow[index] : undefined;
	}

	/** Open or close a stage's detail; the detail is drawn by the List view, so a click switches to it. */
	toggleGraphStage(stage: DecisionStage): void {
		this.graphPane.toggleStage(stage);
		if (this.graphPane.getSelectedStage() !== undefined) this.graphView = "list";
	}
	/** Pointer column on the graph | chat gutter: the graph's share of the conversation zone. */
	resizeGraphFromPointer(column: number): void {
		if (this.zoneWidth <= 0) return;
		this.resizeGraph((column - this.zoneLeft) / this.zoneWidth);
	}
	/** Page the Execution pane from the keyboard; paging to the end resumes following new evidence. */
	pageExecution(direction: number): boolean {
		return this.executionPane.pageBy(direction);
	}
	dismissUserShell(): void {
		this.frameExecutionLines.clear();
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
			graph: this.graphHidden ? "hidden" : "shown",
			graphFraction: this.graphFraction,
			graphView: this.graphView,
		};
	}
	applyGeometry(geometry: WorkbenchGeometry): void {
		this.upperLimit = geometry.rows === "auto" ? "auto" : clampUpperRows(geometry.rows);
		this.collapsed = geometry.collapsed;
		this.inspectorHidden = geometry.inspector === "hidden";
		this.executionMaximized = geometry.executionMaximized;
		if (geometry.inspectorFraction !== undefined) this.resizeInspector(geometry.inspectorFraction);
		if (geometry.layout !== undefined) this.columns = geometry.layout === "columns";
		if (geometry.conversationFraction !== undefined) this.resizeConversation(geometry.conversationFraction);
		if (geometry.graph !== undefined) this.graphHidden = geometry.graph === "hidden";
		if (geometry.graphFraction !== undefined) this.resizeGraph(geometry.graphFraction);
		if (geometry.graphView !== undefined) this.graphView = geometry.graphView;
	}
	/** Hide or show the Decision graph beside the conversation. */
	toggleGraph(): void {
		this.graphHidden = !this.graphHidden;
	}
	cycleGraphView(): void {
		// The view list's order, wrapping: List → Diagram → Lanes → List.
		this.graphView =
			WORKBENCH_GRAPH_VIEWS[(WORKBENCH_GRAPH_VIEWS.indexOf(this.graphView) + 1) % WORKBENCH_GRAPH_VIEWS.length]!;
	}
	followCurrentGraph(): void {
		this.graphPane.unpin();
	}
	resizeGraph(fraction: number): void {
		this.graphFraction = Math.max(MIN_GRAPH_FRACTION, Math.min(MAX_GRAPH_FRACTION, fraction));
	}
	resizeUpper(rows: number): void {
		this.upperLimit = clampUpperRows(rows);
	}
	/** The rows the work area has now: the operator's number, or the even split of the last frame. */
	private currentUpperRows(): number {
		return this.upperLimit === "auto" ? autoWorkAreaRows(this.lastAvailable) : this.upperLimit;
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
			if (this.graphPane.containsTitle(column, row)) return this.graphPane.titleAction(column);
			if (this.chatRosterPane.containsTitle(column, row)) return this.chatRosterPane.titleAction(column);
			return undefined;
		}
		return (
			this.inspectorPane.titleAction(column) ??
			this.executionPane.titleAction(column) ??
			this.graphPane.titleAction(column)
		);
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
		// One chip: the columns layout lives on its key and on the conversation header's Stacked chip.
		if (!this.columns) {
			buttons.push({ action: "maximize", label: this.executionMaximized ? "Restore" : "Maximize" });
		}
		return buttons;
	}
	/**
	 * The graph pane's title controls: a chevron that folds the pane, and one pill naming the current view
	 * that steps List → Diagram → Lanes on click (as alt+l does). Only the active view is drawn.
	 */
	private graphTitleButtons(): WorkbenchPaneTitleButton[] {
		// One fixed width for every view, so the pill never moves under the pointer as it steps.
		const width = Math.max(...WORKBENCH_GRAPH_VIEWS.map((view) => GRAPH_VIEW_NAMES[view].length));
		const name = GRAPH_VIEW_NAMES[this.graphView];
		const left = Math.floor((width - name.length) / 2);
		const label = `${" ".repeat(left)}${name}${" ".repeat(width - name.length - left)}`;
		const buttons: WorkbenchPaneTitleButton[] = [{ action: "hideGraph", label: "▾", leading: true }];
		if (this.graphPane.isPinned() || this.graphPane.hasNewerProgress()) {
			buttons.push({ action: "followCurrent", label: "Follow current" });
		}
		if (this.frameChatRoster !== undefined) {
			buttons.push({ action: "toggleLeftPaneMode", label: "Chats", raised: true });
		}
		buttons.push({ action: "graphCycle", label, raised: true });
		return buttons;
	}
	headerAction(column: number): WorkbenchHeaderButtonAction | undefined {
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
		if (this.graphPane.containsTitle(column, row) || this.chatRosterPane.containsTitle(column, row)) {
			return "graphTitle";
		}
		if (
			this.graphRuleColumn >= 0 &&
			row >= this.conversationTop - 1 &&
			row < this.conversationTop + this.conversationHeight &&
			Math.abs(column - this.graphRuleColumn) <= 1
		) {
			return "graphSplit";
		}
		if (this.graphPane.rowAt(column, row) !== undefined || this.chatRosterPane.rowAt(column, row) !== undefined) {
			return "graph";
		}
		if (
			row === this.conversationTop - 1 &&
			column >= this.conversationLeft - 1 &&
			(this.columnSplitStart < 0 || column < this.columnSplitStart)
		) {
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
		this.frameExecutionLines.clear();
		this.conversation.invalidate();
		this.execution?.invalidate();
		this.options.activity?.invalidate();
		for (const section of this.sections) if (!Array.isArray(section.body)) section.body.invalidate();
	}

	/**
	 * The work's name; the application and the location are on the terminal title and the status line. State belongs to the live row,
	 * where the answer lands.
	 */
	private headline(columns: number): string {
		const inner = Math.max(0, columns - 2);
		const fallback = this.options.title?.() ?? "";
		const title = this.headlineState.title || (fallback === this.options.brand ? "" : fallback);
		// The application's own name is already on the terminal's title; the row names the work, or stays empty.
		return title ? ` ${truncateToWidth(theme.bold(theme.fg("text", title)), inner, "…")} ` : "";
	}

	private conversationHeader(columns: number, originX = 0): string {
		const inner = Math.max(0, columns - 2);
		const following = this.conversation.following;
		const stateText = following ? " · Following latest" : " · Reading";
		const convTitle = this.options.conversationTitle?.() || "Conversation";
		const heading = theme.bold(theme.fg("text", convTitle)) + theme.fg("muted", stateText);
		const headingWidth = visibleWidth(convTitle) + stateText.length;
		const canShowLeftPane =
			this.graphHidden &&
			this.zoneWidth >= SIDE_BY_SIDE_MIN_COLUMNS &&
			(Boolean(this.graphSource) || Boolean(this.options.chatRoster));
		const switchChatLabel = this.options.switchChatChip?.();
		const buttons: { action: WorkbenchHeaderButtonAction; label: string }[] = [
			...(switchChatLabel ? [{ action: "switchChat" as const, label: switchChatLabel }] : []),
			...(this.columns ? [{ action: "layout" as const, label: "Stacked" }] : []),
			...(canShowLeftPane
				? [
						{
							action: "showGraph" as const,
							label: this.leftPaneMode === "chats" ? "Show chats" : "Show graph",
						},
					]
				: []),
			...(following ? [] : [{ action: "latest" as const, label: "Latest ↓" }]),
		];
		const chipTone = this.mouseMode ? "accent" : "muted";
		for (let count = buttons.length; count >= 0; count--) {
			const shown = buttons.slice(0, count);
			const widths = shown.map((button) => visibleWidth(button.label) + 2);
			const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, shown.length - 1) * 2;
			if (headingWidth + (shown.length ? 2 : 0) + total > inner) continue;
			let column = originX + 1 + inner - total;
			const parts: string[] = [];
			shown.forEach((button, index) => {
				this.headerButtons.push({ action: button.action, start: column, end: column + widths[index]! });
				parts.push(theme.bg("workbenchSurface", theme.fg(chipTone, ` ${button.label} `)));
				column += widths[index]! + 2;
			});
			return ` ${heading}${" ".repeat(inner - headingWidth - total)}${parts.join("  ")} `;
		}
		return truncateToWidth(` ${heading}`, columns, "");
	}

	/** Where the pane rule above ends (┴) and the graph rule below starts (┬); both at one column is ┼. */
	private dividerJunctions(): WorkbenchDividerJunction[] {
		const above = this.paneRuleColumn;
		const below = this.graphRuleColumn;
		if (above >= 0 && above === below) return [{ column: above, glyph: "┼" }];
		return [
			...(above >= 0 ? [{ column: above, glyph: "┴" as const }] : []),
			...(below >= 0 ? [{ column: below, glyph: "┬" as const }] : []),
		];
	}

	/** What a collapsed work area holds: its section titles, and Execution only when it has evidence. Empty when it holds nothing. */
	private collapsedSummary(columns: number): string {
		const blocks = [
			...this.sections.map((section) => (section.meta ? `${section.title} ${section.meta}` : section.title)),
			this.hasExecutionEvidence(columns) ? "Execution" : "",
		].filter(Boolean);
		if (!blocks.length) return "";
		const toggle = keyText("app.execution.toggle");
		return [`▸ ${blocks.join(" · ")}`, toggle && `${toggle} expand`].filter(Boolean).join(" · ");
	}

	/** Expanded: a drag handle and nothing else; the editor's placeholder and `?` carry the keys. Collapsed: the summary, or a bare rule when there is nothing to name. */
	private divider(columns: number, expanded: boolean, junctions: readonly WorkbenchDividerJunction[]): string {
		const summary = expanded ? "↕" : this.collapsedSummary(columns);
		const label = summary ? truncateToWidth(` ${summary} `, Math.max(0, columns - 2), "…") : "";
		const labelWidth = visibleWidth(label);
		const left = Math.max(1, Math.floor((columns - labelWidth) / 2));
		const right = Math.max(0, columns - labelWidth - left);
		// Junctions are composed into the rule runs; one that would land on the label is dropped.
		const paint = (start: number, length: number): string => {
			const cells = Array.from({ length }, () => "─");
			for (const junction of junctions) {
				const index = junction.column - start;
				if (index >= 0 && index < length) cells[index] = junction.glyph;
			}
			return theme.fg("borderMuted", cells.join(""));
		};
		const labelTone = expanded && !this.mouseMode ? "dim" : "muted";
		return truncateToWidth(
			paint(0, left) + theme.fg(labelTone, label) + paint(left + labelWidth, right),
			columns,
			"",
		);
	}

	/** The PR as `PR #123`, a link where the terminal supports links; the color says where the PR stands. */
	private pullRequestLabel(view: PullRequestView): { text: string; width: number } {
		const tone =
			view.state === "open"
				? "success"
				: view.state === "merged"
					? "syntaxType"
					: view.state === "closed"
						? "error"
						: "dim";
		const plain = `PR #${view.number}${view.state === "open" ? "" : ` ${view.state}`}`;
		return { text: theme.fg(tone, hyperlink(plain, view.url)), width: visibleWidth(plain) };
	}

	/** The thinking level as a meter that fills and warms with the level, then its name; shift+tab steps it. */
	private thinkingMeter(level: string): { text: string; width: number } {
		const index = THINKING_METER_LEVELS.indexOf(level);
		const filled = level === "off" || level === "none" ? 0 : index >= 0 ? index + 1 : THINKING_METER_CELLS;
		const tone = theme.getThinkingBorderColor(level as Parameters<typeof theme.getThinkingBorderColor>[0]);
		const pips = tone("█".repeat(filled)) + theme.fg("dim", "░".repeat(THINKING_METER_CELLS - filled));
		return { text: `${pips} ${tone(level)}`, width: THINKING_METER_CELLS + 1 + visibleWidth(level) };
	}

	/** The status line under the input: the branch and its pull request at the left, the model and its thinking at the right. */
	private statusLine(columns: number): string {
		const inner = Math.max(0, columns - 2);
		const model = this.options.model?.();
		const meter = model?.thinking ? this.thinkingMeter(model.thinking) : undefined;
		// The terminal owning the mouse is a standing fact: a wheel that does nothing in the workbench needs its reason on screen.
		const terminalMouse = "terminal mouse";
		const parts: { text: string; width: number }[] = [
			...(this.mouseMode ? [] : [{ text: theme.fg("muted", terminalMouse), width: terminalMouse.length }]),
			...(model ? [{ text: theme.fg("text", model.name), width: visibleWidth(model.name) }] : []),
			...(meter ? [meter] : []),
		];
		const right = parts.map((part) => part.text).join("  ");
		const rightWidth = parts.reduce((sum, part) => sum + part.width, 0) + Math.max(0, parts.length - 1) * 2;
		const branch = this.options.branch?.() ?? "";
		const pr = this.options.pullRequest?.();
		const pullRequest = pr ? this.pullRequestLabel(pr) : undefined;
		const leftRoom = Math.max(0, inner - rightWidth - (rightWidth ? 3 : 0));
		const prRoom = pullRequest ? pullRequest.width + 2 : 0;
		// A narrow row cuts the branch name, not the PR number or the model.
		const shownBranch = branch ? truncateToWidth(branch, Math.max(0, leftRoom - prRoom), "…") : "";
		const left = [shownBranch && theme.fg("mdLink", shownBranch), leftRoom >= prRoom ? pullRequest?.text : undefined]
			.filter(Boolean)
			.join("  ");
		const leftWidth =
			visibleWidth(shownBranch) + (shownBranch && pullRequest ? 2 : 0) + (pullRequest ? pullRequest.width : 0);
		return ` ${left}${" ".repeat(Math.max(0, inner - leftWidth - rightWidth))}${right}`;
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
		if (team || !this.graphShown) {
			lines.push("", labelRow(TEAM_SECTION, team?.meta ?? "", width), ...body(team, "No agents"));
		}
		for (const section of others)
			lines.push("", labelRow(section.title, section.meta ?? "", width), ...body(section, ""));
		return { title: PLAN_SECTION, meta: plan?.meta ?? "", lines };
	}

	/** The plan and team beside the evidence: shown when there is work to list, unless the operator hid them for this work or Execution is maximized. */
	private showsInspector(): boolean {
		return !this.inspectorHidden && !this.executionMaximized && this.sections.some((section) => !section.quiet);
	}

	private renderSourceLines(source: Component | undefined, kind: "shell" | "exec", width: number): string[] {
		if (!source) return [];
		const clamped = Math.max(1, width);
		const key = `${kind}:${clamped}`;
		const cached = this.frameExecutionLines.get(key);
		if (cached) return cached;
		const lines = source.render(clamped);
		this.frameExecutionLines.set(key, lines);
		return lines;
	}

	/** A user shell on show, or a command or file effect that renders rows: what Execution would draw. */
	private hasExecutionEvidence(columns: number): boolean {
		const shell = this.options.conversation.children.findLast(
			(child): child is BashExecutionComponent => child instanceof BashExecutionComponent,
		);
		if (shell && shell !== this.dismissedShell) return true;
		return this.renderSourceLines(this.execution, "exec", columns - 2).length > 0;
	}

	/** Neither a command or file effect nor a plan to show: the work area takes no rows and has no divider. */
	private workAreaIsEmpty(columns: number): boolean {
		return !this.showsInspector() && !this.hasExecutionEvidence(columns);
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
		const sourceKind = visibleShell ? "shell" : "exec";
		const executionLines = (width: number): string[] => this.renderSourceLines(executionSource, sourceKind, width);
		const executionMeta = visibleShell ? "" : this.executionMeta;
		const follow = Boolean(executionSource);
		const fullWidthLines = executionLines(Math.max(1, columns - 2));
		const hasExecution = fullWidthLines.length > 0;
		if (!this.showsInspector()) {
			return this.executionPane.render(
				"Execution",
				executionMeta,
				fullWidthLines,
				originX,
				top,
				columns,
				height,
				follow,
				this.executionTitleButtons(),
				this.mouseMode,
			);
		}
		if (!hasExecution) {
			// Nothing has run: the plan has the whole width instead of sitting beside an empty pane.
			const inspector = this.inspectorContent(Math.max(1, columns - 2));
			return this.inspectorPane.render(
				inspector.title,
				inspector.meta,
				inspector.lines,
				originX,
				top,
				columns,
				height,
				false,
				this.inspectorTitleButtons(),
				this.mouseMode,
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
				this.mouseMode,
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
				this.mouseMode,
			);
			// One-column rule between the panes, on every row including the titles; then one space.
			this.paneRuleColumn = originX + leftWidth;
			const rule = theme.fg("borderMuted", "│");
			return left.map((line, row) => `${line}${rule} ${right[row]}`);
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
				this.mouseMode,
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
				this.mouseMode,
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
				this.mouseMode,
			),
		];
	}

	/**
	 * The graph's width inside a conversation zone, or 0 when it folds: hidden, no source, a zone too
	 * narrow for side-by-side, or one that cannot give the graph its minimum beside a readable chat.
	 * A fold never writes the setting; the operator's fraction returns with the width.
	 */
	resolvedGraphWidth(zoneWidth: number): number {
		const mode = this.effectiveLeftPaneMode();
		if (!mode) return 0;
		const minWidth = mode === "chats" ? MIN_CHAT_ROSTER_WIDTH : MIN_GRAPH_WIDTH;
		if (zoneWidth < minWidth + 2 + MIN_CHAT_WIDTH) return 0;
		return Math.max(minWidth, Math.min(zoneWidth - 2 - MIN_CHAT_WIDTH, Math.round(zoneWidth * this.graphFraction)));
	}

	/**
	 * What the left pane shows now: the Decision graph or the Chats & Teams roster, or nothing while folded.
	 * The graph is preferred only when the operator chose it; a missing side falls back to the other.
	 */
	private effectiveLeftPaneMode(): WorkbenchLeftPaneMode | undefined {
		if (this.graphHidden) return undefined;
		const hasGraph = this.frameGraphModel !== undefined;
		if (this.leftPaneMode === "graph" && hasGraph) return "graph";
		const hasChats = (this.frameChatRoster ?? this.options.chatRoster?.()) !== undefined;
		if (this.leftPaneMode === "graph") {
			return hasChats ? "chats" : undefined;
		}
		if (hasChats) return "chats";
		return hasGraph ? "graph" : undefined;
	}

	/** The left pane's mode: the Decision graph or the Chats & Teams roster. */
	get leftSidebarMode(): WorkbenchLeftPaneMode {
		return this.leftPaneMode;
	}

	/** Flip the left pane between Chats and Graph; a folded pane opens, since neither mode draws while folded. */
	toggleLeftPaneMode(): void {
		this.leftPaneMode = this.leftPaneMode === "chats" ? "graph" : "chats";
		this.graphHidden = false;
		this.invalidate();
	}

	/**
	 * The conversation zone: its header row and `height` rows below it. With the graph shown, the
	 * Decision graph pane takes the left of every row (its title beside the conversation header) and
	 * the one-column rule between them runs from the header down; folded, the zone is the chat alone
	 * and its rows are exactly what they were before the graph existed.
	 */
	private renderZone(originX: number, zoneWidth: number, top: number, height: number): string[] {
		this.zoneLeft = originX;
		this.zoneWidth = zoneWidth;
		this.conversationTop = top + 1;
		this.conversationHeight = height;
		const graphWidth = this.resolvedGraphWidth(zoneWidth);
		const mode = graphWidth > 0 ? this.effectiveLeftPaneMode() : undefined;
		const model = mode === "graph" ? this.frameGraphModel : undefined;
		this.graphClock?.(model?.hasRunningClock === true);
		if (!mode) {
			this.leftPaneKind = undefined;
			this.graphAnimator?.settled();
			this.graphPane.hide();
			this.chatRosterPane.hide();
			this.chatTargetsByRow = [];
			const inner = Math.max(1, zoneWidth - 2);
			this.conversationLeft = originX + 1;
			this.conversationWidth = inner;
			const body = this.conversation.render(inner, height).map((line) => gutter(line, inner));
			while (body.length < height) body.push("");
			return [this.conversationHeader(zoneWidth, originX), ...body];
		}
		const rightX = graphWidth + 2;
		const rightWidth = Math.max(1, zoneWidth - rightX);
		const inner = Math.max(1, rightWidth - 2);
		this.conversationLeft = originX + rightX + 1;
		this.conversationWidth = inner;
		this.graphRuleColumn = originX + graphWidth;
		this.leftPaneKind = mode;
		let left: string[];
		if (model) {
			this.chatRosterPane.hide();
			this.chatTargetsByRow = [];
			left = this.graphPane.draw(
				model,
				this.graphView,
				originX,
				top,
				graphWidth,
				height + 1,
				this.graphTitleButtons(),
				this.graphAnimator?.enabled ?? false,
				this.mouseMode,
			);
			// The frame says whether it drew a carrier: the timer runs only while one is needed.
			const motionUntil = this.graphPane.motionUntil;
			if (motionUntil === undefined) this.graphAnimator?.settled();
			else this.graphAnimator?.request(motionUntil);
		} else {
			this.graphAnimator?.settled();
			this.graphPane.hide();
			const roster = this.frameChatRoster ?? this.options.chatRoster?.();
			if (roster) {
				left = this.drawChatRosterPane(roster, originX, top, graphWidth, height + 1);
			} else {
				this.chatRosterPane.hide();
				this.chatTargetsByRow = [];
				left = Array.from({ length: height + 1 }, () => " ".repeat(graphWidth));
			}
		}
		const body = this.conversation.render(inner, height).map((line) => gutter(line, inner));
		while (body.length < height) body.push("");
		const right = [this.conversationHeader(rightWidth, originX + rightX), ...body];
		const rule = theme.fg("borderMuted", "│");
		return left.map((line, row) => `${line}${rule} ${right[row] ?? ""}`);
	}

	/**
	 * The Chats & Teams roster: Brain, teams, then bots. Each row names the target it selects; the main line and
	 * its subtitle select the same target. Rows are drawn at the graph pane's origin so hit-testing matches.
	 */
	private drawChatRosterPane(
		roster: WorkbenchChatRosterSnapshot,
		originX: number,
		top: number,
		width: number,
		height: number,
	): string[] {
		const active = roster.activeTarget;
		const rows: string[] = [];
		const targets: (ActiveChatTarget | undefined)[] = [];
		const add = (row: string, target?: ActiveChatTarget): void => {
			rows.push(row);
			targets.push(target);
		};
		const isRoot = active.kind === "root";
		add(theme.fg("muted", " BRAIN"));
		add(
			`${isRoot ? theme.fg("accent", "▸ ") : "  "}${roster.rootRunning ? theme.fg("accent", "●") : theme.fg("success", "●")} ${isRoot ? theme.bold(theme.fg("accent", "Brain (root)")) : theme.fg("text", "Brain (root)")}`,
			{ kind: "root" },
		);
		add(`    ${theme.fg("muted", `${roster.rootModelLabel} · ${roster.rootRunning ? "working" : "ready"}`)}`, {
			kind: "root",
		});
		add(theme.fg("muted", ` TEAMS (${roster.teams.length})`));
		if (roster.teams.length === 0) add(`  ${theme.fg("dim", "No teams · /team create")}`);
		for (const team of roster.teams) {
			const isSelected = active.kind === "team" && active.teamId === team.teamId;
			const target: ActiveChatTarget = { kind: "team", teamId: team.teamId };
			const name = team.name || team.teamId;
			const unreadBadge = (team.unreadCount ?? 0) > 0 ? ` ${theme.fg("warning", `●${team.unreadCount}`)}` : "";
			add(
				`${isSelected ? theme.fg("accent", "▸ ") : "  "}${theme.fg("accent", "◆")} ${isSelected ? theme.bold(theme.fg("accent", name)) : theme.fg("text", name)} ${theme.fg("muted", `[${team.memberAgentIds.length}]`)}${unreadBadge}`,
				target,
			);
			add(`    ${theme.fg("muted", team.description || team.memberAgentIds.join(", ") || "no members")}`, target);
		}
		add(theme.fg("muted", ` BOTS (${roster.bots.length})`));
		if (roster.bots.length === 0) add(`  ${theme.fg("dim", "No bots · /bot new <id>")}`);
		for (const bot of roster.bots) {
			const isSelected = active.kind === "bot" && active.agentId === bot.agentId;
			const target: ActiveChatTarget = { kind: "bot", agentId: bot.agentId };
			const name = bot.displayName || bot.agentId;
			const glyph =
				bot.state === "running" || bot.state === "queued"
					? theme.fg("accent", "●")
					: bot.state === "awaiting_parent"
						? theme.fg("warning", "◐")
						: bot.state === "failed"
							? theme.fg("error", "✗")
							: theme.fg("muted", "○");
			const unreadBadge = (bot.unreadCount ?? 0) > 0 ? ` ${theme.fg("warning", `●${bot.unreadCount}`)}` : "";
			const scheduleBadge = (bot.routineCount ?? 0) > 0 ? ` ${theme.fg("accent", `⏱${bot.routineCount}`)}` : "";
			add(
				`${isSelected ? theme.fg("accent", "▸ ") : "  "}${glyph} ${isSelected ? theme.bold(theme.fg("accent", name)) : theme.fg("text", name)} ${theme.fg("muted", bot.modelId || bot.modelRef)}${unreadBadge}${scheduleBadge}`,
				target,
			);
			const detail = `${bot.state}${bot.teamIds.length > 0 ? ` · [${bot.teamIds.join(",")}]` : ""}${bot.currentSummary ? ` · ${bot.currentSummary}` : ""}`;
			add(`    ${theme.fg("muted", detail)}`, target);
		}
		add(`  ${theme.fg("dim", "Click row to resume · @id to msg")}`);
		this.chatTargetsByRow = targets;
		const teams = roster.teams.length;
		const bots = roster.bots.length;
		const meta = `${bots} bot${bots === 1 ? "" : "s"}${teams > 0 ? ` · ${teams} team${teams === 1 ? "" : "s"}` : ""}`;
		const actions: WorkbenchPaneTitleButton[] = [
			{ action: "hideGraph", label: "▾", leading: true },
			...(this.frameGraphModel !== undefined
				? [
						{
							action: "toggleLeftPaneMode" as const,
							label: `Graph (${GRAPH_VIEW_NAMES[this.graphView]})`,
							raised: true,
						},
					]
				: []),
			{ action: "switchChat", label: "Modal", raised: true },
		];
		return this.chatRosterPane.render(
			"Chats",
			meta,
			rows,
			originX,
			top,
			width,
			height,
			false,
			actions,
			this.mouseMode,
		);
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
		const left = this.renderZone(0, leftWidth, head.length, Math.max(0, available - 1)).map((line) =>
			fitRow(line, leftWidth),
		);
		const right = this.renderUpper(rightWidth, available, head.length, rightX);
		const main = left.map((line, row) => `${line}  ${fitRow(right[row] ?? "", rightWidth)}`);
		return [...head, ...main, liveRow, ...dockRows];
	}

	override render(width: number): string[] {
		// Publish composition changes; mounted children retain their focus/lifecycle owners.
		this.frameRevision++;
		this.inspectorPane.hide();
		this.executionPane.hide();
		this.graphPane.hide();
		this.chatRosterPane.hide();
		this.splitStart = -1;
		this.splitEnd = -1;
		this.columnSplitStart = -1;
		this.columnSplitEnd = -1;
		this.paneRuleColumn = -1;
		this.graphRuleColumn = -1;
		this.leftPaneKind = undefined;
		this.frameGraphModel = undefined;
		this.frameChatRoster = undefined;
		this.frameExecutionLines.clear();
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
		// The graph is earned like the work area: wanted (not hidden, wide enough for two panes) and with
		// something to draw. It is composed once per frame; the inspector and the zone both read it.
		if (!this.graphHidden && this.graphSource && columns >= SIDE_BY_SIDE_MIN_COLUMNS) {
			const model = this.graphSource();
			if (model && graphHasContent(model)) this.frameGraphModel = model;
		}
		if (
			!this.graphHidden &&
			columns >= SIDE_BY_SIDE_MIN_COLUMNS &&
			this.options.chatRoster &&
			(this.leftPaneMode === "chats" || this.frameGraphModel === undefined)
		) {
			this.frameChatRoster = this.options.chatRoster();
		}
		// Title strip, divider, conversation header, three conversation rows, the live row and the POV
		// row stay; the editor's rendering already carries its own two rules.
		const dockBudget = Math.max(0, total - editor.length - 8);
		const above = this.options.dock.flatMap((component) => component.render(inner)).slice(-dockBudget);
		const below = (this.options.dockBelow ?? [])
			.flatMap((component) => component.render(inner))
			.slice(0, Math.max(0, dockBudget - above.length));
		// The status band, the input and the status line are one panel on the surface tone, edge to edge and
		// without gaps, so where the conversation ends is a change of tone and not a hole. The editor draws its
		// own two rules (they carry its scroll indicators and mode colour).
		const povRows = this.operatorStatus?.render(columns - 1) ?? [];
		const dockRows = [
			...povRows.map((line) => surfaceRow(line, columns)),
			...above.map((line) => surfaceRow(gutter(line, inner), columns)),
			...editor.map((line) => surfaceRow(gutter(line, inner), columns)),
			...below.map((line) => surfaceRow(gutter(line, inner), columns)),
			surfaceRow(this.statusLine(columns), columns),
		];
		// The live row is reserved even when idle so the geometry never jumps between turns.
		const activity = this.options.activity?.render(inner).slice(0, 1) ?? [];
		const liveRow = activity.length ? gutter(activity[0]!, inner) : "";
		const head = [this.headline(columns)];
		const available = total - head.length - 1 - dockRows.length;
		this.lastAvailable = available;
		this.workLeft = 0;
		this.workWidth = columns;
		if (this.columns && columns >= SIDE_BY_SIDE_MIN_COLUMNS && !this.collapsed && available >= 2) {
			return this.renderColumns(columns, available, head, liveRow, dockRows);
		}
		if (this.workAreaIsEmpty(columns)) {
			this.upperTop = head.length;
			this.upperHeight = 0;
			this.dividerRow = -1;
			const zone = this.renderZone(0, columns, head.length, Math.max(0, available - 1));
			return [...head, ...zone, liveRow, ...dockRows];
		}
		const upperRows = workAreaRows(available, this.geometry());
		const upper = upperRows >= 2 ? this.renderUpper(columns, upperRows, head.length) : [];
		this.upperTop = head.length;
		this.upperHeight = upper.length;
		this.dividerRow = head.length + upper.length;
		const zone = this.renderZone(0, columns, this.dividerRow + 1, Math.max(0, available - upper.length - 2));
		return [
			...head,
			...upper,
			this.divider(columns, upper.length > 0, this.dividerJunctions()),
			...zone,
			liveRow,
			...dockRows,
		];
	}
}
