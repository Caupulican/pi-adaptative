import { type Component, Container, visibleWidth } from "@caupulican/pi-tui";
import { ActionTranscriptComponent } from "./action-transcript.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { ConversationWindow } from "./conversation-window.ts";
import { framePane, WorkbenchPane } from "./workbench-pane.ts";

export interface WorkbenchOptions {
	conversation: Container;
	editor: Container;
	dock: Component[];
	viewportRows: () => number;
	/** Mounted for focus/lifecycle but not permanently reserved above the conversation. */
	header?: Component;
}

/** Human-facing composition only. The original transcript still owns all messages and actions. */
export class WorkbenchComponent extends Container {
	private frameRevision = 0;
	override get renderRevision(): number {
		return this.frameRevision;
	}
	readonly conversation: ConversationWindow;
	private readonly options: WorkbenchOptions;
	private inspector: string[] | Component = [];
	private execution?: Component;
	private executionEvidence?: Component;
	private displayedShell?: BashExecutionComponent;
	private upperLimit = 8;
	private executionCompact = false;
	private readonly inspectorPane = new WorkbenchPane();
	private readonly executionPane = new WorkbenchPane();
	private inspectorFraction = 0.3;
	private dismissedShell?: BashExecutionComponent;
	private headerButtons: { action: "latest" | "copyAll" | "copySelection"; start: number; end: number }[] = [];
	conversationTop = 0;
	conversationLeft = 1;
	conversationWidth = 0;
	conversationHeight = 0;
	upperHeight = 0;

	constructor(options: WorkbenchOptions) {
		super();
		this.options = options;
		for (const child of [options.header, options.conversation, ...options.dock, options.editor]) {
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

	setInspector(content: string[] | Component): void {
		this.inspector = content;
		if (Array.isArray(content) && !content.length) this.inspectorPane.reset();
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
	resizeUpper(rows: number): void {
		this.upperLimit = Math.max(1, Math.min(60, rows));
	}
	resizeInspector(fraction: number): void {
		this.inspectorFraction = Math.max(0.2, Math.min(0.45, fraction));
	}
	headerAction(column: number): "latest" | "copyAll" | "copySelection" | undefined {
		return this.headerButtons.find((button) => column >= button.start && column < button.end)?.action;
	}

	override invalidate(): void {
		super.invalidate();
		this.conversation.invalidate();
		this.execution?.invalidate();
		if (!Array.isArray(this.inspector)) this.inspector.invalidate();
	}

	private renderUpper(columns: number, budget: number): string[] {
		this.inspectorPane.hide();
		this.executionPane.hide();
		if (budget < 3) return [];
		const inner = Math.max(1, columns - 2);
		const inspector = Array.isArray(this.inspector) ? this.inspector : this.inspector.render(inner);
		const shell = this.options.conversation.children.findLast(
			(child): child is BashExecutionComponent => child instanceof BashExecutionComponent,
		);
		const visibleShell = shell && shell !== this.dismissedShell ? shell : undefined;
		if (visibleShell !== this.displayedShell) this.executionPane.reset();
		this.displayedShell = visibleShell;
		const executionSource = visibleShell ? visibleShell.getWorkbenchPreview() : this.execution;
		if (!inspector.length && !executionSource) return [];
		const compact =
			inspector.length <= 1 && (!executionSource || (executionSource === this.execution && this.executionCompact));
		const height = compact ? 3 : budget;
		const both = inspector.length > 0 && executionSource;
		if (both && columns >= 64) {
			const leftWidth = Math.floor(columns * this.inspectorFraction);
			const left = this.inspectorPane.render(
				"Work / Team",
				Array.isArray(this.inspector) ? this.inspector : this.inspector.render(leftWidth - 2),
				0,
				0,
				leftWidth,
				height,
			);
			const right = this.executionPane.render(
				"Execution",
				executionSource.render(columns - leftWidth - 2),
				leftWidth,
				0,
				columns - leftWidth,
				height,
			);
			return left.map((line, row) => line + right[row]);
		}
		if (both && height >= 6) {
			const leftHeight = Math.max(3, Math.floor(height / 2));
			return [
				...this.inspectorPane.render("Work / Team", inspector, 0, 0, columns, leftHeight),
				...this.executionPane.render(
					"Execution",
					executionSource.render(inner),
					0,
					leftHeight,
					columns,
					height - leftHeight,
				),
			];
		}
		if (both)
			return this.executionPane.render(
				"Work / Execution",
				[...executionSource.render(inner), ...inspector],
				0,
				0,
				columns,
				height,
			);
		return inspector.length
			? this.inspectorPane.render("Work / Team", inspector, 0, 0, columns, height)
			: this.executionPane.render("Execution", executionSource?.render(inner) ?? [], 0, 0, columns, height);
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
		// Tiny terminals cannot afford borders. Keep native input/status bottom-anchored;
		// oversized dialogs retain their complete cursor-bearing output, never a sliced editor.
		if (columns < 4 || editor.length >= total - 5) {
			this.conversationTop = this.conversationHeight = this.conversationWidth = this.upperHeight = 0;
			const nativeEditor = this.options.editor.render(columns);
			const remaining = Math.max(0, total - nativeEditor.length);
			const dock = remaining
				? this.options.dock.flatMap((component) => component.render(columns)).slice(-remaining)
				: [];
			return [...Array.from({ length: remaining - dock.length }, () => ""), ...dock, ...nativeEditor];
		}
		const dock = this.options.dock.flatMap((component) => component.render(inner));
		const dockBudget = Math.max(0, total - editor.length - 6);
		const dockLines = dockBudget > 0 ? dock.slice(-dockBudget) : [];
		const dockHeight = dockLines.length || editor.length ? dockLines.length + editor.length + 2 : 0;
		const available = total - dockHeight;
		// Output length cannot move the conversation boundary. Only pane lifecycle/resize can.
		const upper = this.renderUpper(columns, Math.min(this.upperLimit, Math.floor((available - 2) * 0.3)));
		this.upperHeight = upper.length;
		this.conversationTop = upper.length + 1;
		this.conversationWidth = Math.max(0, columns - 2);
		this.conversationHeight = Math.max(0, available - upper.length - 2);
		const state = this.conversation.following ? "live" : "reading";
		let heading = `Conversation · ${state}`;
		for (const [action, label] of [
			["latest", "Latest"],
			["copyAll", "Copy all"],
			["copySelection", "Copy selection"],
		] as const) {
			const start = 2 + visibleWidth(heading) + 2;
			const end = start + label.length + 2;
			if (end > columns - 2) break;
			this.headerButtons.push({ action, start, end });
			heading += `  [${label}]`;
		}
		return [
			...upper,
			...framePane(
				heading,
				this.conversation.render(inner, this.conversationHeight),
				columns,
				this.conversationHeight + 2,
			),
			...framePane("Input / Status", [...dockLines, ...editor], columns, dockHeight),
		];
	}
}
