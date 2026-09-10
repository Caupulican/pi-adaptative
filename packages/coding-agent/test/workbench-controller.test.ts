import type { AgentMessage } from "@caupulican/pi-agent-core";
import { Container, Text } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { createBackgroundToolTerminalMessage } from "../src/core/background-tool-task-controller.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { WorkbenchComponent } from "../src/modes/interactive/components/workbench.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { WorkbenchController } from "../src/modes/interactive/workbench-controller.ts";
import { WorkspaceObservation } from "../src/modes/interactive/workbench-workspace.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { workbenchCounterFixture } from "./fixtures/session-failures.ts";

describe("Workbench input boundary", () => {
	beforeAll(() => initTheme("dark"));
	it("hands the mouse over and back on the toggle key, reporting the owner in the hint row", () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 40,
		});
		let captured = false;
		const notices: string[] = [];
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice: (text) => notices.push(text),
			mouse: { enabled: () => captured, set: (enabled) => (captured = enabled) },
		});
		const hint = () => stripAnsi(view.render(120).at(-1) ?? "");
		expect(hint()).toContain("mouse: off");
		expect(controller.handleInput("\x1bm")).toEqual({ consume: true });
		expect(captured).toBe(true);
		expect(hint()).toContain("mouse: on");
		expect(notices.at(-1)).toContain("Mouse captured");
		controller.handleInput("\x1bm");
		expect(captured).toBe(false);
		expect(hint()).toContain("mouse: off");
		// Reports that still arrive (an emulator flushing after release) are consumed, never typed.
		expect(controller.handleInput("\x1b[<0;5;5M")).toEqual({ consume: true });
	});

	it("refuses the toggle without a terminal mouse instead of pretending", () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 40,
		});
		const notices: { text: string; error?: boolean }[] = [];
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice: (text, error) => notices.push({ text, error }),
		});
		controller.handleInput("\x1bm");
		expect(notices).toEqual([{ text: "This terminal has no mouse to hand over", error: true }]);
	});

	it("keeps replayed and late background outcomes out of the next cycle's count, including narrow panes", () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 40,
		});
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
		});
		controller.beginCycle();
		controller.record(undefined, {
			toolCallId: "old-call",
			isError: false,
			details: {
				piToolInvocation: {
					version: 1,
					requestId: "old-request",
					execution: "running",
					postprocessingFailures: [],
				},
			},
		});
		controller.complete();
		controller.beginCycle();
		controller.record(new Text("current result", 0, 0), {
			toolCallId: "new-call",
			isError: false,
			details: {
				piToolInvocation: {
					version: 1,
					requestId: "new-request",
					execution: "completed",
					operationStatus: "success",
					postprocessingFailures: [],
				},
			},
		});
		const terminal = {
			role: "custom" as const,
			timestamp: 0,
			...createBackgroundToolTerminalMessage([
				{
					sessionId: "fixture-session",
					taskId: "tool-task-1",
					toolCallId: "old-call",
					toolName: "fixture",
					status: "failed",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T00:00:01.000Z",
					elapsedBeforeHandoffMs: 1,
					summary: "fixture",
					output: "fixture",
					piToolInvocation: {
						version: 1,
						requestId: "old-request",
						execution: "completed",
						operationStatus: "error",
						postprocessingFailures: [],
					},
				},
			]),
		};
		controller.recordBackground(terminal);
		controller.recordBackground(terminal);
		for (const width of [40, 80, 110]) {
			const rendered = stripAnsi(view.render(width).join("\n"));
			expect(rendered).toContain("Cycle: 1 calls");
			expect(rendered).toContain("retained: 1 error results");
			expect(rendered).not.toContain("negative outcomes");
			expect(rendered).not.toContain("running");
		}
		controller.dispose();
	});
	it("retains a visible file-effect receipt when observation finishes after the agent stops", async () => {
		let calls = 0;
		const workspace = new WorkspaceObservation({
			snapshot: async () => ({ files: new Map(++calls === 1 ? [] : [["silent.py", "changed"]]), limited: false }),
			patch: async () => "+change",
		});
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 20,
		});
		const controller = new WorkbenchController(
			view,
			{
				keybindings: new KeybindingsManager(),
				isInteractive: () => true,
				requestRender() {},
				messages: () => [],
				copy: async () => {},
				notice() {},
			},
			workspace,
		);
		controller.beginCycle("/fixture");
		const pending = controller.afterTool("python");
		controller.complete();
		await pending;
		const text = stripAnsi(view.render(110).join("\n"));
		expect(text).toContain("1 file effects");
		expect(text).toContain("+change");
		// The next cycle keeps the last evidence on screen until it produces its own.
		controller.beginCycle();
		expect(stripAnsi(view.render(110).join("\n"))).toContain("1 file effects");
		controller.record(new Text("fresh result", 0, 0), { toolCallId: "fresh", isError: false, details: {} });
		const next = stripAnsi(view.render(110).join("\n"));
		expect(next).toContain("fresh result");
		expect(next).not.toContain("file effects");
		controller.dispose();
	});
	it("keeps evidence after completion, retains failure receipts, and collapses only on request", () => {
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 30,
		});
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
		});
		controller.beginCycle();
		for (const [index, failed] of workbenchCounterFixture.firstCycle.entries()) {
			controller.record(new Text(failed ? "failure detail" : "first-cycle success", 0, 0), {
				toolCallId: `first-${index}`,
				isError: failed,
				details: {},
			});
		}
		expect(stripAnsi(view.render(100).join("\n"))).toContain("failure detail");
		controller.complete();
		let text = stripAnsi(view.render(100).join("\n"));
		expect(text).toContain(workbenchCounterFixture.firstSummary);
		expect(text).toContain("retained: 1 error results");
		expect(text).toContain("failure detail");
		controller.beginCycle();
		for (const [index, failed] of workbenchCounterFixture.secondCycle.entries()) {
			controller.record(new Text("successful verbose result", 0, 0), {
				toolCallId: `second-${index}`,
				isError: failed,
				details: {},
			});
		}
		controller.complete();
		text = stripAnsi(view.render(100).join("\n"));
		expect(text).toContain(workbenchCounterFixture.secondSummary);
		expect(text).toContain("retained: 1 error results");
		expect(text).toContain("successful verbose result");
		expect(text).not.toContain("failure detail");
		controller.handleInput("\x1bo");
		text = stripAnsi(view.render(100).join("\n"));
		expect(view.upperHeight).toBe(0);
		expect(text).not.toContain("successful verbose result");
		expect(text).toMatch(/▸ .*Execution/);
		controller.handleInput("\x1bo");
		expect(stripAnsi(view.render(100).join("\n"))).toContain("successful verbose result");
		controller.dispose();
	});
	it("copies canonical conversation beyond the visible window without opening tool payloads", async () => {
		const messages: AgentMessage[] = Array.from({ length: 300 }, (_, i) => ({
			role: "user",
			content: `message ${i}`,
			timestamp: i,
		}));
		messages.push({
			role: "toolResult",
			toolCallId: "cold",
			toolName: "read",
			isError: false,
			timestamp: 500,
			get content(): never {
				throw new Error("must not hydrate tools to copy conversation");
			},
		});
		const copies: string[] = [];
		const view = new WorkbenchComponent({
			conversation: new Container(),
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 20,
		});
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => messages,
			copy: async (text) => {
				copies.push(text);
			},
			notice() {},
		});
		await controller.copy(true);
		expect(copies[0]).toContain("message 0");
		expect(copies[0]).toContain("message 299");
		controller.dispose();
	});
	it("does not intercept editor input or modal navigation; remapped navigation owns conversation only", () => {
		const chat = new Container();
		chat.addChild(new Text(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), 0, 0));
		const view = new WorkbenchComponent({
			conversation: chat,
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 30,
		});
		let interactive = false;
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager({ "app.conversation.pageUp": "alt+u" }),
			isInteractive: () => interactive,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
		});
		view.render(110);
		expect(controller.handleInput("\x1bu")).toBeUndefined();
		interactive = true;
		expect(controller.handleInput("x")).toBeUndefined();
		expect(controller.handleInput("\x1b[A")).toBeUndefined();
		expect(controller.handleInput("\x1bu")).toEqual({ consume: true });
		expect(view.conversation.following).toBe(false);
		controller.dispose();
	});
	it("routes wheel input by pane rectangle, including narrow stacked execution", () => {
		const chat = new Container();
		chat.addChild(new Text(Array.from({ length: 100 }, (_, i) => `chat ${i}`).join("\n"), 0, 0));
		const view = new WorkbenchComponent({
			conversation: chat,
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 40,
		});
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async () => {},
			notice() {},
		});
		view.setInspector([{ title: "Work plan", body: ["active"] }]);
		controller.record(new Text(Array.from({ length: 40 }, (_, i) => `execution ${i}`).join("\n"), 0, 0), {
			toolCallId: "scroll-fixture",
			isError: false,
			details: {},
		});
		view.render(110);
		expect(stripAnsi(view.render(110).join("\n"))).toContain("execution 39");
		controller.handleInput("\x1b[<64;50;4M");
		const scrolled = stripAnsi(view.render(110).join("\n"));
		expect(scrolled).toContain("execution 36");
		expect(scrolled).not.toContain("execution 39");
		expect(view.conversation.following).toBe(true);
		view.render(40);
		controller.handleInput("\x1b[<64;2;6M");
		expect(stripAnsi(view.render(40).join("\n"))).not.toContain("execution 39");
		expect(view.conversation.following).toBe(true);
		controller.handleInput(`\x1b[<64;2;${view.conversationTop + 2}M`);
		expect(view.conversation.following).toBe(false);
		controller.dispose();
	});
	it("mouse selection pauses live text, copies selection and leaves the editor untouched", async () => {
		const chat = new Container();
		chat.addChild(new Text("hello world", 0, 0));
		const view = new WorkbenchComponent({
			conversation: chat,
			editor: new Container(),
			dock: [],
			brand: "pi",
			viewportRows: () => 20,
		});
		const copies: string[] = [];
		const controller = new WorkbenchController(view, {
			keybindings: new KeybindingsManager(),
			isInteractive: () => true,
			requestRender() {},
			messages: () => [],
			copy: async (text) => {
				copies.push(text);
			},
			notice() {},
		});
		view.render(80);
		expect(view.conversationTop).toBe(10);
		expect(view.conversationHeight).toBe(9);
		// The single row anchors to the bottom of the conversation area (row 18, 1-based 19).
		controller.handleInput("\x1b[<0;1;19M"); // The gutter must not select text.
		expect(view.conversation.following).toBe(true);
		// A click without a drag only focuses the pane: nothing freezes, following continues.
		controller.handleInput("\x1b[<0;2;19M");
		controller.handleInput("\x1b[<0;2;19m");
		expect(view.conversation.following).toBe(true);
		expect(view.conversation.selectionText()).toBeUndefined();
		controller.handleInput("\x1b[<0;2;19M");
		controller.handleInput("\x1b[<32;7;19M");
		controller.handleInput("\x1b[<0;7;19m");
		await controller.copy(false);
		expect(copies).toEqual(["hello"]);
		expect(view.conversation.following).toBe(false);
		controller.dispose();
	});
});
