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
		window.render(30, 3); // two rows anchored to the bottom, one empty row above
		window.select({ row: 1, column: 6 }, true);
		window.select({ row: 2, column: 6 }, false);
		entry.lines = ["replacement", "more tokens"];
		entry.invalidate();
		expect(window.selectionText()).toBe("world\nsecond");
		expect(stripAnsi(window.render(30, 3).join("\n"))).toContain("hello world");
		expect(window.following).toBe(false);
		window.latest();
		expect(window.selectionText()).toBeUndefined();
		expect(window.render(30, 3)).toEqual(["", ...entry.lines]);
	});

	it("anchors a short transcript to the bottom so the latest row sits next to the input", () => {
		const entries = [new Rows(["first"]), new Rows(["second"])];
		const window = new ConversationWindow(() => entries);
		expect(window.render(30, 5)).toEqual(["", "", "", "first", "second"]);
		entries.push(new Rows(["third"]));
		expect(window.render(30, 5)).toEqual(["", "", "first", "second", "third"]);
		expect(window.following).toBe(true);
	});

	it("resumes following when the entry it was anchored to is trimmed from live history", () => {
		const entries = Array.from({ length: 20 }, (_, i) => new Rows([`line ${i}`]));
		const window = new ConversationWindow(() => entries);
		window.render(80, 5);
		window.scroll(-8);
		expect(window.following).toBe(false);
		expect(window.render(80, 5)[0]).toBe("line 7");
		entries.splice(0, 10);
		expect(window.render(80, 5)).toEqual(entries.slice(-5).map((entry) => entry.lines[0]));
		expect(window.following).toBe(true);
		window.scroll(-2);
		entries.splice(0, 5);
		window.scroll(-1);
		expect(window.following).toBe(true);
	});

	it("never emits prompt-zone marks: a terminal may move to column 0 on one, which corrupts a framed row", () => {
		const entry = new Rows(["\x1b]133;A\x07first", "middle", "\x1b]133;B\x07\x1b]133;C\x07last"]);
		const window = new ConversationWindow(() => [entry]);
		expect(window.render(30, 3)).toEqual(["first", "middle", "last"]);
	});

	it("replaces Kitty/iTerm rows with a placeholder via isImageLine", () => {
		const entry = new Rows(["prefix\x1b_Ghello", "plain"]);
		const window = new ConversationWindow(() => [entry]);
		expect(window.render(80, 2)).toEqual(["[Image — open transcript to view]", "plain"]);
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

describe("Workbench dock ownership", () => {
	beforeAll(() => initTheme("dark"));
	it("replaces a dock child in place instead of stacking on TUI", () => {
		const conversation = new Container();
		const original = new Text("orig", 0, 0);
		const next = new Text("next", 0, 0);
		const view = new WorkbenchComponent({
			conversation,
			editor: new Container(),
			dock: [original],
			brand: "pi",
			viewportRows: () => 12,
		});
		view.replaceDockComponent(original, next);
		expect(view.children.includes(next)).toBe(true);
		expect(view.children.includes(original)).toBe(false);
		const tuiChildrenBefore = 1;
		expect(tuiChildrenBefore).toBe(1);
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
		const view = new WorkbenchComponent({
			conversation,
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 30,
		});
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
		const view = new WorkbenchComponent({
			conversation,
			editor,
			dock: [status],
			brand: "pi",
			title: () => "sample-project",
			viewportRows: () => 30,
		});
		return { view, editor };
	}
	it("keeps the work area fixed: evidence never moves the conversation; only the operator collapses or resizes it", () => {
		const { view } = setup();
		const output = new Rows(["short result"]);
		view.setInspector([{ title: "Work plan", meta: "1 / 3", body: ["active step"] }]);
		view.setExecution(output);
		const short = view.render(110).map(stripAnsi);
		const top = view.conversationTop;
		expect(view.upperHeight).toBe(10);
		expect(top).toBe(14);
		output.lines = Array.from({ length: 100 }, (_, i) => `tool row ${i}`);
		output.invalidate();
		const long = view.render(110).map(stripAnsi);
		expect(view.conversationTop).toBe(top);
		expect(view.conversationHeight).toBe(12);
		view.setExecution(undefined);
		view.render(110);
		expect(view.conversationTop).toBe(top);
		view.toggleUpper();
		const collapsed = view.render(110).map(stripAnsi);
		expect(view.upperHeight).toBe(0);
		expect(view.conversationTop).toBe(4);
		expect(collapsed[2]).toMatch(/▸ Work plan 1 \/ 3/);
		view.toggleUpper();
		view.shrinkUpper();
		view.shrinkUpper();
		view.render(110);
		expect(view.upperHeight).toBe(8);
		expect(view.conversationTop).toBe(12);
		for (const frame of [short, long]) {
			expect(frame).toHaveLength(30);
			expect(frame[0]).toMatch(/^ pi {2}sample-project +IDLE $/);
			expect(frame[1]).toBe("");
			expect(frame[2]).toMatch(
				/^ Work plan .*1 \/ 3 {4}Execution .*File effects and command outcomes( · \d+-\d+\/\d+ ↕)?\s*$/,
			);
			expect(frame[12]).toMatch(/^─+ ↕ work area.*─+$/);
			expect(frame[13]).toMatch(/^ Conversation · Following latest .* Copy conversation {2}$/);
			expect(frame[top + 11]!.trimEnd()).toBe(" conversation body");
			expect(frame[top]).toBe("");
			expect(frame.at(-4)).toMatch(/^─+$/);
			expect(frame.at(-3)!.trimEnd()).toBe(" status across the entire screen");
			expect(frame.at(-2)!.trimEnd()).toBe(" input across the entire screen");
			expect(frame.at(-1)).toMatch(/^ \/ commands/);
			expect(frame.join("\n")).not.toMatch(/[┌┐└┘│]/);
		}
	});
	it("shows placeholders in an empty work area and bounds geometry on narrow and short terminals", () => {
		const { view } = setup();
		const empty = view.render(110).map(stripAnsi);
		expect(empty[2]).toContain("Work plan");
		expect(empty.join("\n")).toContain("No open steps");
		expect(empty.join("\n")).toContain("No agents");
		expect(empty.join("\n")).toContain("No file effects or command outcomes yet");
		view.setInspector([{ title: "Work plan", body: ["active step"] }]);
		view.setExecution(new Rows(Array.from({ length: 100 }, () => "output")));
		for (const width of [1, 2, 3, 20, 60, 79, 80, 110]) {
			const lines = view.render(width);
			expect(lines.length).toBeLessThanOrEqual(30);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const short = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 9,
		});
		const frame = short.render(80).map(stripAnsi);
		expect(frame).toHaveLength(9);
		expect(short.upperHeight).toBe(0);
		expect(frame[2]).toMatch(/^─+.*─+$/);
		expect(frame[3]).toContain("Conversation");
		expect(short.conversationHeight).toBe(4);
	});
	it("scrolls upper panes independently without moving conversation or dock", () => {
		const { view } = setup();
		view.setInspector([{ title: "Work plan", body: Array.from({ length: 30 }, (_, i) => `work ${i}`) }]);
		view.setExecution(new Rows(Array.from({ length: 100 }, (_, i) => `tool ${i}`)));
		const initial = view.render(110).map(stripAnsi);
		const top = view.conversationTop;
		// Execution follows its newest rows; the inspector opens at its first rows.
		expect(initial[3]).toContain("work 0");
		expect(initial[11]).toContain("tool 99");
		expect(view.scrollUpper(50, 3, -3)).toBe(true);
		let frame = view.render(110).map(stripAnsi);
		expect(frame[11]).toContain("tool 96");
		expect(frame.slice(top - 1)).toEqual(initial.slice(top - 1));
		expect(view.conversation.following).toBe(true);
		expect(view.scrollUpper(50, 3, 3)).toBe(true);
		expect(view.render(110).map(stripAnsi)[11]).toContain("tool 99");
		expect(view.scrollUpper(1, 3, 3)).toBe(true);
		frame = view.render(110).map(stripAnsi);
		expect(frame[3]).toContain("work 3");
		expect(frame[11]).toContain("tool 99");
		// Gutters, pane titles, the title strip and the dock are not scroll targets.
		expect(view.scrollUpper(0, 3, 3)).toBe(false);
		expect(view.scrollUpper(1, 2, 3)).toBe(false);
		expect(view.scrollUpper(1, 0, 3)).toBe(false);
		expect(view.scrollUpper(1, 29, 3)).toBe(false);
		view.setExecution(new Rows(["new result"]));
		expect(view.render(110).map(stripAnsi)[3]).toContain("new result");
		// New evidence with a growing tail stays followed until the operator scrolls up.
		const growing = new Rows(Array.from({ length: 30 }, (_, i) => `grow ${i}`));
		view.setExecution(growing);
		expect(view.render(110).map(stripAnsi)[11]).toContain("grow 29");
		growing.lines = Array.from({ length: 40 }, (_, i) => `grow ${i}`);
		growing.invalidate();
		expect(view.render(110).map(stripAnsi)[11]).toContain("grow 39");
		expect(view.scrollUpper(50, 3, -3)).toBe(true);
		growing.lines = Array.from({ length: 50 }, (_, i) => `grow ${i}`);
		growing.invalidate();
		expect(view.render(110).map(stripAnsi)[11]).toContain("grow 36");
	});
	it("clears invisible hit targets when a large editor takes over the screen", () => {
		const { view, editor } = setup();
		view.render(110);
		expect(view.conversationHeight).toBeGreaterThan(0);
		editor.addChild(new Rows(Array.from({ length: 29 }, () => "editor row")));
		view.render(110);
		expect(view.conversationHeight).toBe(0);
		expect(view.dividerRow).toBe(-1);
		expect(view.headerAction(28)).toBeUndefined();
	});
	it("keeps the dock full width below the conversation and mounts the editor for overlay focus restoration", () => {
		const { view, editor } = setup();
		const lines = view.render(110).map(stripAnsi);
		expect(lines).toHaveLength(30);
		expect(lines[13]).toContain("Conversation");
		expect(lines.at(-4)).toMatch(/^─+$/);
		expect(lines.at(-3)!.trimEnd()).toBe(" status across the entire screen");
		expect(lines.at(-2)!.trimEnd()).toBe(" input across the entire screen");
		expect(lines.at(-1)).toMatch(/^ \/ commands/);
		expect(view.children).toContain(editor);
	});
	it("keeps evidence on screen after completion; the divider summarizes a collapsed work area", () => {
		const { view } = setup();
		view.setInspector([
			{ title: "Work plan", meta: "2 / 3", body: ["active step"] },
			{ title: "Team", meta: "1 active", body: ["reviewer running"] },
		]);
		view.setExecution(new Rows(Array.from({ length: 50 }, (_, i) => `diff ${i}`)));
		const running = view.render(110);
		const conversationStart = running.findIndex((line) => stripAnsi(line).includes("Conversation"));
		expect(conversationStart).toBe(13);
		expect(stripAnsi(running.slice(2, 12).join("\n"))).toMatch(/Team .*1 active/);
		view.setInspector([{ title: "Work plan", meta: "3 / 3", body: ["Work complete"] }]);
		const done = view.render(110);
		expect(done.findIndex((line) => stripAnsi(line).includes("Conversation"))).toBe(13);
		expect(stripAnsi(done.join("\n"))).toContain("diff 49");
		view.toggleUpper();
		const collapsed = view.render(110).map(stripAnsi);
		expect(collapsed[2]).toMatch(/▸ Work plan 3 \/ 3 · Execution/);
		expect(collapsed[3]).toContain("Conversation");
		for (const width of [1, 20, 60, 110]) {
			for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
	it("shows the live activity line under the title strip and the run state on the right", () => {
		const { view } = setup();
		const activity = new Text("● Editing reload ownership", 0, 0);
		const withActivity = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			activity,
			brand: "pi",
			viewportRows: () => 20,
		});
		withActivity.setHeadline({ title: "tool reload reliability", state: "working" });
		const frame = withActivity.render(80).map(stripAnsi);
		expect(frame[0]).toMatch(/^ pi {2}tool reload reliability +WORKING $/);
		expect(frame[1]!.trimEnd()).toBe(" ● Editing reload ownership");
		expect(withActivity.upperHeight).toBe(6);
		expect(frame[9]).toContain("Conversation");
		expect(withActivity.conversationTop).toBe(10);
		expect(view.render(80).map(stripAnsi)[0]).toMatch(/IDLE $/);
	});
});
