import { collectTerminalRows, type TerminalRows } from "../terminal-rows.ts";
import { applyBackgroundToLine, fitToWidth } from "../utils.ts";

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
	private lines?: TerminalRows;

	read(text: string, width: number): TerminalRows | undefined {
		return this.lines && this.text === text && this.width === width ? this.lines : undefined;
	}

	write(text: string, width: number, lines: TerminalRows): void {
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

export type TextRenderStart =
	| { kind: "complete"; lines: TerminalRows }
	| { kind: "render"; prepared: PreparedTextBlock };

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
		return { kind: "complete", lines };
	}

	finish(text: string, width: number, rows: TerminalRows): TerminalRows {
		const lines = rows.length > 0 ? rows : [""];
		this.cache.write(text, width, lines);
		return lines;
	}
}

/** Shared mutable lifecycle for cache-backed text components. */
export abstract class CachedTextComponent {
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

	render(width: number): string[] {
		return collectTerminalRows(this.renderRows(width));
	}

	renderRows(width: number): TerminalRows {
		const start = this.renderState.begin(this.text, width, this.paddingX);
		if (start.kind === "complete") return start.lines;
		return this.renderState.finish(this.text, width, this.layoutRows(start.prepared, width));
	}

	protected abstract layoutRows(prepared: PreparedTextBlock, width: number): TerminalRows;

	setText(text: string): void {
		if (this.text === text) return;
		this.text = text;
		this.renderState.invalidate();
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

export function frameTextRows(lines: readonly string[], options: TextFrameOptions): TerminalRows {
	const margin = " ".repeat(options.paddingX);
	const length = lines.length + 2 * options.paddingY;
	const framedRows: string[] | undefined = length <= 64 ? [] : undefined;
	let empty: string | undefined;
	return {
		length,
		at(index) {
			if (index < 0 || index >= length) return undefined;
			const line = lines[index - options.paddingY];
			if (line === undefined) {
				if (empty === undefined) {
					const spaces = " ".repeat(options.width);
					empty = options.background ? applyBackgroundToLine(spaces, options.width, options.background) : spaces;
				}
				return empty;
			}
			if (options.isPassthrough?.(line)) return line;
			const cached = framedRows?.[index];
			if (cached !== undefined) return cached;
			const framed = margin + line + margin;
			const result = options.background
				? applyBackgroundToLine(framed, options.width, options.background)
				: fitToWidth(framed, options.width, true);
			if (framedRows && result.length <= 8192) framedRows[index] = result;
			return result;
		},
	};
}
