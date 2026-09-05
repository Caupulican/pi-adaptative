import { type Component, Container, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import { theme } from "../theme/theme.ts";
import { ActionTranscriptComponent } from "./action-transcript.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { ConversationWindow } from "./conversation-window.ts";

export interface WorkbenchOptions {
	conversation: Container;
	editor: Container;
	dock: Component[];
	viewportRows: () => number;
	/** Mounted for focus/lifecycle but not permanently reserved above the conversation. */
	header?: Component;
}

const CELL_RESET = "\x1b[0m\x1b]8;;\x1b\\";

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
	private upperLimit = 18;
	private inspectorFraction = 0.3;
	private dismissedShell?: BashExecutionComponent;
	private headerButtons: { action: "latest" | "copyAll" | "copySelection"; start: number; end: number }[] = [];
	conversationTop = 0;
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
	}
	setExecution(component: Component | undefined): void {
		this.execution = component;
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

	override render(width: number): string[] {
		// Mounted children are intentionally not rendered by Container. Publish our composed frame
		// revision so its parent cannot reuse the old flattening after pane/editor changes.
		this.frameRevision++;
		const columns = Math.max(1, width);
		const total = Math.max(1, this.options.viewportRows());
		const editor = this.options.editor.render(columns);
		// Dialogs and custom editors retain their own layout/focus. Never cut their cursor marker.
		if (editor.length >= total - 2) {
			this.conversationTop = 0;
			this.conversationHeight = 0;
			this.upperHeight = 0;
			this.headerButtons = [];
			return editor;
		}
		const dock = this.options.dock.flatMap((component) => component.render(columns));
		const dockBudget = Math.max(0, total - editor.length - 2);
		const dockLines = dockBudget > 0 ? dock.slice(-dockBudget) : [];
		const available = Math.max(1, total - editor.length - dockLines.length - 1);
		const upperBudget = Math.min(this.upperLimit, Math.max(0, available - Math.max(4, Math.ceil(available * 0.35))));
		const inspectorWidth = Math.max(1, Math.floor(columns * this.inspectorFraction));
		const inspectorLines = Array.isArray(this.inspector) ? this.inspector : this.inspector.render(inspectorWidth);
		const split = columns >= 64 && inspectorLines.length > 1;
		const leftWidth = split ? Math.floor(columns * this.inspectorFraction) : 0;
		const shell = this.options.conversation.children.findLast(
			(child): child is BashExecutionComponent => child instanceof BashExecutionComponent,
		);
		const executionSource = shell && shell !== this.dismissedShell ? shell.getWorkbenchPreview() : this.execution;
		const execution = executionSource?.render(Math.max(1, columns - (leftWidth ? leftWidth + 2 : 0))) ?? [];
		let upper: string[];
		if (split && execution.length) {
			const count = Math.min(upperBudget, Math.max(inspectorLines.length, execution.length));
			upper = Array.from(
				{ length: count },
				(_, row) =>
					truncateToWidth(inspectorLines[row] ?? "", leftWidth, "", true) +
					CELL_RESET +
					"  " +
					truncateToWidth(execution[row] ?? "", columns - leftWidth - 2, "") +
					CELL_RESET,
			);
		} else {
			const fullInspector = Array.isArray(this.inspector) ? this.inspector : this.inspector.render(columns);
			const inspector = fullInspector.length > 1 && execution.length ? fullInspector.slice(0, 1) : fullInspector;
			upper = [...inspector, ...execution].slice(0, upperBudget);
		}
		this.upperHeight = upper.length;
		this.conversationTop = upper.length + 1;
		this.conversationHeight = available - upper.length;
		const state = this.conversation.following ? "live" : "reading";
		let heading = theme.fg("accent", ` Conversation · ${state}`);
		this.headerButtons = [];
		for (const [action, label] of [
			["latest", "Latest"],
			["copyAll", "Copy all"],
			["copySelection", "Copy selection"],
		] as const) {
			const start = visibleWidth(heading) + 2;
			const end = start + label.length + 2;
			if (end > columns) break;
			this.headerButtons.push({ action, start, end });
			heading += theme.fg("dim", `  [${label}]`);
		}
		const conversation = this.conversation.render(columns, this.conversationHeight);
		const padding = Array.from({ length: Math.max(0, this.conversationHeight - conversation.length) }, () => "");
		return [...upper, heading, ...conversation, ...padding, ...dockLines, ...editor].map((line) =>
			truncateToWidth(line, columns, ""),
		);
	}
}
