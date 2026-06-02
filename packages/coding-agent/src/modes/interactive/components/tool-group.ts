import { Box, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeBg, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

export class ToolGroupComponent implements Component {
	readonly toolGroup: string;
	private readonly tools: ToolExecutionComponent[] = [];
	private expanded = false;

	constructor(toolGroup: string, tools: ToolExecutionComponent[] = []) {
		this.toolGroup = toolGroup;
		for (const tool of tools) this.addTool(tool);
	}

	addTool(tool: ToolExecutionComponent): void {
		tool.setExpanded(this.expanded);
		this.tools.push(tool);
	}

	removeTool(tool: ToolExecutionComponent): boolean {
		const index = this.tools.indexOf(tool);
		if (index === -1) return false;
		this.tools.splice(index, 1);
		return true;
	}

	getToolCount(): number {
		return this.tools.length;
	}

	getOnlyTool(): ToolExecutionComponent | undefined {
		return this.tools.length === 1 ? this.tools[0] : undefined;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const tool of this.tools) tool.setExpanded(expanded);
	}

	setShowImages(show: boolean): void {
		for (const tool of this.tools) tool.setShowImages(show);
	}

	setImageWidthCells(width: number): void {
		for (const tool of this.tools) tool.setImageWidthCells(width);
	}

	invalidate(): void {
		for (const tool of this.tools) tool.invalidate();
	}

	render(width: number): string[] {
		if (this.tools.length === 0) return [];
		const safeWidth = Math.max(1, width);
		if (this.expanded) return this.tools.flatMap((tool) => tool.render(safeWidth));

		const box = new Box(1, 1, (text) => theme.bg(this.getBackgroundColor(), text));
		box.addChild({ render: (contentWidth) => this.renderCollapsed(contentWidth), invalidate: () => {} });
		return [" ".repeat(safeWidth), ...box.render(safeWidth)];
	}

	private renderCollapsed(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = this.tools.flatMap((tool) =>
			tool.renderCallSummary(safeWidth).map((line) => line.replace(/[ \t]+$/g, "")),
		);
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i]?.trim()) {
				lines[i] = this.appendExpandHint(lines[i], safeWidth);
				break;
			}
		}
		return lines.map((line) => truncateToWidth(line, safeWidth, "..."));
	}

	private appendExpandHint(line: string, width: number): string {
		const hint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
		const hintWidth = visibleWidth(hint);
		if (hintWidth >= width) return truncateToWidth(hint, width, "...");
		return truncateToWidth(line, width - hintWidth, "") + hint;
	}

	private getBackgroundColor(): ThemeBg {
		const colors = this.tools.map((tool) => tool.getBackgroundColor());
		if (colors.includes("toolErrorBg")) return "toolErrorBg";
		if (colors.includes("toolPendingBg")) return "toolPendingBg";
		return "toolSuccessBg";
	}
}
