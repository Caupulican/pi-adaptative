/** A binary min-heap ordered by `compare` (negative: the first argument comes out first). */
export class MinHeap<T> {
	private readonly items: T[] = [];
	private readonly compare: (left: T, right: T) => number;

	constructor(compare: (left: T, right: T) => number) {
		this.compare = compare;
	}

	get size(): number {
		return this.items.length;
	}

	peek(): T | undefined {
		return this.items[0];
	}

	push(item: T): void {
		const items = this.items;
		items.push(item);
		let child = items.length - 1;
		while (child > 0) {
			const parent = (child - 1) >> 1;
			if (this.compare(items[child] as T, items[parent] as T) >= 0) break;
			[items[child], items[parent]] = [items[parent] as T, items[child] as T];
			child = parent;
		}
	}

	pop(): T | undefined {
		const items = this.items;
		const top = items[0];
		const last = items.pop();
		if (items.length === 0 || last === undefined) return top;
		items[0] = last;
		let parent = 0;
		for (;;) {
			const left = parent * 2 + 1;
			const right = left + 1;
			let smallest = parent;
			if (left < items.length && this.compare(items[left] as T, items[smallest] as T) < 0) smallest = left;
			if (right < items.length && this.compare(items[right] as T, items[smallest] as T) < 0) smallest = right;
			if (smallest === parent) break;
			[items[parent], items[smallest]] = [items[smallest] as T, items[parent] as T];
			parent = smallest;
		}
		return top;
	}

	/** Keep only the items `keep` accepts, and restore the order. */
	retain(keep: (item: T) => boolean): void {
		const kept = this.items.filter(keep);
		this.items.length = 0;
		for (const item of kept) this.push(item);
	}
}
