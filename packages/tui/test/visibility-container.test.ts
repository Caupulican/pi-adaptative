import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { VisibilityContainer } from "../src/components/visibility-container.ts";

describe("VisibilityContainer", () => {
	it("renders its children when visible (default)", () => {
		const container = new VisibilityContainer();
		container.addChild(new Text("hello", 0, 0));

		assert.deepStrictEqual(
			container.render(80).map((line) => line.trimEnd()),
			["hello"],
		);
	});

	it("renders no lines while hidden, without discarding children", () => {
		const container = new VisibilityContainer();
		const child = new Text("hello", 0, 0);
		container.addChild(child);

		container.setVisible(false);
		assert.deepStrictEqual(container.render(80), []);
		assert.strictEqual(container.isVisible(), false);

		container.setVisible(true);
		assert.deepStrictEqual(
			container.render(80).map((line) => line.trimEnd()),
			["hello"],
		);
	});

	it("starts hidden when constructed with visible:false", () => {
		const container = new VisibilityContainer(false);
		container.addChild(new Text("hello", 0, 0));

		assert.deepStrictEqual(container.render(80), []);
	});

	it("bumps renderRevision on a real visibility change so a parent Container's cache invalidates", () => {
		const container = new VisibilityContainer();
		container.addChild(new Text("hello", 0, 0));
		const before = container.renderRevision;

		container.setVisible(false);
		assert.notStrictEqual(container.renderRevision, before);

		const afterHide = container.renderRevision;
		container.setVisible(false); // no-op: already hidden
		assert.strictEqual(container.renderRevision, afterHide);
	});
});
