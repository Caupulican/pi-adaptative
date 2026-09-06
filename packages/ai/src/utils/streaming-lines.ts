/**
 * Incremental CR/LF/CRLF line decoder that never repeatedly concatenates the
 * already-buffered prefix of a fragmented large line.
 */
export interface StreamingLineRecord {
	text: string;
	/** Zero-based UTF-16 position; adjusted backward if necessary to retain a complete surrogate pair. */
	startColumn: number;
	/** Full source line length, independent of how much text was retained. */
	totalChars: number;
}

function splitsSurrogatePair(text: string, index: number): boolean {
	return (text.charCodeAt(index - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(index) & 0xfc00) === 0xdc00;
}

export class StreamingLineDecoder {
	private readonly maxLineChars: number;
	private readonly overflow: "throw" | "skip" | "window";
	private readonly startColumn: number;
	private readonly lineEndings: "lf" | "any";
	private parts: string[] = [];
	private length = 0;
	private skipLeadingLf = false;
	private skippingOversizedLine = false;

	constructor(
		maxLineChars: number,
		options?: { overflow?: "throw" | "skip" | "window"; lineEndings?: "lf" | "any"; startColumn?: number },
	) {
		this.maxLineChars = maxLineChars;
		this.overflow = options?.overflow ?? "throw";
		this.lineEndings = options?.lineEndings ?? "any";
		this.startColumn = options?.startColumn ?? 0;
		if (
			this.overflow === "window" &&
			(!Number.isSafeInteger(maxLineChars) ||
				maxLineChars < 0 ||
				!Number.isSafeInteger(this.startColumn) ||
				this.startColumn < 0 ||
				!Number.isSafeInteger(this.startColumn + maxLineChars + 1))
		) {
			throw new Error("Line window requires bounded non-negative integer positions");
		}
	}

	push(text: string): string[] {
		return this.pushRecords(text).map((line) => line.text);
	}

	/** Window mode emits every source line, including lines whose text was not retained. */
	pushRecords(text: string): StreamingLineRecord[] {
		const lines: StreamingLineRecord[] = [];
		if (text.length === 0) return lines;
		let start = 0;
		if (this.skipLeadingLf) {
			this.skipLeadingLf = false;
			if (text.startsWith("\n")) start = 1;
		}

		for (let index = start; index < text.length; index++) {
			const char = text[index];
			if (char !== "\n" && (this.lineEndings === "lf" || char !== "\r")) continue;
			this.append(text.slice(start, index));
			if (this.skippingOversizedLine) {
				this.resetLine();
			} else {
				lines.push(this.takeLine());
			}
			if (char === "\r") {
				if (text[index + 1] === "\n") {
					index++;
				} else if (index + 1 === text.length) {
					this.skipLeadingLf = true;
				}
			}
			start = index + 1;
		}
		this.append(text.slice(start));
		return lines;
	}

	finish(): string | undefined {
		return this.finishRecord()?.text;
	}

	finishRecord(): StreamingLineRecord | undefined {
		this.skipLeadingLf = false;
		if (this.skippingOversizedLine) {
			this.resetLine();
			return undefined;
		}
		if (this.length === 0 && this.parts.length === 0) return undefined;
		return this.takeLine();
	}

	private append(part: string): void {
		if (part.length === 0 || this.skippingOversizedLine) return;
		const start = this.length;
		this.length += part.length;
		if (this.overflow === "window") {
			const from = Math.max(0, this.startColumn - 1 - start);
			const to = Math.min(part.length, this.startColumn + this.maxLineChars + 1 - start);
			if (to > from) this.parts.push(part.slice(from, to));
			return;
		}
		if (this.length > this.maxLineChars) {
			if (this.overflow === "throw") {
				throw new Error(`Stream exceeded the ${this.maxLineChars} character line limit`);
			}
			this.parts = [];
			this.length = 0;
			this.skippingOversizedLine = true;
			return;
		}
		this.parts.push(part);
	}

	private takeLine(): StreamingLineRecord {
		let text = this.parts.length === 0 ? "" : this.parts.length === 1 ? this.parts[0] : this.parts.join("");
		let startColumn = 0;
		if (this.overflow === "window") {
			const captureStart = Math.min(this.length, Math.max(0, this.startColumn - 1));
			startColumn = Math.min(this.length, this.startColumn);
			let from = startColumn - captureStart;
			if (splitsSurrogatePair(text, from)) {
				from--;
				startColumn--;
			}
			let to = Math.min(text.length, from + this.maxLineChars);
			if (this.maxLineChars > 0 && splitsSurrogatePair(text, to)) to++;
			text = text.slice(from, to);
		}
		const line = { text, startColumn, totalChars: this.length };
		this.resetLine();
		return line;
	}

	private resetLine(): void {
		this.parts = [];
		this.length = 0;
		this.skippingOversizedLine = false;
	}
}
