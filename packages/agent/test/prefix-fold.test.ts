import { describe, expect, it } from "vitest";
import { PrefixFold, PrefixFoldByFirstItem } from "../src/prefix-fold.ts";

interface Item {
	readonly name: string;
}
interface Log {
	readonly seen: string[];
	creations: number;
}

function counting(): { fold: PrefixFold<Item, Log>; creations: () => number } {
	let creations = 0;
	const fold = new PrefixFold<Item, Log>(
		() => {
			creations += 1;
			return { seen: [], creations };
		},
		(state, item) => {
			state.seen.push(item.name);
		},
	);
	return { fold, creations: () => creations };
}

describe("PrefixFold", () => {
	const a = { name: "a" };
	const b = { name: "b" };
	const c = { name: "c" };

	it("replays only what was appended past an identical prefix", () => {
		const { fold, creations } = counting();
		expect(fold.fold([a, b]).seen).toEqual(["a", "b"]);
		const resumed = fold.fold([a, b, c]);
		expect(resumed.seen).toEqual(["a", "b", "c"]);
		expect(fold.processedCount).toBe(3);
		expect(creations()).toBe(1);
	});

	it("starts over when the prefix diverges, shrinks, or is edited in place", () => {
		const { fold, creations } = counting();
		fold.fold([a, b, c]);
		expect(fold.fold([a, { name: "x" }, c]).seen).toEqual(["a", "x", "c"]);
		expect(creations()).toBe(2);
		expect(fold.fold([a]).seen).toEqual(["a"]);
		expect(creations()).toBe(3);
		const live = [a, b];
		fold.fold(live);
		expect(creations()).toBe(3);
		live[1] = c;
		expect(fold.fold(live).seen).toEqual(["a", "c"]);
		expect(creations()).toBe(4);
	});
});

describe("PrefixFoldByFirstItem", () => {
	it("keeps one fold per lineage and a fresh state for an empty array", () => {
		const steps: string[] = [];
		const folds = new PrefixFoldByFirstItem<Item, { count: number }>(
			() => ({ count: 0 }),
			(state, item) => {
				steps.push(item.name);
				state.count += 1;
			},
		);
		const first = { name: "first" };
		const other = { name: "other" };
		expect(folds.fold([first, { name: "1" }]).count).toBe(2);
		expect(folds.fold([other]).count).toBe(1);
		expect(folds.fold([first, { name: "1" }]).count).toBe(2);
		expect(steps).toEqual(["first", "1", "other", "first", "1"]);
		expect(folds.fold([]).count).toBe(0);
	});
});
