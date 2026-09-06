import type { AgentMessage } from "@caupulican/pi-agent-core";
import { Container, Text } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { WorkbenchComponent } from "../src/modes/interactive/components/workbench.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { WorkbenchController } from "../src/modes/interactive/workbench-controller.ts";
import { WorkspaceObservation } from "../src/modes/interactive/workbench-workspace.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { workbenchCounterFixture } from "./fixtures/session-failures.ts";

describe("Workbench input boundary", () => {
	beforeAll(() => initTheme("dark"));
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
		controller.record(new Text("fresh result", 0, 0), false);
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
		for (const failed of workbenchCounterFixture.firstCycle) {
			controller.record(new Text(failed ? "failure detail" : "first-cycle success", 0, 0), failed);
		}
		expect(stripAnsi(view.render(100).join("\n"))).toContain("failure detail");
		controller.complete();
		let text = stripAnsi(view.render(100).join("\n"));
		expect(text).toContain(workbenchCounterFixture.firstSummary);
		expect(text).toContain("1 failure receipts");
		expect(text).toContain("failure detail");
		controller.beginCycle();
		for (const failed of workbenchCounterFixture.secondCycle) {
			controller.record(new Text("successful verbose result", 0, 0), failed);
		}
		controller.complete();
		text = stripAnsi(view.render(100).join("\n"));
		expect(text).toContain(workbenchCounterFixture.secondSummary);
		expect(text).toContain("1 failure receipts");
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
		controller.record(new Text(Array.from({ length: 40 }, (_, i) => `execution ${i}`).join("\n"), 0, 0), false);
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
