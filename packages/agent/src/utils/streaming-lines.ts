/** Incremental line decoder that joins a fragmented line only once, when it completes. */
export class StreamingLineDecoder {
	private readonly maxLineChars: number;
	private readonly overflow: "throw" | "skip";
	private readonly lineEndings: "lf" | "any";
	private parts: string[] = [];
	private length = 0;
	private skipLeadingLf = false;
	private skippingOversizedLine = false;

	constructor(maxLineChars: number, options?: { overflow?: "throw" | "skip"; lineEndings?: "lf" | "any" }) {
		this.maxLineChars = maxLineChars;
		this.overflow = options?.overflow ?? "throw";
		this.lineEndings = options?.lineEndings ?? "any";
	}

	push(text: string): string[] {
		const lines: string[] = [];
		let start = 0;
		if (this.skipLeadingLf) {
			this.skipLeadingLf = false;
			if (text.startsWith("\n")) start = 1;
		}
		for (let index = start; index < text.length; index++) {
			const char = text[index];
			if (char !== "\n" && (this.lineEndings === "lf" || char !== "\r")) continue;
			this.append(text.slice(start, index));
			if (this.skippingOversizedLine) this.resetLine();
			else lines.push(this.takeLine());
			if (char === "\r") {
				if (text[index + 1] === "\n") index++;
				else if (index + 1 === text.length) this.skipLeadingLf = true;
			}
			start = index + 1;
		}
		this.append(text.slice(start));
		return lines;
	}

	finish(): string | undefined {
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
		this.length += part.length;
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

	private takeLine(): string {
		const line = this.parts.length === 0 ? "" : this.parts.length === 1 ? this.parts[0] : this.parts.join("");
		this.resetLine();
		return line;
	}

	private resetLine(): void {
		this.parts = [];
		this.length = 0;
		this.skippingOversizedLine = false;
	}
}
