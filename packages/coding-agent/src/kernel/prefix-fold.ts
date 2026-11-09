/**
 * Folds over conversation arrays that resume where they stopped. Conversation history is append-only between compactions and
 * every message keeps its identity, so a request-time scan over the whole history -- a plan, a sum, a flag -- replays only what
 * was appended since the previous request. Each fold keeps the references it has processed (pushed as they are folded, never
 * copied from the array it read) and compares the next array against them by identity, so an array mutated in place is still
 * checked element by element. A fold also starts over when a message's content was edited in place (see
 * `messageContentEpoch`), since identity alone does not show that. A fold owns one lineage: give each call site, or each
 * conversation, its own.
 *
 * Every fold counts its element operations (identity compares and steps) into one process-wide integer, which the planner
 * takes once per accepted request and logs (see `recordPrefixFoldWork`).
 */

import { harnessLog } from "./harness-log.ts";
import { messageContentEpoch } from "./message-revision.ts";

/** Element operations counted by the folds since the last take. */
let foldOperations = 0;

/** The element operations the folds performed since the previous call; the count starts again from zero. */
export function takePrefixFoldOperations(): number {
	const counted = foldOperations;
	foldOperations = 0;
	return counted;
}

export class PrefixFold<Item extends object, State> {
	private readonly create: () => State;
	private readonly step: (state: State, item: Item, index: number, items: readonly Item[]) => void;
	private processed: Item[] = [];
	private state: State;
	private epoch = messageContentEpoch();

	constructor(create: () => State, step: (state: State, item: Item, index: number, items: readonly Item[]) => void) {
		this.create = create;
		this.step = step;
		this.state = create();
	}

	/** Fold `items`, resuming past the identical prefix. The returned state is mutated by later folds. */
	fold(items: readonly Item[]): State {
		let from = this.processed.length;
		let work = 0;
		if (from > items.length || this.epoch !== messageContentEpoch()) from = -1;
		for (let index = 0; from > 0 && index < from; index++) {
			work++;
			if (this.processed[index] !== items[index]) {
				from = -1;
				break;
			}
		}
		if (from < 0) {
			this.state = this.create();
			this.processed = [];
			from = 0;
		}
		for (let index = from; index < items.length; index++) {
			const item = items[index]!;
			this.step(this.state, item, index, items);
			this.processed.push(item);
		}
		work += items.length - from;
		foldOperations += work;
		this.epoch = messageContentEpoch();
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
 * reset each other; that costs a full replay, never a wrong answer. Keep arrays that are read side
 * by side on separate instances.
 */
export class PrefixFoldByFirstItem<Item extends object, State> {
	private readonly create: () => State;
	private readonly step: (state: State, item: Item, index: number, items: readonly Item[]) => void;
	private readonly folds = new WeakMap<Item, PrefixFold<Item, State>>();

	constructor(create: () => State, step: (state: State, item: Item, index: number, items: readonly Item[]) => void) {
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

/**
 * The index of the first item that satisfies `matches`, or -1, resuming past the identical prefix it already answered for.
 * Unlike {@link PrefixFold}, a changed tail costs only the changed tail: when the first match lies in the common prefix the
 * answer is that match and nothing is scanned; otherwise the scan starts at the first changed position. That is what a
 * per-request scan needs when the array ends in records rebuilt for each request.
 */
export class PrefixFirstMatch<Item extends object> {
	private readonly matches: (item: Item) => boolean;
	/** Exactly the items the answer covers: a prefix of the last array searched, ending at the first match if there is one. */
	private processed: Item[] = [];
	private firstMatch = -1;
	private epoch = messageContentEpoch();

	constructor(matches: (item: Item) => boolean) {
		this.matches = matches;
	}

	find(items: readonly Item[]): number {
		const bound = this.epoch === messageContentEpoch() ? Math.min(this.processed.length, items.length) : 0;
		let common = 0;
		while (common < bound && this.processed[common] === items[common]) common++;
		let work = common < bound ? common + 1 : common;
		if (this.firstMatch >= common) this.firstMatch = -1;
		this.processed.length = common;
		let found = this.firstMatch;
		if (found < 0) {
			for (let index = common; index < items.length; index++) {
				const item = items[index]!;
				this.processed.push(item);
				work++;
				if (this.matches(item)) {
					found = index;
					this.firstMatch = index;
					break;
				}
			}
		}
		foldOperations += work;
		this.epoch = messageContentEpoch();
		return found;
	}
}

/** One {@link PrefixFirstMatch} per lineage, keyed by the first item (see {@link PrefixFoldByFirstItem}). */
export class PrefixFirstMatchByFirstItem<Item extends object> {
	private readonly matches: (item: Item) => boolean;
	private readonly scans = new WeakMap<Item, PrefixFirstMatch<Item>>();

	constructor(matches: (item: Item) => boolean) {
		this.matches = matches;
	}

	find(items: readonly Item[]): number {
		const first = items[0];
		if (!first) return -1;
		let scan = this.scans.get(first);
		if (!scan) {
			scan = new PrefixFirstMatch(this.matches);
			this.scans.set(first, scan);
		}
		return scan.find(items);
	}
}

/** Accepted requests per aggregated debug line. */
const PREFIX_FOLD_WORK_WINDOW = 50;
let workWindow: number[] = [];

/**
 * Logs one accepted request's fold work under `context`: the element operations counted since the previous accepted request
 * (process-wide, so the folds of other sessions in this process blur into it), with the history length and the plan length.
 * Each window of {@link PREFIX_FOLD_WORK_WINDOW} requests also writes one debug line with the p95 and maximum of
 * (operations + history length), the trigger metric for the context-array versioning decision.
 */
export function recordPrefixFoldWork(historyLength: number, planLength: number): void {
	const operations = takePrefixFoldOperations();
	if (!harnessLog.enabled("debug", "context")) return;
	harnessLog.trace("context", "prefix fold work for an accepted request", () => ({
		operations,
		historyLength,
		planLength,
	}));
	workWindow.push(operations + historyLength);
	if (workWindow.length < PREFIX_FOLD_WORK_WINDOW) return;
	const sorted = workWindow.slice().sort((left, right) => left - right);
	harnessLog.debug("context", "prefix fold work over recent accepted requests", {
		requests: sorted.length,
		p95Work: sorted[Math.ceil(sorted.length * 0.95) - 1],
		maxWork: sorted[sorted.length - 1],
	});
	workWindow = [];
}
