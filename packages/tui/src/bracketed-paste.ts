const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const PASTE_CHUNK_GROUP_SIZE = 256;

export type BracketedPasteResult =
	| { kind: "unhandled"; data: string }
	| { kind: "pending" }
	| { kind: "complete"; content: string; remainder: string };

export type ActiveBracketedPasteResult = Exclude<BracketedPasteResult, { kind: "unhandled" }>;

function closingMarkerPrefixLength(text: string): number {
	const maxLength = Math.min(BRACKETED_PASTE_END.length - 1, text.length);
	for (let length = maxLength; length > 0; length--) {
		if (text.endsWith(BRACKETED_PASTE_END.slice(0, length))) {
			return length;
		}
	}
	return 0;
}

/**
 * Incrementally collects bracketed paste content without rebuilding or rescanning
 * the accumulated prefix for every terminal chunk.
 */
export class BracketedPasteBuffer {
	private groups: string[] = [];
	private chunks: string[] = [];
	private closingMarkerPrefix = "";
	private active = false;

	consume(input: string): BracketedPasteResult {
		if (!this.active) {
			const startIndex = input.indexOf(BRACKETED_PASTE_START);
			if (startIndex === -1) return { kind: "unhandled", data: input };
			return this.start(input.slice(0, startIndex) + input.slice(startIndex + BRACKETED_PASTE_START.length));
		}
		return this.appendChunk(input);
	}

	start(content: string = ""): ActiveBracketedPasteResult {
		this.reset();
		this.active = true;
		return this.consumeActive(content);
	}

	appendChunk(input: string): ActiveBracketedPasteResult {
		if (!this.active) return this.start(input);
		return this.consumeActive(input);
	}

	flushPending(): string | undefined {
		if (!this.active) return undefined;
		this.appendContent(this.closingMarkerPrefix);
		this.closingMarkerPrefix = "";
		this.flushChunkGroup();
		const content = this.groups.join("");
		this.reset();
		return content;
	}

	clear(): void {
		this.reset();
	}

	private consumeActive(input: string): ActiveBracketedPasteResult {
		// The retained prefix is at most five bytes, so this copy is bounded by the
		// current input chunk rather than the complete paste size.
		const candidate = this.closingMarkerPrefix + input;
		const endIndex = candidate.indexOf(BRACKETED_PASTE_END);
		if (endIndex !== -1) {
			this.appendContent(candidate.slice(0, endIndex));
			this.flushChunkGroup();
			const content = this.groups.join("");
			const remainder = candidate.slice(endIndex + BRACKETED_PASTE_END.length);
			this.reset();
			return { kind: "complete", content, remainder };
		}

		const prefixLength = closingMarkerPrefixLength(candidate);
		const contentEnd = candidate.length - prefixLength;
		this.appendContent(contentEnd === candidate.length ? candidate : candidate.slice(0, contentEnd));
		this.closingMarkerPrefix = prefixLength === 0 ? "" : candidate.slice(contentEnd);
		return { kind: "pending" };
	}

	private appendContent(content: string): void {
		if (!content) return;
		this.chunks.push(content);
		if (this.chunks.length >= PASTE_CHUNK_GROUP_SIZE) {
			this.flushChunkGroup();
		}
	}

	private flushChunkGroup(): void {
		if (this.chunks.length === 0) return;
		this.groups.push(this.chunks.join(""));
		this.chunks.length = 0;
	}

	private reset(): void {
		this.groups.length = 0;
		this.chunks.length = 0;
		this.closingMarkerPrefix = "";
		this.active = false;
	}
}
