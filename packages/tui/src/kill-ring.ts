/**
 * Ring buffer for Emacs-style kill/yank operations.
 *
 * Tracks killed (deleted) text entries. Consecutive kills can accumulate
 * into a single entry. Supports yank (paste most recent) and yank-pop
 * (cycle through older entries).
 */
const DEFAULT_MAX_KILL_RING_ENTRIES = 60;
const DEFAULT_MAX_KILL_RING_BYTES = 1024 * 1024;

function positiveLimit(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

function clampUtf8(value: string, maxBytes: number, keepEnd: boolean): string {
	if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = keepEnd ? value.slice(value.length - middle) : value.slice(0, middle);
		if (Buffer.byteLength(candidate, "utf-8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	let result = keepEnd ? value.slice(value.length - low) : value.slice(0, low);
	if (keepEnd && result.length > 0 && /[\uDC00-\uDFFF]/.test(result[0])) result = result.slice(1);
	if (!keepEnd && result.length > 0 && /[\uD800-\uDBFF]/.test(result.at(-1) ?? "")) result = result.slice(0, -1);
	return result;
}

export class KillRing {
	private ring: string[] = [];
	private totalBytes = 0;
	private readonly maxEntries: number;
	private readonly maxBytes: number;

	constructor(maxEntries: number = DEFAULT_MAX_KILL_RING_ENTRIES, maxBytes: number = DEFAULT_MAX_KILL_RING_BYTES) {
		this.maxEntries = positiveLimit(maxEntries, DEFAULT_MAX_KILL_RING_ENTRIES);
		this.maxBytes = positiveLimit(maxBytes, DEFAULT_MAX_KILL_RING_BYTES);
	}

	/**
	 * Add text to the kill ring.
	 *
	 * @param text - The killed text to add
	 * @param opts - Push options
	 * @param opts.prepend - If accumulating, prepend (backward deletion) or append (forward deletion)
	 * @param opts.accumulate - Merge with the most recent entry instead of creating a new one
	 */
	push(text: string, opts: { prepend: boolean; accumulate?: boolean }): void {
		if (!text) return;

		if (opts.accumulate && this.ring.length > 0) {
			const last = this.ring.pop()!;
			this.totalBytes -= Buffer.byteLength(last, "utf-8");
			const combined = opts.prepend ? text + last : last + text;
			const bounded = clampUtf8(combined, this.maxBytes, !opts.prepend);
			this.ring.push(bounded);
			this.totalBytes += Buffer.byteLength(bounded, "utf-8");
		} else {
			const bounded = clampUtf8(text, this.maxBytes, true);
			this.ring.push(bounded);
			this.totalBytes += Buffer.byteLength(bounded, "utf-8");
		}
		while (this.ring.length > this.maxEntries || this.totalBytes > this.maxBytes) {
			const removed = this.ring.shift();
			if (removed !== undefined) this.totalBytes -= Buffer.byteLength(removed, "utf-8");
		}
	}

	/** Get most recent entry without modifying the ring. */
	peek(): string | undefined {
		return this.ring.length > 0 ? this.ring[this.ring.length - 1] : undefined;
	}

	/** Move last entry to front (for yank-pop cycling). */
	rotate(): void {
		if (this.ring.length > 1) {
			const last = this.ring.pop()!;
			this.ring.unshift(last);
		}
	}

	get length(): number {
		return this.ring.length;
	}
}
