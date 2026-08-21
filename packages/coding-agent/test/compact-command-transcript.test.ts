import {
	type Component,
	Container,
	type OverlayHandle,
	type OverlayOptions,
	setKeybindings,
	Text,
	type TUI,
} from "@caupulican/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import {
	ACTION_TRANSCRIPT_SEGMENT_LIMIT,
	ActionTranscriptComponent,
} from "../src/modes/interactive/components/action-transcript.ts";
import { ActiveToolCallRegistry } from "../src/modes/interactive/components/active-tool-call-registry.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { isExpandable } from "../src/modes/interactive/components/expandable-text.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
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

function completedAction(toolName: string, toolCallId: string, args: unknown, isError = false): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		toolName,
		toolCallId,
		args,
		{},
		undefined,
		createFakeTui(),
		process.cwd(),
	);
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: `${toolName} output` }], isError });
	return component;
}

function renderedText(component: Component, width = 120): string {
	return stripAnsi(component.render(width).join("\n"));
}

describe("compact action transcript", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("collapses consecutive successful Bash calls to one transcript-linked action row", () => {
		const first = completedBash("printf first", "first output");
		const second = completedBash("printf second", "second output");
		const group = new ActionTranscriptComponent([first, second]);

		const collapsed = renderedText(group);
		const nonblank = collapsed.split("\n").filter((line) => line.trim().length > 0);

		expect(nonblank).toHaveLength(1);
		expect(nonblank[0]).toContain("Performed 2 actions");
		expect(nonblank[0]).toContain("ctrl+t to view transcript");
		expect(collapsed).not.toContain("printf first");
		expect(collapsed).not.toContain("first output");
	});

	test("keeps failed actions in the same counter row", () => {
		const succeeded = completedBash("printf ok", "ok output");
		const failed = completedBash("exit 7", "failure output", true);
		const group = new ActionTranscriptComponent([succeeded, failed]);

		const collapsed = renderedText(group);
		expect(collapsed).toContain("Performed 2 actions");
		expect(collapsed).toContain("1 failed");
		expect(collapsed).not.toContain("exit 7");
		expect(collapsed).not.toContain("failure output");
		expect(group.canAccept()).toBe(true);
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
		const group = new ActionTranscriptComponent([pending]);

		const collapsed = renderedText(group);
		expect(collapsed).toContain("Performing 1 action");
		expect(collapsed).toContain("ctrl+t to view transcript");
		expect(collapsed).not.toContain("printf pending");
	});

	test("wraps the first agent Bash call so it is compact before a second call arrives", () => {
		const component = completedBash("printf first", "first output");
		type AppendToolExecutionHost = {
			chatContainer: Container;
			transcriptActionsExpanded: boolean;
			trimLiveTuiHistory(): void;
		};
		const fakeThis: AppendToolExecutionHost = {
			chatContainer: new Container(),
			transcriptActionsExpanded: false,
			trimLiveTuiHistory: () => {},
		};
		const appendTranscriptAction = (
			InteractiveMode.prototype as unknown as {
				appendTranscriptAction(this: AppendToolExecutionHost, component: ToolExecutionComponent): void;
			}
		).appendTranscriptAction;

		appendTranscriptAction.call(fakeThis, component);

		expect(fakeThis.chatContainer.children).toHaveLength(1);
		expect(renderedText(fakeThis.chatContainer.children[0])).toContain("Performed 1 action");
		expect(renderedText(fakeThis.chatContainer.children[0])).not.toContain("printf first");
	});

	test("routes every adjacent model tool through one action transcript row", () => {
		const components = [
			completedAction("skill", "tool-skill", { name: "evidence-gated-tdd" }),
			completedAction("create_goal", "tool-goal", { objective: "Unify presentation" }),
			completedAction("read", "tool-read", { path: "README.md" }),
			completedBash("printf verified", "verified"),
			completedAction("extension_probe", "tool-extension", { target: "provider" }),
		];
		type AppendToolExecutionHost = {
			chatContainer: Container;
			transcriptActionsExpanded: boolean;
			trimLiveTuiHistory(): void;
		};
		const fakeThis: AppendToolExecutionHost = {
			chatContainer: new Container(),
			transcriptActionsExpanded: false,
			trimLiveTuiHistory: () => {},
		};
		const appendTranscriptAction = (
			InteractiveMode.prototype as unknown as {
				appendTranscriptAction(this: AppendToolExecutionHost, component: ToolExecutionComponent): void;
			}
		).appendTranscriptAction;

		for (const component of components) appendTranscriptAction.call(fakeThis, component);

		expect(fakeThis.chatContainer.children).toHaveLength(1);
		const collapsed = renderedText(fakeThis.chatContainer.children[0]);
		expect(collapsed).toContain("Performed 5 actions");
		expect(collapsed).toContain("ctrl+t to view transcript");
		expect(collapsed).not.toContain("evidence-gated-tdd");
		expect(collapsed).not.toContain("README.md");
		expect(collapsed).not.toContain("printf verified");
	});

	test("keeps model responses in chronology between action transcript segments", () => {
		type AppendToolExecutionHost = {
			chatContainer: Container;
			transcriptActionsExpanded: boolean;
			trimLiveTuiHistory(): void;
		};
		const fakeThis: AppendToolExecutionHost = {
			chatContainer: new Container(),
			transcriptActionsExpanded: false,
			trimLiveTuiHistory: () => {},
		};
		const appendTranscriptAction = (
			InteractiveMode.prototype as unknown as {
				appendTranscriptAction(this: AppendToolExecutionHost, component: ToolExecutionComponent): void;
			}
		).appendTranscriptAction;

		appendTranscriptAction.call(fakeThis, completedAction("read", "read-before", { path: "before.ts" }));
		fakeThis.chatContainer.addChild(new Text("Model response", 0, 0));
		appendTranscriptAction.call(fakeThis, completedAction("goal", "goal-after", { action: "status" }));

		expect(fakeThis.chatContainer.children).toHaveLength(3);
		expect(renderedText(fakeThis.chatContainer.children[0])).toContain("Performed 1 action");
		expect(renderedText(fakeThis.chatContainer.children[1]).trimEnd()).toBe("Model response");
		expect(renderedText(fakeThis.chatContainer.children[2])).toContain("Performed 1 action");
	});

	test("does not split one visual action run on invisible assistant turns", () => {
		type AppendToolExecutionHost = {
			chatContainer: Container;
			transcriptActionsExpanded: boolean;
			trimLiveTuiHistory(): void;
		};
		const fakeThis: AppendToolExecutionHost = {
			chatContainer: new Container(),
			transcriptActionsExpanded: false,
			trimLiveTuiHistory: () => {},
		};
		const appendTranscriptAction = (
			InteractiveMode.prototype as unknown as {
				appendTranscriptAction(this: AppendToolExecutionHost, component: ToolExecutionComponent): void;
			}
		).appendTranscriptAction;

		appendTranscriptAction.call(fakeThis, completedAction("read", "read-before", { path: "before.ts" }));
		fakeThis.chatContainer.addChild(new AssistantMessageComponent());
		appendTranscriptAction.call(fakeThis, completedAction("goal", "goal-after", { action: "status" }));

		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderedText(fakeThis.chatContainer.children[0])).toContain("Performed 2 actions");
		expect(renderedText(fakeThis.chatContainer.children[1])).toBe("");
	});

	test("counts repeated calls without relocating or erasing an earlier action", () => {
		type AttachToolExecutionHost = {
			chatContainer: Container;
			transcriptActionsExpanded: boolean;
			activeToolCalls: ActiveToolCallRegistry;
			settingsManager: { getShowImages(): boolean; getImageWidthCells(): number };
			sessionManager: { getCwd(): string };
			ui: TUI;
			trimLiveTuiHistory(): void;
			getRegisteredToolDefinition(): undefined;
			appendTranscriptAction(component: ToolExecutionComponent): void;
		};
		const appendTranscriptAction = (
			InteractiveMode.prototype as unknown as {
				appendTranscriptAction(this: AttachToolExecutionHost, component: ToolExecutionComponent): void;
			}
		).appendTranscriptAction;
		const cwd = process.cwd();
		const fakeThis: AttachToolExecutionHost = {
			chatContainer: new Container(),
			transcriptActionsExpanded: false,
			activeToolCalls: new ActiveToolCallRegistry(),
			settingsManager: { getShowImages: () => true, getImageWidthCells: () => 60 },
			sessionManager: { getCwd: () => cwd },
			ui: createFakeTui(),
			trimLiveTuiHistory: () => {},
			getRegisteredToolDefinition: () => undefined,
			appendTranscriptAction(component) {
				appendTranscriptAction.call(this, component);
			},
		};
		const attachToolExecutionComponent = (
			InteractiveMode.prototype as unknown as {
				attachToolExecutionComponent(
					this: AttachToolExecutionHost,
					toolName: string,
					toolCallId: string,
					args: unknown,
				): ToolExecutionComponent;
			}
		).attachToolExecutionComponent;

		const first = attachToolExecutionComponent.call(fakeThis, "read", "read-1", { path: "README.md" });
		first.updateResult({ content: [{ type: "text", text: "first" }], isError: false });
		fakeThis.activeToolCalls.finish("read-1");
		const second = attachToolExecutionComponent.call(fakeThis, "read", "read-2", { path: "README.md" });
		second.updateResult({ content: [{ type: "text", text: "second" }], isError: false });

		expect(fakeThis.chatContainer.children).toHaveLength(1);
		expect(renderedText(fakeThis.chatContainer.children[0])).toContain("Performed 2 actions");
	});

	test("bounds each compact action segment", () => {
		const commands = Array.from({ length: ACTION_TRANSCRIPT_SEGMENT_LIMIT }, (_, index) =>
			completedBash(`printf ${index}`, `output ${index}`),
		);
		const group = new ActionTranscriptComponent(commands);

		expect(group.canAccept()).toBe(false);
	});

	test("keeps the main-chat action projection collapsed outside Ctrl+T", () => {
		const group = new ActionTranscriptComponent([completedBash("printf private", "private output")]);

		expect(isExpandable(group)).toBe(false);
		expect(renderedText(group)).toContain("Performed 1 action");
		expect(renderedText(group)).not.toContain("printf private");
	});

	test("Ctrl+T opens expanded action details and restores the prior tool state on close", () => {
		const first = completedBash("printf first", "first output");
		const second = completedBash("printf second", "second output");
		const group = new ActionTranscriptComponent([first, second]);
		const source = new Container();
		source.addChild(group);
		let toolsExpanded = false;
		let actionsExpanded = false;
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
			},
			getActionsExpanded: () => actionsExpanded,
			setActionsExpanded: (expanded) => {
				actionsExpanded = expanded;
				group.setTranscriptExpanded(expanded);
			},
			showOverlay: (component, options) => {
				overlay = component;
				overlayOptions = options;
				return overlayHandle;
			},
		});

		expect(toolsExpanded).toBe(true);
		expect(actionsExpanded).toBe(true);
		expect(overlay).toBeDefined();
		const expandedTranscript = renderedText(overlay as Component);
		expect(expandedTranscript).toContain("printf first");
		expect(expandedTranscript).toContain("first output");
		expect(expandedTranscript).toContain("printf second");
		expect(expandedTranscript).toContain("second output");

		handle.hide();
		expect(toolsExpanded).toBe(false);
		expect(actionsExpanded).toBe(false);
		expect(renderedText(group)).toContain("Performed 2 actions");
	});

	test("assigns Ctrl+T to transcript and preserves thinking visibility on the former transcript chord", () => {
		const keybindings = new KeybindingsManager();
		expect(keybindings.getKeys("app.transcript.open")).toEqual(["ctrl+t"]);
		expect(keybindings.getKeys("app.thinking.toggle")).toEqual(["shift+pageUp"]);
	});
});
