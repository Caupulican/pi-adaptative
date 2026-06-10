import assert from "node:assert";
import { describe, it } from "node:test";
import { CachedContainer, type Component } from "../src/tui.ts";

class CountingComponent implements Component {
	renderCount = 0;
	invalidateCount = 0;
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		this.renderCount += 1;
		return this.lines;
	}

	invalidate(): void {
		this.invalidateCount += 1;
	}
}

describe("CachedContainer", () => {
	it("reuses rendered lines until explicitly dirtied", () => {
		const container = new CachedContainer();
		const child = new CountingComponent(["one"]);
		container.addChild(child);

		assert.deepStrictEqual(container.render(80), ["one"]);
		assert.deepStrictEqual(container.render(80), ["one"]);
		assert.strictEqual(child.renderCount, 1);

		child.lines = ["two"];
		assert.deepStrictEqual(container.render(80), ["one"], "child-only mutation should not bypass cache");

		container.markDirty();
		assert.deepStrictEqual(container.render(80), ["two"]);
		assert.strictEqual(child.renderCount, 2);
	});

	it("dirties on width, structure, and invalidation changes", () => {
		const container = new CachedContainer();
		const first = new CountingComponent(["first"]);
		const second = new CountingComponent(["second"]);

		container.addChild(first);
		container.render(80);
		container.render(100);
		assert.strictEqual(first.renderCount, 2, "width change should re-render");

		container.addChild(second);
		assert.deepStrictEqual(container.render(100), ["first", "second"]);
		assert.strictEqual(first.renderCount, 3);
		assert.strictEqual(second.renderCount, 1);

		container.removeChild(second);
		assert.deepStrictEqual(container.render(100), ["first"]);
		assert.strictEqual(first.renderCount, 4);

		const replacement = new CountingComponent(["replacement"]);
		container.replaceChild(first, replacement);
		assert.deepStrictEqual(container.render(100), ["replacement"]);
		assert.strictEqual(replacement.renderCount, 1);

		container.invalidate();
		assert.strictEqual(replacement.invalidateCount, 1);
		container.render(100);
		assert.strictEqual(replacement.renderCount, 2);

		container.clear();
		assert.deepStrictEqual(container.render(100), []);
	});
});
