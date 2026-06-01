import { Box, type Component } from "@earendil-works/pi-tui";
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
		const lines = this.tools.flatMap((tool) =>
			tool.renderCallSummary(width).map((line) => line.replace(/[ \t]+$/g, "")),
		);
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i]?.trim()) {
				lines[i] += theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
				break;
			}
		}
		return lines;
	}

	private getBackgroundColor(): ThemeBg {
		const colors = this.tools.map((tool) => tool.getBackgroundColor());
		if (colors.includes("toolErrorBg")) return "toolErrorBg";
		if (colors.includes("toolPendingBg")) return "toolPendingBg";
		return "toolSuccessBg";
	}
}
