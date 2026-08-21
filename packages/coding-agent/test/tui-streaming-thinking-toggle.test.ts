import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { type Component, Container } from "@caupulican/pi-tui";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type StreamingMessageComponent = Component & {
	setHideThinkingBlock(hide: boolean): void;
	updateContent(message: AssistantMessage): void;
};

type ToggleThinkingHost = {
	hideThinkingBlock: boolean;
	settingsManager: { setHideThinkingBlock(hide: boolean): void };
	rebuildChatFromMessages(): Promise<void>;
	streamingComponent: StreamingMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	attachStreamingToolPanels(message: AssistantMessage): void;
	updateRuntimeStatus(message: AssistantMessage): void;
	chatContainer: Container;
	showStatus(message: string): void;
	toggleThinkingBlockVisibility(): Promise<void>;
};

function createStreamingComponent(): StreamingMessageComponent {
	return {
		render: () => [],
		invalidate: () => {},
		setHideThinkingBlock: vi.fn(),
		updateContent: vi.fn(),
	};
}

describe("InteractiveMode streaming thinking toggle", () => {
	let fakeThis: ToggleThinkingHost;
	let message: AssistantMessage;
	let toolPanel: Component;

	beforeEach(() => {
		message = fauxAssistantMessage([
			{ type: "thinking", thinking: "reasoning" },
			fauxToolCall("bash", { command: "printf in-flight" }),
		]);
		toolPanel = { render: () => [], invalidate: () => {} };
		const chatContainer = new Container();
		fakeThis = {
			hideThinkingBlock: true,
			settingsManager: { setHideThinkingBlock: vi.fn() },
			rebuildChatFromMessages: vi.fn(async () => {}),
			streamingComponent: createStreamingComponent(),
			streamingMessage: message,
			attachStreamingToolPanels: vi.fn(() => chatContainer.addChild(toolPanel)),
			updateRuntimeStatus: vi.fn(),
			chatContainer,
			showStatus: vi.fn(),
			toggleThinkingBlockVisibility: (InteractiveMode.prototype as unknown as ToggleThinkingHost)
				.toggleThinkingBlockVisibility,
		};
	});

	test("reattaches in-flight tool panels after rebuilding the chat", async () => {
		await fakeThis.toggleThinkingBlockVisibility.call(fakeThis);

		expect(fakeThis.attachStreamingToolPanels).toHaveBeenCalledWith(message);
		expect(fakeThis.chatContainer.children).toEqual([fakeThis.streamingComponent, toolPanel]);
	});
});
