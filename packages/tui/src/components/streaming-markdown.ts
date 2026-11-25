/** Reuses settled Markdown rows and bounds the amount of unfinished source parsed per frame. */

import type { Token } from "marked";

const MAX_ACTIVE_SOURCE = 16_384;
const MAX_SETTLED_SOURCE = 65_536;

interface MarkdownStreamRenderer {
	lex(source: string): readonly Token[];
	render(tokens: readonly Token[], width: number, start?: number, end?: number): string[];
	preview(source: string, width: number): string[];
}

/**
 * A blank separator after an independent top-level block closes that block. Keep the separator
 * with the live suffix so its own row is emitted exactly once and future whitespace stays mutable.
 * Marked shares link definitions and inline HTML state across blocks. Keep source containing
 * brackets or HTML openers in the live suffix.
 */
function settledBoundary(
	source: string,
	tokens: readonly Token[],
	limit: number,
): { offset: number; index: number; separator: string } | undefined {
	let offset = 0;
	let boundary: { offset: number; index: number; separator: string } | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		const previous = tokens[index - 1];
		if (
			token.type === "space" &&
			/^ *\n *\n/.test(token.raw) &&
			source.startsWith(token.raw, offset) &&
			offset <= limit &&
			(previous?.type === "paragraph" ||
				previous?.type === "heading" ||
				previous?.type === "hr" ||
				(previous?.type === "code" && previous.codeBlockStyle !== "indented"))
		) {
			boundary = { offset, index, separator: token.raw };
		}
		if (!source.startsWith(token.raw, offset) || /[[<]/.test(token.raw) || offset + token.raw.length > limit) break;
		offset += token.raw.length;
	}
	return boundary;
}

export class StreamingMarkdown {
	private source = "";
	private separator = "";
	private readonly rows: string[] = [];
	private width?: number;

	render(source: string, width: number, renderer: MarkdownStreamRenderer, final = false): string[] {
		if (
			this.width !== width ||
			!source.startsWith(this.source) ||
			!source.startsWith(this.separator, this.source.length)
		) {
			this.clear();
			this.width = width;
		}
		const remainder = source.length - this.source.length;
		if (!final && remainder > MAX_ACTIVE_SOURCE) {
			let start = source.length - MAX_ACTIVE_SOURCE;
			const first = source.charCodeAt(start);
			if (first >= 0xdc00 && first <= 0xdfff) start++;
			return this.rows.concat(renderer.preview(source.slice(start), width));
		}
		const active = source.slice(this.source.length);
		const tokens = renderer.lex(active);
		if (final) return this.rows.concat(renderer.render(tokens, width));
		const boundary = settledBoundary(active, tokens, MAX_SETTLED_SOURCE - this.source.length);
		if (boundary) {
			for (const row of renderer.render(tokens, width, 0, boundary.index)) this.rows.push(row);
			this.source = source.slice(0, this.source.length + boundary.offset);
			this.separator = boundary.separator;
		}
		return this.rows.concat(renderer.render(tokens, width, boundary?.index));
	}

	clear(): void {
		this.source = "";
		this.separator = "";
		this.rows.length = 0;
		this.width = undefined;
	}
}
