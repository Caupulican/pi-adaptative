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
	attachStreamingToolActions(message: AssistantMessage, argumentsComplete: boolean): void;
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
	let toolAction: Component;

	beforeEach(() => {
		message = fauxAssistantMessage([
			{ type: "thinking", thinking: "reasoning" },
			fauxToolCall("bash", { command: "printf in-flight" }),
		]);
		toolAction = { render: () => [], invalidate: () => {} };
		const chatContainer = new Container();
		fakeThis = {
			hideThinkingBlock: true,
			settingsManager: { setHideThinkingBlock: vi.fn() },
			rebuildChatFromMessages: vi.fn(async () => {}),
			streamingComponent: createStreamingComponent(),
			streamingMessage: message,
			attachStreamingToolActions: vi.fn(() => chatContainer.addChild(toolAction)),
			updateRuntimeStatus: vi.fn(),
			chatContainer,
			showStatus: vi.fn(),
			toggleThinkingBlockVisibility: (InteractiveMode.prototype as unknown as ToggleThinkingHost)
				.toggleThinkingBlockVisibility,
		};
	});

	test("reattaches in-flight tool panels after rebuilding the chat", async () => {
		await fakeThis.toggleThinkingBlockVisibility.call(fakeThis);

		// Rebuilding after the arguments already arrived expands aliases; mid-stream chunks do not
		// (see test/streaming-tool-args-expansion.test.ts).
		expect(fakeThis.attachStreamingToolActions).toHaveBeenCalledWith(message, true);
		expect(fakeThis.chatContainer.children).toEqual([fakeThis.streamingComponent, toolAction]);
	});
});
