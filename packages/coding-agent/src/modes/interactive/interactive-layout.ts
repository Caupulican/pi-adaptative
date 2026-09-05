/** Mounts the human Workbench or the deliberately unattended transcript; owns no session lifecycle. */
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";
import type { Component, Container, EditorComponent, TUI } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { expandMessageTextForDisplay } from "../../core/context/path-alias-display.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { copyToClipboard } from "../../utils/clipboard.ts";
import type { ActivityLaneComponent } from "./components/activity-lane.ts";
import { isConversationMessage } from "./components/question-conversation.ts";
import { WorkbenchComponent } from "./components/workbench.ts";
import type { ExtensionUiHost } from "./extension-ui-host.ts";
import { WorkbenchController } from "./workbench-controller.ts";

export interface InteractiveLayoutHost {
	hasHumanAudience: boolean;
	ui: TUI;
	session: AgentSession;
	headerContainer: Container;
	chatContainer: Container;
	editorContainer: Container;
	editor: EditorComponent;
	pendingMessagesContainer: Container;
	statusContainer: Container;
	widgetContainerAbove: Container;
	widgetContainerBelow: Container;
	footer: Component;
	activityLane?: ActivityLaneComponent;
	keybindings: KeybindingsManager;
	extensionUiHost: Pick<ExtensionUiHost, "renderWidgets">;
	streamingMessage?: AssistantMessage;
	workbench?: WorkbenchController;
	workbenchInputCleanup?: () => void;
}

export function mountInteractiveLayout(host: InteractiveLayoutHost): void {
	if (!host.hasHumanAudience) {
		for (const child of [host.headerContainer, host.chatContainer, host.editorContainer]) host.ui.addChild(child);
		return;
	}
	host.extensionUiHost.renderWidgets();
	const view = new WorkbenchComponent({
		conversation: host.chatContainer,
		editor: host.editorContainer,
		header: host.headerContainer,
		dock: [
			host.pendingMessagesContainer,
			host.statusContainer,
			host.widgetContainerAbove,
			...(host.activityLane ? [host.activityLane] : []),
			host.widgetContainerBelow,
			host.footer,
		],
		viewportRows: () => host.ui.terminal.rows,
	});
	host.workbench = new WorkbenchController(view, {
		keybindings: host.keybindings,
		isInteractive: () => !host.ui.hasOverlay() && host.editorContainer.children[0] === host.editor,
		requestRender: () => host.ui.requestRender(),
		messages: function* (): IterableIterator<AgentMessage> {
			let sawStreaming = false;
			const aliases = host.session.peekPathAliasTable();
			for (const entry of host.session.sessionManager.getBranch()) {
				if (entry.type !== "message" || !isConversationMessage(entry.message)) continue;
				const message = entry.message;
				if (
					message === host.streamingMessage ||
					(message.role === "assistant" && message.timestamp === host.streamingMessage?.timestamp)
				)
					sawStreaming = true;
				yield expandMessageTextForDisplay(aliases, message);
			}
			if (host.streamingMessage && !sawStreaming) yield expandMessageTextForDisplay(aliases, host.streamingMessage);
		},
		copy: copyToClipboard,
		notice: (text, error) => host.activityLane?.announce(text, error ? "failure" : "neutral"),
	});
	host.workbenchInputCleanup = host.ui.addInputListener((data) => host.workbench?.handleInput(data));
	host.ui.addChild(view);
}
