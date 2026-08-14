import { Box, type Component, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import { shortenPath } from "../../../core/tools/render-utils.ts";
import { type ThemeBg, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

const COLLAPSED_FILE_SNIPPET = 3;

/** Human nouns for collapsed group headers. Keys are toolGroup ids, not raw tool names. */
const GROUP_NOUNS: Record<string, { singular: string; plural: string }> = {
	task_steps: { singular: "Task Step", plural: "Task Steps" },
	skills: { singular: "Skill", plural: "Skills" },
	delegate: { singular: "Worker", plural: "Workers" },
	explore: { singular: "Search", plural: "Searches" },
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function humanizeGroupKey(raw: string): { singular: string; plural: string } {
	const words = raw
		.replace(/[_-]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
	const last = words.at(-1) ?? "Tool";
	const lastSingular = last.endsWith("s") && last.length > 1 ? last.slice(0, -1) : last;
	const lastPlural = last.endsWith("s") ? last : `${last}s`;
	return {
		singular: [...words.slice(0, -1), lastSingular].join(" "),
		plural: [...words.slice(0, -1), lastPlural].join(" "),
	};
}

function groupNoun(groupKey: string, tools: readonly ToolExecutionComponent[]): { singular: string; plural: string } {
	const mapped = GROUP_NOUNS[groupKey];
	if (mapped) return mapped;
	const labels = [...new Set(tools.map((tool) => tool.getDisplayLabel()).filter((label) => label.length > 0))];
	if (labels.length === 1) return humanizeGroupKey(labels[0]);
	if (groupKey) return humanizeGroupKey(groupKey);
	return { singular: "Tool", plural: "Tools" };
}

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

		const collapsed = this.renderCollapsed(safeWidth);
		if (collapsed.length === 0) return [];
		const box = new Box(1, 1, (text) => theme.bg(this.getBackgroundColor(), text));
		box.addChild({ render: (contentWidth) => this.renderCollapsed(contentWidth), invalidate: () => {} });
		return [" ".repeat(safeWidth), ...box.render(safeWidth)];
	}

	private renderCollapsed(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = [this.formatCountLine(), ...this.formatFileSnippet(), ...this.formatLastAction()].filter(
			(line) => line.trim().length > 0,
		);
		if (lines.length === 0) return [];
		lines[lines.length - 1] = this.appendExpandHint(lines[lines.length - 1], safeWidth);
		return lines.map((line) => truncateToWidth(line, safeWidth, "..."));
	}

	private formatCountLine(): string {
		const editCount = this.tools.filter((tool) => tool.getToolName() === "edit").length;
		const writeCount = this.tools.filter((tool) => tool.getToolName() === "write").length;
		const errorCount = this.tools.filter((tool) => tool.isToolError()).length;
		const files = this.uniqueFiles();
		const parts: string[] = [];
		if (editCount > 0) parts.push(plural(editCount, "edit"));
		if (writeCount > 0) parts.push(plural(writeCount, "write"));
		if (parts.length === 0) {
			const noun = groupNoun(this.toolGroup, this.tools);
			parts.push(plural(this.tools.length, noun.singular, noun.plural));
		}
		if (files.length > 0) parts.push(plural(files.length, "file"));
		if (errorCount > 0) parts.push(plural(errorCount, "error"));
		return theme.bold(parts.join(" · "));
	}

	private formatFileSnippet(): string[] {
		const files = this.uniqueFiles();
		if (files.length === 0) return [];
		const shown = files.slice(0, COLLAPSED_FILE_SNIPPET);
		const extra = files.length - shown.length;
		const list = shown.join(", ") + (extra > 0 ? `, +${extra}` : "");
		return [theme.fg("dim", list)];
	}

	private formatLastAction(): string[] {
		const last = [...this.tools].reverse().find((tool) => tool.isToolSuccess()) ?? this.tools[this.tools.length - 1];
		if (!last) return [];
		const path = last.getDisplayPath();
		const name = last.getDisplayLabel();
		const label = path ? `${name} ${shortenPath(path)}` : name;
		return [`${theme.fg("dim", "last: ")}${label}`];
	}

	private uniqueFiles(): string[] {
		const seen = new Set<string>();
		const files: string[] = [];
		for (const tool of this.tools) {
			const path = tool.getDisplayPath();
			if (!path) continue;
			const display = shortenPath(path);
			if (seen.has(display)) continue;
			seen.add(display);
			files.push(display);
		}
		return files;
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
