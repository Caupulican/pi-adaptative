import { TEXT_TOOL_PROTOCOL_ENVELOPE_DELIMITERS, type TextToolProtocolEnvelopeDelimiter } from "./text-protocol.ts";

const TEXT_PROTOCOL_ENVELOPE_TRIGGER = /[<`]/;

function findEarliestEnvelopeOpener(
	text: string,
): { index: number; pattern: TextToolProtocolEnvelopeDelimiter } | undefined {
	let best: { index: number; pattern: TextToolProtocolEnvelopeDelimiter } | undefined;
	for (const pattern of TEXT_TOOL_PROTOCOL_ENVELOPE_DELIMITERS) {
		const index = text.indexOf(pattern.opener);
		if (index === -1) continue;
		if (!best || index < best.index) best = { index, pattern };
	}
	return best;
}

function longestPendingOpenerPrefixLength(text: string): number {
	let longest = 0;
	for (const pattern of TEXT_TOOL_PROTOCOL_ENVELOPE_DELIMITERS) {
		const maxLength = Math.min(text.length, pattern.opener.length - 1);
		for (let length = maxLength; length > 0; length -= 1) {
			if (pattern.opener.startsWith(text.slice(text.length - length))) {
				longest = Math.max(longest, length);
				break;
			}
		}
	}
	return longest;
}

function longestPendingCloserPrefixLength(text: string, closer: string): number {
	const maxLength = Math.min(text.length, closer.length - 1);
	for (let length = maxLength; length > 0; length -= 1) {
		if (closer.startsWith(text.slice(text.length - length))) return length;
	}
	return 0;
}

/**
 * Incrementally projects safe prose from one append-only streamed text block.
 *
 * Prose mode retains only the bounded suffix that could grow into an envelope opener.
 * Envelope mode drops body text immediately and retains only a possible closer suffix.
 * `finish` reconciles once against an authoritative final value if a provider did not emit
 * append-only deltas.
 */
export class TextProtocolLiveFilter {
	private pending = "";
	private closer: string | undefined;
	private rawLength = 0;
	private visibleText = "";
	private completedEnvelopes = 0;

	get visible(): string {
		return this.visibleText;
	}

	/** Number of complete envelope delimiters observed in this append-only block. */
	get completedEnvelopeCount(): number {
		return this.completedEnvelopes;
	}

	/** True while a suffix can still become an opener, or while an envelope body is open. */
	get holdingPotentialEnvelope(): boolean {
		return this.closer !== undefined || this.pending.length > 0;
	}

	advance(delta: string): string {
		this.rawLength += delta.length;
		this.consume(delta);
		return this.visibleText;
	}

	finish(fullText: string): string {
		if (fullText.length !== this.rawLength) this.rebuild(fullText);
		return this.visibleText;
	}

	private rebuild(fullText: string): void {
		this.pending = "";
		this.closer = undefined;
		this.rawLength = fullText.length;
		this.visibleText = "";
		this.completedEnvelopes = 0;
		this.consume(fullText);
	}

	private consume(chunk: string): void {
		if (chunk.length === 0) return;
		this.pending += chunk;
		const visibleParts: string[] = [];

		while (this.pending.length > 0) {
			if (this.closer !== undefined) {
				const closerIndex = this.pending.indexOf(this.closer);
				if (closerIndex === -1) {
					const pendingLength = longestPendingCloserPrefixLength(this.pending, this.closer);
					this.pending = pendingLength > 0 ? this.pending.slice(-pendingLength) : "";
					break;
				}
				this.pending = this.pending.slice(closerIndex + this.closer.length);
				this.closer = undefined;
				this.completedEnvelopes++;
				continue;
			}

			if (!TEXT_PROTOCOL_ENVELOPE_TRIGGER.test(this.pending)) {
				visibleParts.push(this.pending);
				this.pending = "";
				break;
			}
			const match = findEarliestEnvelopeOpener(this.pending);
			if (!match) {
				const pendingLength = longestPendingOpenerPrefixLength(this.pending);
				const visibleEnd = this.pending.length - pendingLength;
				if (visibleEnd > 0) visibleParts.push(this.pending.slice(0, visibleEnd));
				this.pending = pendingLength > 0 ? this.pending.slice(visibleEnd) : "";
				break;
			}
			if (match.index > 0) visibleParts.push(this.pending.slice(0, match.index));
			this.pending = this.pending.slice(match.index + match.pattern.opener.length);
			this.closer = match.pattern.closer;
		}

		if (visibleParts.length > 0) this.visibleText += visibleParts.join("");
	}
}
