import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, Container, CURSOR_MARKER, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * A leaf that mirrors the real caching convention already used by Text/Markdown/Box/Image
 * (components/text.ts etc.): it returns the *same* array reference from render(width) when its
 * own content and the requested width are unchanged, and only redoes "expensive" work otherwise.
 */
class CachingLeaf implements Component {
	private content: string;
	private cachedContent?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	expensiveCalls = 0;

	constructor(content: string) {
		this.content = content;
	}

	setContent(content: string): void {
		this.content = content;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedContent === this.content && this.cachedWidth === width) {
			return this.cachedLines;
		}
		this.expensiveCalls++;
		const lines = [this.content.padEnd(width)];
		this.cachedContent = this.content;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedContent = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** A leaf with no internal memoization (mirrors Editor/SelectList/Input): always builds a fresh array. */
class UncachedLeaf implements Component {
	content: string[] = [];
	renderCount = 0;

	render(_width: number): string[] {
		this.renderCount++;
		return [...this.content];
	}

	invalidate(): void {}
}

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

describe("Container render cache", () => {
	it("reuses the cached lines array when content and width are unchanged", () => {
		const container = new Container();
		const leaf = new CachingLeaf("hello");
		container.addChild(leaf);

		const first = container.render(20);
		const second = container.render(20);

		assert.strictEqual(second, first, "unchanged content/width should reuse the same array");
		assert.strictEqual(leaf.expensiveCalls, 1, "leaf's expensive render work should run once");
	});

	it("invalidates and recomputes when a child's content changes", () => {
		const container = new Container();
		const leaf = new CachingLeaf("hello");
		container.addChild(leaf);
		const first = container.render(20);

		leaf.setContent("world");
		const second = container.render(20);

		assert.notStrictEqual(second, first);
		assert.strictEqual(second[0].trimEnd(), "world");
		assert.strictEqual(leaf.expensiveCalls, 2);
	});

	it("invalidates and recomputes when width changes", () => {
		const container = new Container();
		const leaf = new CachingLeaf("hello");
		container.addChild(leaf);
		const first = container.render(20);

		const second = container.render(30);

		assert.notStrictEqual(second, first);
		assert.strictEqual(second[0].trimEnd(), "hello");
		assert.strictEqual(leaf.expensiveCalls, 2, "width change must re-run the leaf's own render");
	});

	it("invalidates on addChild (structural change)", () => {
		const container = new Container();
		const leafA = new CachingLeaf("A");
		container.addChild(leafA);
		const first = container.render(10);

		const leafB = new CachingLeaf("B");
		container.addChild(leafB);
		const second = container.render(10);

		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(
			second.map((l) => l.trimEnd()),
			["A", "B"],
		);
		assert.strictEqual(leafA.expensiveCalls, 1, "unrelated sibling should not be re-rendered on add");
	});

	it("invalidates on removeChild (structural change)", () => {
		const container = new Container();
		const leafA = new CachingLeaf("A");
		const leafB = new CachingLeaf("B");
		container.addChild(leafA);
		container.addChild(leafB);
		const first = container.render(10);

		container.removeChild(leafA);
		const second = container.render(10);

		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(
			second.map((l) => l.trimEnd()),
			["B"],
		);
	});

	it("invalidates when a same-length child is swapped by direct index assignment", () => {
		// Mirrors extension-ui-host.ts's `headerContainer.children[index] = other` pattern, which
		// bypasses addChild/removeChild entirely and keeps children.length unchanged.
		const container = new Container();
		const leafA = new CachingLeaf("A");
		const leafB = new CachingLeaf("B");
		container.addChild(leafA);
		const first = container.render(10);

		container.children[0] = leafB;
		const second = container.render(10);

		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(
			second.map((l) => l.trimEnd()),
			["B"],
		);
	});

	it("invalidate() clears the render cache so the next render recomputes", () => {
		const container = new Container();
		const leaf = new CachingLeaf("hello");
		container.addChild(leaf);
		const first = container.render(20);

		container.invalidate();
		const second = container.render(20);

		assert.notStrictEqual(second, first, "invalidate() must force a fresh concatenation");
		assert.deepStrictEqual(second, first, "content is unchanged, only the array identity was reset");
	});

	it("always calls render on children with no internal memoization (correct, never stale)", () => {
		const container = new Container();
		const leaf = new UncachedLeaf();
		leaf.content = ["static"];
		container.addChild(leaf);

		const first = container.render(10);
		const second = container.render(10);

		assert.strictEqual(leaf.renderCount, 2, "render() must be invoked every tick without an internal cache");
		assert.deepStrictEqual(second, first, "output content is identical");
		assert.notStrictEqual(second, first, "no reference-stable output was available to reuse");
	});

	it("propagates cache reuse through nested containers composed of self-memoizing leaves", () => {
		const outer = new Container();
		const inner = new Container();
		const leafA = new CachingLeaf("A");
		const leafB = new CachingLeaf("B");
		inner.addChild(leafA);
		outer.addChild(inner);
		outer.addChild(leafB);

		const first = outer.render(10);
		const second = outer.render(10);

		assert.strictEqual(second, first, "fully unchanged nested tree should reuse the outer array");
		assert.strictEqual(leafA.expensiveCalls, 1);
		assert.strictEqual(leafB.expensiveCalls, 1);

		leafA.setContent("changed");
		const third = outer.render(10);

		assert.notStrictEqual(third, second);
		assert.strictEqual(leafA.expensiveCalls, 2);
		assert.strictEqual(leafB.expensiveCalls, 1, "sibling leaf must not be re-rendered for an unrelated change");
	});
});

describe("TUI render cache mutation safety", () => {
	it("does not accumulate reset sequences on a cached line across repeated unchanged ticks", async () => {
		// Regression test: Container.render() may now return the same lines array across many
		// ticks. If applyLineResets/findCursorMarker mutated that array in place (as they did
		// before this change), every idle tick would silently re-append the terminal reset suffix
		// to the cached array, growing it without bound even though nothing ever changed.
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = ["stable content"];
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		tui.requestRender(true);
		await terminal.waitForRender();
		const firstWrite = terminal.getWrites();
		assert.ok(firstWrite.includes("stable content"), "baseline redraw should contain the line content");
		terminal.clearWrites();

		for (let i = 0; i < 50; i++) {
			tui.requestRender();
			await terminal.waitForRender();
		}
		terminal.clearWrites();

		tui.requestRender(true);
		await terminal.waitForRender();
		const secondWrite = terminal.getWrites();

		assert.strictEqual(
			secondWrite,
			firstWrite,
			"repeated unchanged ticks must not grow the cached line's written bytes",
		);

		tui.stop();
	});

	it("keeps cursor-marker output correct across repeated unchanged ticks with a cached array", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		// Emulate a focused component whose stable output embeds the cursor marker, matching how
		// Focusable components (Input/Editor) signal cursor position in their rendered lines.
		component.lines = [`prompt${CURSOR_MARKER}>`];
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();

		for (let i = 0; i < 5; i++) {
			tui.requestRender();
			await terminal.waitForRender();
		}

		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0], "prompt>", `marker should be stripped: ${viewport[0]}`);
		assert.ok(!viewport.join("\n").includes("pi:c"), "raw marker bytes must never reach the terminal");

		tui.stop();
	});
});
