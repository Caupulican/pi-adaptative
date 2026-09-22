import { Container, truncateToWidth } from "@caupulican/pi-tui";

/**
 * A test editor that draws its own two rules around its rows, as the real `Editor` does. The
 * Workbench adds no rules of its own around the editor, so a bare fixture would lay out two rows short.
 */
export class RuledEditor extends Container {
	lines: string[];
	constructor(lines: string[] = []) {
		super();
		this.lines = lines;
	}
	override render(width: number): string[] {
		const rule = "─".repeat(Math.max(0, width));
		return [rule, ...this.lines.map((line) => truncateToWidth(line, Math.max(0, width), "")), rule];
	}
}
