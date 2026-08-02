import type { Component } from "../tui.ts";
import { wrapTextWithAnsi } from "../utils.ts";
import { CachedTextComponent, frameTextLines } from "./text-layout.ts";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text extends CachedTextComponent implements Component {
	private customBgFn?: (text: string) => string;

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		super(text, paddingX, paddingY);
		this.customBgFn = customBgFn;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.customBgFn = customBgFn;
		this.renderState.invalidate();
	}

	render(width: number): string[] {
		const start = this.renderState.begin(this.text, width, this.paddingX);
		if (start.kind === "complete") return start.lines;

		// Wrap text (this preserves ANSI codes but does NOT pad)
		const wrappedLines = wrapTextWithAnsi(start.prepared.normalizedText, start.prepared.contentWidth);
		const result = frameTextLines(wrappedLines, {
			width,
			paddingX: this.paddingX,
			paddingY: this.paddingY,
			background: this.customBgFn,
		});
		return this.renderState.finish(this.text, width, result);
	}
}
