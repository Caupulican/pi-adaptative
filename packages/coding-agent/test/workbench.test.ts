import { type Component, Container, Text, type TUI, visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { ConversationWindow } from "../src/modes/interactive/components/conversation-window.ts";
import { WorkbenchComponent } from "../src/modes/interactive/components/workbench.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

class Rows implements Component {
	reads = 0;
	renderRevision = 0;
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		this.reads++;
		return this.lines;
	}
	invalidate(): void {
		this.renderRevision++;
	}
}

describe("Workbench conversation window", () => {
	it("preserves copied selection across terminal resize and clamps highlight columns", () => {
		const window = new ConversationWindow(() => [new Rows(["first line", "middle line", "last line"])]);
		window.render(30, 3);
		window.select({ row: 0, column: 2 }, true);
		window.select({ row: 2, column: 8 }, false);
		const selected = window.selectionText();
		for (const width of [1, 4, 80, 3, 30]) {
			for (const line of window.render(width, 3)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(window.selectionText()).toBe(selected);
		}
	});
	it("cannot scroll beyond the final full page and resumes following when scrolling down to it", () => {
		const entry = new Rows(Array.from({ length: 20 }, (_, i) => `line ${i}`));
		const window = new ConversationWindow(() => [entry]);
		const tail = window.render(80, 5);
		window.scroll(4);
		expect(window.render(80, 5)).toEqual(tail);
		expect(window.following).toBe(true);
	});
	it("renders the tail without visiting hidden history, and caches unchanged visible entries", () => {
		const entries = Array.from({ length: 1000 }, (_, i) => new Rows([`line ${i}`]));
		const window = new ConversationWindow(() => entries);
		expect(window.render(80, 5)).toEqual(entries.slice(-5).map((entry) => entry.lines[0]));
		window.render(80, 5);
		expect(entries.reduce((sum, entry) => sum + entry.reads, 0)).toBe(5);
	});

	it("anchors reading by component identity across appends and trimming; latest is explicit", () => {
		const entries = Array.from({ length: 20 }, (_, i) => new Rows([`line ${i}`]));
		const window = new ConversationWindow(() => entries);
		window.render(80, 5);
		window.scroll(-3);
		const reading = window.render(80, 5);
		entries.push(new Rows(["new response"]));
		entries.shift();
		expect(window.render(80, 5)).toEqual(reading);
		expect(window.following).toBe(false);
		window.latest();
		expect(window.render(80, 5).at(-1)).toBe("new response");
	});

	it("freezes a selected streaming response, copies only selected columns and preserves reading on release", () => {
		const entry = new Rows(["hello world", "second line"]);
		const window = new ConversationWindow(() => [entry]);
		window.render(30, 3);
		window.select({ row: 0, column: 6 }, true);
		window.select({ row: 1, column: 6 }, false);
		entry.lines = ["replacement", "more tokens"];
		entry.invalidate();
		expect(window.selectionText()).toBe("world\nsecond");
		expect(stripAnsi(window.render(30, 3).join("\n"))).toContain("hello world");
		expect(window.following).toBe(false);
		window.latest();
		expect(window.selectionText()).toBeUndefined();
		expect(window.render(30, 3)).toEqual(entry.lines);
	});

	it("bounds cached bytes even after traversing many large messages", () => {
		const entries = Array.from({ length: 100 }, () => new Rows(["a".repeat(10000)]));
		const window = new ConversationWindow(() => entries, 32000);
		window.render(80, 2);
		for (let i = 0; i < 100; i++) {
			window.scroll(-2);
			window.render(80, 2);
		}
		expect(window.cachedBytes).toBeLessThanOrEqual(32000);
	});
});

describe("Workbench layout", () => {
	beforeAll(() => initTheme("dark"));
	it("keeps explicit user shell output and errors visible above conversation", () => {
		const conversation = new Container();
		const shell = new BashExecutionComponent("printf hello", { requestRender() {} } as unknown as TUI);
		shell.appendOutput("hello\n");
		shell.setComplete(1, false);
		conversation.addChild(shell);
		const view = new WorkbenchComponent({ conversation, editor: new Container(), dock: [], viewportRows: () => 30 });
		const lines = view.render(100).map(stripAnsi);
		const heading = lines.findIndex((line) => line.includes("Conversation"));
		expect(lines.slice(0, heading).join("\n")).toContain("hello");
		expect(lines.slice(0, heading).join("\n")).toContain("exit 1");
	});
	function setup() {
		const conversation = new Container();
		conversation.addChild(new Text("conversation body", 0, 0));
		const editor = new Container();
		editor.addChild(new Text("input across the entire screen", 0, 0));
		const status = new Text("status across the entire screen", 0, 0);
		const view = new WorkbenchComponent({ conversation, editor, dock: [status], viewportRows: () => 30 });
		return { view, editor };
	}
	it("clears invisible hit targets when a large editor takes over the screen", () => {
		const { view, editor } = setup();
		view.render(110);
		expect(view.conversationHeight).toBeGreaterThan(0);
		editor.addChild(new Rows(Array.from({ length: 29 }, () => "editor row")));
		view.render(110);
		expect(view.conversationHeight).toBe(0);
		expect(view.headerAction(28)).toBeUndefined();
	});
	it("removes empty upper space, keeps dock full width, and mounts the editor for overlay focus restoration", () => {
		const { view, editor } = setup();
		const lines = view.render(110).map(stripAnsi);
		expect(lines).toHaveLength(30);
		expect(lines[0]).toContain("Conversation");
		expect(lines.at(-2)?.trimEnd()).toBe("status across the entire screen");
		expect(lines.at(-1)?.trimEnd()).toBe("input across the entire screen");
		expect(view.children).toContain(editor);
	});
	it("uses a bounded upper area and gives conversation the released rows on completion", () => {
		const { view } = setup();
		view.setInspector(["Work", "active step", "Team", "reviewer running"]);
		view.setExecution(new Rows(Array.from({ length: 50 }, (_, i) => `diff ${i}`)));
		const running = view.render(110);
		const conversationStart = running.findIndex((line) => stripAnsi(line).includes("Conversation"));
		expect(conversationStart).toBeGreaterThan(2);
		expect(conversationStart).toBeLessThan(19);
		view.setExecution(undefined);
		view.setInspector(["Work complete"]);
		const done = view.render(110);
		expect(done.findIndex((line) => stripAnsi(line).includes("Conversation"))).toBe(1);
		for (const width of [1, 20, 60, 110]) {
			for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
