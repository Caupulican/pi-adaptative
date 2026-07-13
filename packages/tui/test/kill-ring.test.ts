import assert from "node:assert";
import { describe, it } from "node:test";
import { KillRing } from "../src/kill-ring.ts";

describe("KillRing retention", () => {
	it("evicts the oldest entries after reaching its process-lifetime bound", () => {
		const ring = new KillRing(3);
		for (const text of ["one", "two", "three", "four"]) {
			ring.push(text, { prepend: false });
		}

		assert.equal(ring.length, 3);
		assert.equal(ring.peek(), "four");
		ring.rotate();
		assert.equal(ring.peek(), "three");
		ring.rotate();
		assert.equal(ring.peek(), "two");
		ring.rotate();
		assert.equal(ring.peek(), "four");
	});

	it("keeps consecutive kill accumulation in the current entry", () => {
		const ring = new KillRing(2);
		ring.push("world", { prepend: false });
		ring.push("hello ", { prepend: true, accumulate: true });

		assert.equal(ring.length, 1);
		assert.equal(ring.peek(), "hello world");
	});
});
