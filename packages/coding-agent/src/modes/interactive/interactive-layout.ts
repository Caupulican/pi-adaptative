/** Mounts the human Workbench or the deliberately unattended transcript; owns no session lifecycle. */
import path from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";
import type { Container, EditorComponent, TUI } from "@caupulican/pi-tui";
import { APP_NAME } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { expandMessageTextForDisplay } from "../../core/context/path-alias-display.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { copyToClipboard, readClipboardText } from "../../utils/clipboard.ts";
import type { ActivityLaneComponent } from "./components/activity-lane.ts";
import type { FooterComponent } from "./components/footer.ts";
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
	footer: FooterComponent;
	activityLane?: ActivityLaneComponent;
	keybindings: KeybindingsManager;
	settingsManager: Pick<SettingsManager, "getWorkbenchSettings" | "setWorkbenchSetting" | "setWorkbenchSettings">;
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
	// One status row when the width allows; the status band should use the width, not stack.
	host.footer.setCompact(true);
	const view = new WorkbenchComponent({
		conversation: host.chatContainer,
		editor: host.editorContainer,
		header: host.headerContainer,
		activity: host.activityLane,
		brand: APP_NAME,
		title: () => host.session.sessionManager.getSessionName() || path.basename(host.session.sessionManager.getCwd()),
		dock: [host.pendingMessagesContainer, host.statusContainer, host.widgetContainerAbove, host.footer],
		dockBelow: [host.widgetContainerBelow],
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
		previewLimit: () => host.session.settingsManager.getWorkbenchSettings().previews,
		// The terminal owns the mouse unless the operator hands it over; the choice persists.
		mouse: {
			enabled: () => host.settingsManager.getWorkbenchSettings().mouse === "on",
			set: (enabled) => {
				host.settingsManager.setWorkbenchSetting("mouse", enabled ? "on" : "off");
				host.ui.terminal.setMouseTracking?.(enabled);
			},
		},
		// Only the operator changes the work area; what they chose last time is where it starts.
		geometry: { save: (geometry) => host.settingsManager.setWorkbenchSettings(geometry) },
		paste: async () => {
			const text = await readClipboardText();
			if (!text) {
				host.activityLane?.announce("Clipboard has no text to paste", "neutral");
				return;
			}
			if (!host.editor.insertTextAtCursor) {
				host.activityLane?.announce("This editor cannot take a pasted selection", "failure");
				return;
			}
			host.editor.insertTextAtCursor(text);
			host.ui.requestRender();
		},
	});
	const stored = host.settingsManager.getWorkbenchSettings();
	view.setMouseMode(stored.mouse === "on");
	view.applyGeometry(stored);
	host.workbenchInputCleanup = host.ui.addInputListener((data) => host.workbench?.handleInput(data));
	host.ui.addChild(view);
}
