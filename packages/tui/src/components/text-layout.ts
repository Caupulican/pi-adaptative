import { applyBackgroundToLine, visibleWidth } from "../utils.ts";

export interface PreparedTextBlock {
	normalizedText: string;
	contentWidth: number;
}

export interface TextFrameOptions {
	width: number;
	paddingX: number;
	paddingY: number;
	background?: (text: string) => string;
	isPassthrough?: (line: string) => boolean;
}

export class TextRenderCache {
	private text?: string;
	private width?: number;
	private lines?: string[];

	read(text: string, width: number): string[] | undefined {
		return this.lines && this.text === text && this.width === width ? this.lines.slice() : undefined;
	}

	write(text: string, width: number, lines: string[]): void {
		this.text = text;
		this.width = width;
		this.lines = lines;
	}

	clear(): void {
		this.text = undefined;
		this.width = undefined;
		this.lines = undefined;
	}
}

export type TextRenderStart = { kind: "complete"; lines: string[] } | { kind: "render"; prepared: PreparedTextBlock };

/** Owns the cache/revision lifecycle shared by terminal text components. */
export class TextRenderState {
	private cache = new TextRenderCache();
	private _revision = 0;

	get revision(): number {
		return this._revision;
	}

	invalidate(): void {
		this.cache.clear();
		this._revision++;
	}

	begin(text: string, width: number, paddingX: number): TextRenderStart {
		const cached = this.cache.read(text, width);
		if (cached) return { kind: "complete", lines: cached };
		this._revision++;

		const prepared = prepareTextBlock(text, width, paddingX);
		if (prepared) return { kind: "render", prepared };

		const lines: string[] = [];
		this.cache.write(text, width, lines);
		return { kind: "complete", lines: [] };
	}

	finish(text: string, width: number, lines: string[]): string[] {
		this.cache.write(text, width, lines);
		return lines.length > 0 ? lines.slice() : [""];
	}
}

/** Shared mutable lifecycle for cache-backed text components. */
export class CachedTextComponent {
	protected text: string;
	protected paddingX: number;
	protected paddingY: number;
	protected renderState: TextRenderState;

	constructor(text: string, paddingX: number, paddingY: number) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.renderState = new TextRenderState();
	}

	get renderRevision(): number {
		return this.renderState.revision;
	}

	setText(text: string): void {
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.renderState.invalidate();
	}
}

export function prepareTextBlock(text: string, width: number, paddingX: number): PreparedTextBlock | undefined {
	if (!text || text.trim() === "") return undefined;
	return {
		normalizedText: text.replace(/\t/g, "   "),
		contentWidth: Math.max(1, width - paddingX * 2),
	};
}

export function frameTextLines(lines: readonly string[], options: TextFrameOptions): string[] {
	const leftMargin = " ".repeat(options.paddingX);
	const rightMargin = leftMargin;
	const result: string[] = [];
	const emptyLine = " ".repeat(options.width);
	const framedEmptyLine = options.background
		? applyBackgroundToLine(emptyLine, options.width, options.background)
		: emptyLine;

	for (let index = 0; index < options.paddingY; index++) {
		result.push(framedEmptyLine);
	}

	for (const line of lines) {
		if (options.isPassthrough?.(line)) {
			result.push(line);
			continue;
		}

		const lineWithMargins = leftMargin + line + rightMargin;
		if (options.background) {
			result.push(applyBackgroundToLine(lineWithMargins, options.width, options.background));
			continue;
		}

		const paddingNeeded = Math.max(0, options.width - visibleWidth(lineWithMargins));
		result.push(lineWithMargins + " ".repeat(paddingNeeded));
	}

	for (let index = 0; index < options.paddingY; index++) {
		result.push(framedEmptyLine);
	}

	return result;
}
