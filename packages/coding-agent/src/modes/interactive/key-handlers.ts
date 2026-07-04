/**
 * Editor/global key-handler wiring extracted from interactive-mode.
 *
 * `setupKeyHandlers` installs the escape/action/ctrl-D/change/paste/recall
 * callbacks on the default editor (and the global debug handler on the TUI),
 * each delegating to a host method or toggling the bash-mode/last-escape state.
 * It runs once at init through a wide `KeyHandlersHost` seam; interactive-mode
 * keeps a thin wrapper.
 */

import type { EditorComponent, TUI } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { CustomEditor } from "./components/custom-editor.ts";

export interface KeyHandlersHost {
	readonly defaultEditor: CustomEditor;
	readonly editor: EditorComponent;
	readonly ui: TUI;
	readonly session: Pick<AgentSession, "isStreaming" | "isBashRunning" | "abortBash">;
	readonly settingsManager: Pick<SettingsManager, "getDoubleEscapeAction">;
	isBashMode: boolean;
	lastEscapeTime: number;
	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number;
	updateEditorBorderColor(): void;
	showTreeSelector(initialSelectedId?: string): void;
	showUserMessageSelector(newSessionName?: string): void;
	handleCtrlC(): void;
	handleCtrlD(): void;
	handleCtrlZ(): void;
	cycleThinkingLevel(): void;
	cycleModel(direction: "forward" | "backward"): Promise<void>;
	handleDebugCommand(): void;
	showModelSelector(initialSearchInput?: string): Promise<void>;
	loadTuiHistoryOnDemand(): void;
	toggleThinkingBlockVisibility(): Promise<void>;
	openExternalEditor(): Promise<void>;
	handleFollowUp(): Promise<void>;
	handleDequeue(): void;
	handleClearCommand(newSessionName?: string): Promise<void>;
	showSessionSelector(): void;
	handleClipboardImagePaste(): Promise<void>;
}

export function setupKeyHandlers(host: KeyHandlersHost): void {
	// Set up handlers on defaultEditor - they use host.editor for text access
	// so they work correctly regardless of which editor is active
	host.defaultEditor.onEscape = () => {
		if (host.session.isStreaming) {
			host.restoreQueuedMessagesToEditor({ abort: true });
		} else if (host.session.isBashRunning) {
			host.session.abortBash();
		} else if (host.isBashMode) {
			host.editor.setText("");
			host.isBashMode = false;
			host.updateEditorBorderColor();
		} else if (!host.editor.getText().trim()) {
			// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
			const action = host.settingsManager.getDoubleEscapeAction();
			if (action !== "none") {
				const now = Date.now();
				if (now - host.lastEscapeTime < 500) {
					if (action === "tree") {
						host.showTreeSelector();
					} else {
						host.showUserMessageSelector();
					}
					host.lastEscapeTime = 0;
				} else {
					host.lastEscapeTime = now;
				}
			}
		}
	};

	// Register app action handlers
	host.defaultEditor.onAction("app.clear", () => host.handleCtrlC());
	host.defaultEditor.onCtrlD = () => host.handleCtrlD();
	host.defaultEditor.onAction("app.suspend", () => host.handleCtrlZ());
	host.defaultEditor.onAction("app.thinking.cycle", () => host.cycleThinkingLevel());
	host.defaultEditor.onAction("app.model.cycleForward", () => host.cycleModel("forward"));
	host.defaultEditor.onAction("app.model.cycleBackward", () => host.cycleModel("backward"));

	// Global debug handler on TUI (works regardless of focus)
	host.ui.onDebug = () => host.handleDebugCommand();
	host.defaultEditor.onAction("app.model.select", () => void host.showModelSelector());
	host.defaultEditor.onAction("app.tools.expand", () => host.loadTuiHistoryOnDemand());
	host.defaultEditor.onAction("app.thinking.toggle", () => void host.toggleThinkingBlockVisibility());
	host.defaultEditor.onAction("app.editor.external", () => host.openExternalEditor());
	host.defaultEditor.onAction("app.message.followUp", () => host.handleFollowUp());
	host.defaultEditor.onAction("app.message.dequeue", () => host.handleDequeue());
	// Plain Up arrow on an empty editor recalls queued messages for editing
	// before history navigation. Many terminals (e.g. Windows Terminal) swallow
	// the alt-chord bindings, so the queue must be reachable without them.
	host.defaultEditor.onRecallQueued = () => host.restoreQueuedMessagesToEditor() > 0;
	host.defaultEditor.onAction("app.session.new", () => host.handleClearCommand());
	host.defaultEditor.onAction("app.session.tree", () => host.showTreeSelector());
	host.defaultEditor.onAction("app.session.fork", () => host.showUserMessageSelector());
	host.defaultEditor.onAction("app.session.resume", () => host.showSessionSelector());

	host.defaultEditor.onChange = (text: string) => {
		const wasBashMode = host.isBashMode;
		host.isBashMode = text.trimStart().startsWith("!");
		if (wasBashMode !== host.isBashMode) {
			host.updateEditorBorderColor();
		}
	};

	// Handle clipboard image paste (triggered on Ctrl+V)
	host.defaultEditor.onPasteImage = () => {
		host.handleClipboardImagePaste();
	};
}
