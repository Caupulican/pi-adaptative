import { deserialize, serialize } from "node:v8";

/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 */
const DEFAULT_MAX_UNDO_ENTRIES = 100;
const DEFAULT_MAX_UNDO_BYTES = 8 * 1024 * 1024;

interface UndoEntry<S> {
	state: S;
	bytes: number;
}

function positiveLimit(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

export class UndoStack<S> {
	private stack: UndoEntry<S>[] = [];
	private totalBytes = 0;
	private readonly maxEntries: number;
	private readonly maxBytes: number;

	constructor(maxEntries: number = DEFAULT_MAX_UNDO_ENTRIES, maxBytes: number = DEFAULT_MAX_UNDO_BYTES) {
		this.maxEntries = positiveLimit(maxEntries, DEFAULT_MAX_UNDO_ENTRIES);
		this.maxBytes = positiveLimit(maxBytes, DEFAULT_MAX_UNDO_BYTES);
	}

	/** Push a deep clone of the given state onto the stack. */
	push(state: S): void {
		const encoded = serialize(state);
		const bytes = encoded.byteLength;
		if (bytes > this.maxBytes) {
			this.clear();
			return;
		}
		this.stack.push({ state: deserialize(encoded) as S, bytes });
		this.totalBytes += bytes;
		while (this.stack.length > this.maxEntries || this.totalBytes > this.maxBytes) {
			const removed = this.stack.shift();
			if (removed) this.totalBytes -= removed.bytes;
		}
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		const entry = this.stack.pop();
		if (!entry) return undefined;
		this.totalBytes -= entry.bytes;
		return entry.state;
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
		this.totalBytes = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
