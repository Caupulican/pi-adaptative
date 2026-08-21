import {
	type Component,
	Container,
	type OverlayHandle,
	type OverlayOptions,
	setKeybindings,
	type TUI,
} from "@caupulican/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import { openTranscriptOverlay } from "../src/modes/interactive/components/transcript-overlay.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function completedBash(command: string, output: string, isError = false): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"bash",
		`tool-${command}`,
		{ command },
		{},
		createBashToolDefinition(process.cwd()),
		createFakeTui(),
		process.cwd(),
	);
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: output }], isError });
	return component;
}

function renderedText(component: Component, width = 120): string {
	return stripAnsi(component.render(width).join("\n"));
}

describe("compact command transcript", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("collapses consecutive successful Bash calls to one transcript-linked row", () => {
		const first = completedBash("printf first", "first output");
		const second = completedBash("printf second", "second output");
		const group = new ToolGroupComponent("bash", [first, second]);

		const collapsed = renderedText(group);
		const nonblank = collapsed.split("\n").filter((line) => line.trim().length > 0);

		expect(nonblank).toHaveLength(1);
		expect(nonblank[0]).toContain("Ran 2 commands");
		expect(nonblank[0]).toContain("ctrl+t to view transcript");
		expect(collapsed).not.toContain("printf first");
		expect(collapsed).not.toContain("first output");
	});

	test("keeps failed and pending commands in the same counter row", () => {
		const succeeded = completedBash("printf ok", "ok output");
		const failed = completedBash("exit 7", "failure output", true);
		const next = completedBash("printf later", "later output");
		const group = new ToolGroupComponent("bash", [succeeded, failed]);

		const collapsed = renderedText(group);
		expect(collapsed).toContain("Ran 2 commands");
		expect(collapsed).toContain("1 failed");
		expect(collapsed).not.toContain("exit 7");
		expect(collapsed).not.toContain("failure output");
		expect(group.canAccept(next)).toBe(true);
	});

	test("collapses a single pending command without leaking its command text", () => {
		const pending = new ToolExecutionComponent(
			"bash",
			"tool-pending",
			{ command: "printf pending" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const group = new ToolGroupComponent("bash", [pending]);

		const collapsed = renderedText(group);
		expect(collapsed).toContain("Running 1 command");
		expect(collapsed).toContain("ctrl+t to view transcript");
		expect(collapsed).not.toContain("printf pending");
	});

	test("wraps the first agent Bash call so it is compact before a second call arrives", () => {
		const component = completedBash("printf first", "first output");
		type AppendToolExecutionHost = {
			chatContainer: Container;
			toolOutputExpanded: boolean;
			trimLiveTuiHistory(): void;
		};
		const fakeThis: AppendToolExecutionHost = {
			chatContainer: new Container(),
			toolOutputExpanded: false,
			trimLiveTuiHistory: () => {},
		};
		const appendToolExecutionComponent = (
			InteractiveMode.prototype as unknown as {
				appendToolExecutionComponent(
					this: AppendToolExecutionHost,
					component: ToolExecutionComponent,
					allowGrouping: boolean,
				): void;
			}
		).appendToolExecutionComponent;

		appendToolExecutionComponent.call(fakeThis, component, true);

		expect(fakeThis.chatContainer.children).toHaveLength(1);
		expect(renderedText(fakeThis.chatContainer.children[0])).toContain("Ran 1 command");
		expect(renderedText(fakeThis.chatContainer.children[0])).not.toContain("printf first");
	});

	test("bounds each compact command group", () => {
		const commands = Array.from({ length: 32 }, (_, index) => completedBash(`printf ${index}`, `output ${index}`));
		const group = new ToolGroupComponent("bash", commands);

		expect(group.canAccept(completedBash("printf overflow", "overflow output"))).toBe(false);
	});

	test("Ctrl+T opens expanded command details and restores the prior tool state on close", () => {
		const first = completedBash("printf first", "first output");
		const second = completedBash("printf second", "second output");
		const group = new ToolGroupComponent("bash", [first, second]);
		const source = new Container();
		source.addChild(group);
		let toolsExpanded = false;
		let overlay: Component | undefined;
		let overlayOptions: OverlayOptions | undefined;
		let removed = false;
		const overlayHandle: OverlayHandle = {
			hide: () => {
				if (removed) return;
				removed = true;
				overlayOptions?.onRemove?.();
			},
			setHidden: () => {},
			isHidden: () => false,
			focus: () => {},
			unfocus: () => {},
			isFocused: () => true,
		};

		const handle = openTranscriptOverlay({
			source,
			viewportRows: () => 30,
			keybindings: new KeybindingsManager(),
			getToolsExpanded: () => toolsExpanded,
			setToolsExpanded: (expanded) => {
				toolsExpanded = expanded;
				group.setExpanded(expanded);
			},
			showOverlay: (component, options) => {
				overlay = component;
				overlayOptions = options;
				return overlayHandle;
			},
		});

		expect(toolsExpanded).toBe(true);
		expect(overlay).toBeDefined();
		const expandedTranscript = renderedText(overlay as Component);
		expect(expandedTranscript).toContain("printf first");
		expect(expandedTranscript).toContain("first output");
		expect(expandedTranscript).toContain("printf second");
		expect(expandedTranscript).toContain("second output");

		handle.hide();
		expect(toolsExpanded).toBe(false);
		expect(renderedText(group)).toContain("Ran 2 commands");
	});

	test("assigns Ctrl+T to transcript and preserves thinking visibility on the former transcript chord", () => {
		const keybindings = new KeybindingsManager();
		expect(keybindings.getKeys("app.transcript.open")).toEqual(["ctrl+t"]);
		expect(keybindings.getKeys("app.thinking.toggle")).toEqual(["shift+pageUp"]);
	});
});
