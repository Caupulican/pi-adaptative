import type { AgentMessage } from "@caupulican/pi-agent-core";
import { Container, Text } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { WorkbenchComponent } from "../src/modes/interactive/components/workbench.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { WorkbenchController } from "../src/modes/interactive/workbench-controller.ts";
import { WorkspaceObservation } from "../src/modes/interactive/workbench-workspace.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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
		expect(text).not.toContain("+change");
		controller.beginCycle();
		expect(stripAnsi(view.render(110).join("\n"))).not.toContain("file effects");
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
	it("mouse selection pauses live text, copies selection and leaves the editor untouched", async () => {
		const chat = new Container();
		chat.addChild(new Text("hello world", 0, 0));
		const view = new WorkbenchComponent({
			conversation: chat,
			editor: new Container(),
			dock: [],
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
		controller.handleInput("\x1b[<0;1;2M");
		controller.handleInput("\x1b[<32;6;2M");
		controller.handleInput("\x1b[<0;6;2m");
		await controller.copy(false);
		expect(copies).toEqual(["hello"]);
		expect(view.conversation.following).toBe(false);
		controller.dispose();
	});
});
