/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 */
const DEFAULT_MAX_UNDO_ENTRIES = 100;

export class UndoStack<S> {
	private stack: S[] = [];
	private readonly maxEntries: number;

	constructor(maxEntries: number = DEFAULT_MAX_UNDO_ENTRIES) {
		this.maxEntries = Math.max(1, Math.floor(maxEntries));
	}

	/** Push a deep clone of the given state onto the stack. */
	push(state: S): void {
		this.stack.push(structuredClone(state));
		if (this.stack.length > this.maxEntries) {
			this.stack.splice(0, this.stack.length - this.maxEntries);
		}
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
