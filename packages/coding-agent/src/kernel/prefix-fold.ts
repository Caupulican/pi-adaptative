/**
 * A left fold over an array of immutable items that resumes where it stopped when the next array
 * still starts with the same objects, and starts over otherwise. Conversation history is
 * append-only between compactions and every message keeps its identity, so a request-time scan
 * over the whole history -- a plan, a sum, a flag -- replays only what was appended since the
 * previous request. Items are compared by identity against the fold's own copy of the processed
 * prefix, so an array mutated in place is still checked element by element. A fold owns one
 * lineage: give each call site, or each conversation, its own.
 */
export class PrefixFold<Item extends object, State> {
	private readonly create: () => State;
	private readonly step: (state: State, item: Item, index: number) => void;
	private processed: readonly Item[] = [];
	private state: State;

	constructor(create: () => State, step: (state: State, item: Item, index: number) => void) {
		this.create = create;
		this.step = step;
		this.state = create();
	}

	/** Fold `items`, resuming past the identical prefix. The returned state is mutated by later folds. */
	fold(items: readonly Item[]): State {
		let from = this.processed.length;
		if (from > items.length) from = -1;
		for (let index = 0; from > 0 && index < from; index++) {
			if (this.processed[index] !== items[index]) from = -1;
		}
		if (from < 0) {
			this.state = this.create();
			from = 0;
		}
		for (let index = from; index < items.length; index++) this.step(this.state, items[index]!, index);
		this.processed = items.slice();
		return this.state;
	}

	/** How many leading items the state reflects. */
	get processedCount(): number {
		return this.processed.length;
	}
}

/**
 * One fold per lineage, keyed by the first item. A conversation keeps its first message until a
 * compaction replaces it, and distinct conversations in one process start with distinct objects,
 * so the first item names the lineage without any registration. An empty array folds to a fresh
 * state. Two projections of one conversation that diverge after the first item share a fold and
 * reset each other; that costs a full replay, never a wrong answer.
 */
export class PrefixFoldByFirstItem<Item extends object, State> {
	private readonly create: () => State;
	private readonly step: (state: State, item: Item, index: number) => void;
	private readonly folds = new WeakMap<Item, PrefixFold<Item, State>>();

	constructor(create: () => State, step: (state: State, item: Item, index: number) => void) {
		this.create = create;
		this.step = step;
	}

	fold(items: readonly Item[]): State {
		const first = items[0];
		if (!first) return this.create();
		let fold = this.folds.get(first);
		if (!fold) {
			fold = new PrefixFold(this.create, this.step);
			this.folds.set(first, fold);
		}
		return fold.fold(items);
	}
}
