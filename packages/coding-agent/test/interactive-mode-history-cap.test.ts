import type { AgentMessage } from "@caupulican/pi-agent-core";
import { Container, Text } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function makeUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
	} as AgentMessage;
}

function makeAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
	} as AgentMessage;
}

function getText(message: AgentMessage): string {
	const content = (message as { content?: string | Array<{ text?: string }> }).content;
	if (typeof content === "string") return content;
	return content?.map((part) => part.text ?? "").join("") ?? "";
}

function callHistorySelector(messages: AgentMessage[]): {
	messages: AgentMessage[];
	omittedMessages: number;
	estimatedLines: number;
} {
	const ctx = Object.create((InteractiveMode as any).prototype);
	return (InteractiveMode as any).prototype.messagesForTuiHistoryReload.call(ctx, messages);
}

describe("InteractiveMode TUI reload history cap", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	test("keeps only the tail of long reload history", () => {
		const messages = Array.from({ length: 140 }, (_, index) =>
			makeUserMessage(Array.from({ length: 10 }, (__, line) => `message-${index}-line-${line}`).join("\n")),
		);

		const selected = callHistorySelector(messages);

		expect(selected.omittedMessages).toBeGreaterThan(0);
		expect(selected.estimatedLines).toBeLessThanOrEqual(1000);
		expect(getText(selected.messages[0])).not.toContain("message-0-line-0");
		expect(getText(selected.messages.at(-1)!)).toContain("message-139-line-9");
	});

	test("trims a single huge latest message below the reload cap", () => {
		const message = makeUserMessage(Array.from({ length: 1500 }, (_, line) => `huge-line-${line}`).join("\n"));

		const selected = callHistorySelector([message]);
		const renderedText = getText(selected.messages[0]);

		expect(selected.estimatedLines).toBeLessThanOrEqual(1000);
		expect(renderedText).toContain("omitted from TUI reload history");
		expect(renderedText).not.toContain("huge-line-0");
		expect(renderedText).toContain("huge-line-1499");
	});

	test("caps live chat component tree to protect redraw FPS", () => {
		const ctx = Object.create((InteractiveMode as any).prototype);
		ctx.chatContainer = new Container();
		ctx.toolPanels = { activeEntries: () => [] };
		ctx.liveHistoryHiddenNotice = undefined;
		ctx.liveHistoryHiddenComponents = 0;
		ctx.lastStatusSpacer = undefined;
		ctx.lastStatusText = undefined;
		ctx.streamingComponent = undefined;

		for (let i = 0; i < 300; i++) {
			ctx.chatContainer.addChild(new Text(`component-${i}`, 0, 0));
		}

		(InteractiveMode as any).prototype.trimLiveTuiHistory.call(ctx);

		expect(ctx.chatContainer.children.length).toBeLessThanOrEqual(221);
		expect(ctx.liveHistoryHiddenComponents).toBe(80);
		expect(ctx.chatContainer.children[0]).toBe(ctx.liveHistoryHiddenNotice);
	});

	test("defers initial history load until explicit shortcut request", async () => {
		const ctx = Object.create((InteractiveMode as any).prototype);
		ctx.chatContainer = new Container();
		ctx.ui = { requestRender: vi.fn() };
		ctx.footer = { invalidate: vi.fn() };
		ctx.updateEditorBorderColor = vi.fn();
		ctx.clearRenderedToolPanelState = vi.fn();
		ctx.toolPanels = { activeEntries: () => [] };
		const sessionManager = {
			getEntryCount: () => 42,
			getEntries: vi.fn(() => {
				throw new Error("history should not be loaded at startup");
			}),
			buildSessionContext: vi.fn(() => {
				throw new Error("history should not be built at startup");
			}),
		};
		Object.defineProperty(ctx, "sessionManager", { value: sessionManager });

		await (InteractiveMode as any).prototype.renderInitialMessages.call(ctx);

		expect(sessionManager.buildSessionContext).not.toHaveBeenCalled();
		expect(ctx.chatContainer.render(120).join("\n")).toContain("Press");
		expect(ctx.chatContainer.render(120).join("\n")).toContain("load session history");
		expect(ctx.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	test("throttles streaming text redraws while preserving the latest message", async () => {
		vi.useFakeTimers();
		try {
			const ctx = Object.create((InteractiveMode as any).prototype);
			ctx.streamingComponent = { updateContent: vi.fn() };
			ctx.streamingMessage = undefined;
			ctx.streamingUiUpdateTimer = undefined;
			ctx.lastStreamingUiUpdateAt = performance.now();
			ctx.ui = { requestRender: vi.fn() };
			ctx.toolPanels = { hasActive: () => false, activeEntries: () => [] };

			(InteractiveMode as any).prototype.applyStreamingMessageUpdate.call(ctx, makeAssistantMessage("first"));
			(InteractiveMode as any).prototype.applyStreamingMessageUpdate.call(ctx, makeAssistantMessage("second"));

			expect(ctx.streamingComponent.updateContent).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(80);

			expect(ctx.streamingComponent.updateContent).toHaveBeenCalledTimes(1);
			expect(getText(ctx.streamingComponent.updateContent.mock.calls[0][0])).toBe("second");
			expect(ctx.ui.requestRender).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("offscreen history rebuild swaps once without partial chunk renders", async () => {
		const ctx = Object.create((InteractiveMode as any).prototype);
		ctx.chatContainer = new Container();
		ctx.chatContainer.addChild(new Text("OLD", 0, 0));
		ctx.ui = { requestRender: vi.fn() };
		ctx.footer = { invalidate: vi.fn() };
		ctx.updateEditorBorderColor = vi.fn();
		ctx.toolPanels = { activeEntries: () => [], hasActive: () => false };
		Object.defineProperty(ctx, "session", { value: { retryAttempt: 0 } });
		ctx.defaultEditor = { addToHistory: vi.fn() };
		ctx.clearRenderedToolPanelState = vi.fn();
		ctx.getMarkdownThemeWithSettings = vi.fn(() => undefined);
		ctx.renderGeneration = 0;
		ctx.liveHistoryHiddenNotice = undefined;
		ctx.liveHistoryHiddenComponents = 0;
		ctx.lastStatusSpacer = undefined;
		ctx.lastStatusText = undefined;
		ctx.streamingComponent = undefined;
		ctx.hiddenThinkingLabel = "Thinking...";
		ctx.hideThinkingBlock = false;
		ctx.addMessageToChat = (message: AgentMessage) => {
			ctx.chatContainer.addChild(new Text(getText(message), 0, 0));
		};

		const messages = Array.from({ length: 45 }, (_, index) => makeUserMessage(`message-${index}`));
		await (InteractiveMode as any).prototype.renderSessionContext.call(ctx, { messages });

		expect(ctx.ui.requestRender).toHaveBeenCalledTimes(1);
		const rendered = ctx.chatContainer.render(120).join("\n");
		expect(rendered).not.toContain("OLD");
		expect(rendered).toContain("message-0");
		expect(rendered).toContain("message-44");
	});
});
