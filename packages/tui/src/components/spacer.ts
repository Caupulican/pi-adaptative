import type { Component } from "../tui.ts";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	private lines: number;
	private revision = 0;

	constructor(lines: number = 1) {
		this.lines = lines;
	}

	get renderRevision(): number {
		return this.revision;
	}

	setLines(lines: number): void {
		if (this.lines !== lines) {
			this.lines = lines;
			this.revision++;
		}
	}

	invalidate(): void {
		this.revision++;
	}

	render(_width: number): string[] {
		const result: string[] = [];
		for (let i = 0; i < this.lines; i++) {
			result.push("");
		}
		return result;
	}
}
