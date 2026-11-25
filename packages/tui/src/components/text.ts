import type { TerminalRows } from "../terminal-rows.ts";
import type { Component } from "../tui.ts";
import { wrapTextWithAnsi } from "../utils.ts";
import { CachedTextComponent, frameTextRows, type PreparedTextBlock } from "./text-layout.ts";

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

	protected layoutRows(prepared: PreparedTextBlock, width: number): TerminalRows {
		// Wrap text (this preserves ANSI codes but does NOT pad)
		const wrappedLines = wrapTextWithAnsi(prepared.normalizedText, prepared.contentWidth);
		return frameTextRows(wrappedLines, {
			width,
			paddingX: this.paddingX,
			paddingY: this.paddingY,
			background: this.customBgFn,
		});
	}
}
