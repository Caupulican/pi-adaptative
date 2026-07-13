import assert from "node:assert";
import { describe, it } from "node:test";
import { UndoStack } from "../src/undo-stack.ts";

describe("UndoStack retention", () => {
	it("evicts the oldest cloned snapshots after reaching its bound", () => {
		const stack = new UndoStack<{ value: number }>(3);
		for (let value = 1; value <= 4; value++) stack.push({ value });

		assert.equal(stack.length, 3);
		assert.deepEqual(stack.pop(), { value: 4 });
		assert.deepEqual(stack.pop(), { value: 3 });
		assert.deepEqual(stack.pop(), { value: 2 });
		assert.equal(stack.pop(), undefined);
	});

	it("evicts snapshots by retained byte size", () => {
		const stack = new UndoStack<{ value: string }>(100, 80);
		stack.push({ value: "a".repeat(40) });
		stack.push({ value: "b".repeat(40) });

		assert.equal(stack.length, 1);
		assert.deepEqual(stack.pop(), { value: "b".repeat(40) });
	});

	it("drops a single snapshot larger than the byte budget", () => {
		const stack = new UndoStack<{ value: string }>(100, 16);
		stack.push({ value: "x".repeat(100) });
		assert.equal(stack.length, 0);
	});

	it("keeps snapshots detached from later state mutation", () => {
		const stack = new UndoStack<{ nested: { value: number } }>(2);
		const state = { nested: { value: 1 } };
		stack.push(state);
		state.nested.value = 2;

		assert.deepEqual(stack.pop(), { nested: { value: 1 } });
	});
});
