import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionContext } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage, ToolResultMessage, Usage } from "@caupulican/pi-ai";
import { Container, Text, type TUI } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { ToolPanelRegistry } from "../../../src/modes/interactive/components/tool-panel-registry.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionContextThis = {
	toolPanels: ToolPanelRegistry;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	sessionManager: { getCwd(): string };
	session: { retryAttempt: number };
	toolOutputExpanded: boolean;
	isInitialized: boolean;
	updateEditorBorderColor(): void;
	getRegisteredToolDefinition(toolName: string): undefined;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	appendToolExecutionComponent(component: ToolExecutionComponent, allowGrouping: boolean): void;
	attachToolExecutionComponent(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent;
	getToolPanelScope(): { sessionId?: string; sessionFile?: string; cwd: string };
	clearRenderedToolPanelState(): void;
};

type RenderSessionContext = (
	this: RenderSessionContextThis,
	sessionContext: SessionContext,
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => Promise<void>;

type HandleEvent = (this: RenderSessionContextThis, event: AgentSessionEvent) => Promise<void>;

function createFakeInteractiveModeThis(): RenderSessionContextThis {
	const chatContainer = new Container();
	const toolPanels = new ToolPanelRegistry();
	const proto = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	return {
		toolPanels,
		chatContainer,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		sessionManager: { getCwd: () => process.cwd() },
		session: { retryAttempt: 0 },
		toolOutputExpanded: false,
		isInitialized: true,
		renderGeneration: 0,
		liveHistoryHiddenNotice: undefined,
		liveHistoryHiddenComponents: 0,
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
		updateEditorBorderColor: vi.fn(),
		getRegisteredToolDefinition: (_toolName: string) => undefined,
		addMessageToChat(this: RenderSessionContextThis, message: AgentMessage) {
			this.chatContainer.addChild(new Text(message.role, 0, 0));
		},
		appendToolExecutionComponent(this: RenderSessionContextThis, component: ToolExecutionComponent) {
			this.chatContainer.addChild(component);
		},
		attachToolExecutionComponent: (
			InteractiveMode.prototype as unknown as {
				attachToolExecutionComponent(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent;
			}
		).attachToolExecutionComponent,
		getToolPanelScope: () => ({ cwd: process.cwd() }),
		resetLiveTuiHistoryTrim: proto.resetLiveTuiHistoryTrim,
		trimLiveTuiHistory: proto.trimLiveTuiHistory,
		messagesForTuiHistoryReload: proto.messagesForTuiHistoryReload,
		estimateTuiHistoryLines: proto.estimateTuiHistoryLines,
		trimMessageToTuiHistoryTail: proto.trimMessageToTuiHistoryTail,
		cloneMessageWithText: proto.cloneMessageWithText,
		getTuiHistoryMessageText: proto.getTuiHistoryMessageText,
		getMessageTuiText: proto.getMessageTuiText,
		getContentText: proto.getContentText,
		getUserMessageText: proto.getUserMessageText,
		clearRenderedToolPanelState() {
			toolPanels.clearAll();
		},
	} as unknown as RenderSessionContextThis;
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionContext(messages: AgentMessage[]): SessionContext {
	return {
		messages,
		thinkingLevel: "off",
		model: null,
	};
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode.renderSessionContext", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps unresolved rendered tool calls registered for live completion events", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionContext = (
			InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await renderSessionContext.call(fakeThis, createSessionContext([createAssistantToolCallMessage()]));

		expect(fakeThis.toolPanels.hasActive(TOOL_CALL_ID)).toBe(true);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: undefined },
			isError: false,
		});

		expect(fakeThis.toolPanels.hasActive(TOOL_CALL_ID)).toBe(false);
		expect(renderChat(fakeThis.chatContainer)).toContain("FINAL_RESULT");
	});

	test("does not keep completed historical tool calls registered as pending", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionContext = (
			InteractiveMode.prototype as unknown as { renderSessionContext: RenderSessionContext }
		).renderSessionContext;

		await renderSessionContext.call(
			fakeThis,
			createSessionContext([createAssistantToolCallMessage(), createToolResultMessage("HISTORICAL_RESULT")]),
		);

		expect(fakeThis.toolPanels.hasActive(TOOL_CALL_ID)).toBe(false);
		expect(renderChat(fakeThis.chatContainer)).toContain("HISTORICAL_RESULT");
	});
});
