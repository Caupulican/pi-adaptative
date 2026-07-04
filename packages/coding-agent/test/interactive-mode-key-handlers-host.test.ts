import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import * as keyHandlers from "../src/modes/interactive/key-handlers.ts";

type FakeEditor = {
	getText: () => string;
	setText: (text: string) => void;
};

type FakeSession = {
	isStreaming: boolean;
	isBashRunning: boolean;
	abortBash: () => void;
};

type FakeSettingsManager = {
	getDoubleEscapeAction: () => "tree" | "fork" | "none";
};

type FakeDefaultEditor = {
	onEscape?: () => void;
	onAction: (action: string, handler: () => void) => void;
	onCtrlD?: () => void;
	onChange?: (text: string) => void;
	onPasteImage?: () => void;
	onRecallQueued?: () => boolean;
};

type KeyHandlersHostThis = {
	defaultEditor: FakeDefaultEditor;
	editor: FakeEditor;
	ui: { onDebug?: () => void };
	session: FakeSession;
	settingsManager: FakeSettingsManager;
	isBashMode: boolean;
	lastEscapeTime: number;
	restoreQueuedMessagesToEditor: (options?: { abort?: boolean; currentText?: string }) => number;
	updateEditorBorderColor: () => void;
	showTreeSelector: (initialSelectedId?: string) => void;
	showUserMessageSelector: (newSessionName?: string) => void;
	handleCtrlC: () => void;
	handleCtrlD: () => void;
	handleCtrlZ: () => void;
	cycleThinkingLevel: () => void;
	cycleModel: (direction: "forward" | "backward") => Promise<void>;
	handleDebugCommand: () => void;
	showModelSelector: (initialSearchInput?: string) => Promise<void>;
	loadTuiHistoryOnDemand: () => void;
	toggleThinkingBlockVisibility: () => Promise<void>;
	openExternalEditor: () => Promise<void>;
	handleFollowUp: () => Promise<void>;
	handleDequeue: () => void;
	handleClearCommand: (newSessionName?: string) => Promise<void>;
	showSessionSelector: () => void;
	handleClipboardImagePaste: () => Promise<void>;
};

function makeFakeThis(overrides: Partial<KeyHandlersHostThis> = {}): KeyHandlersHostThis {
	return {
		defaultEditor: { onAction: vi.fn() },
		editor: { getText: () => "", setText: vi.fn() },
		ui: {},
		session: { isStreaming: false, isBashRunning: false, abortBash: vi.fn() },
		settingsManager: { getDoubleEscapeAction: () => "tree" },
		isBashMode: false,
		lastEscapeTime: 0,
		restoreQueuedMessagesToEditor: vi.fn(() => 0),
		updateEditorBorderColor: vi.fn(),
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		handleCtrlC: vi.fn(),
		handleCtrlD: vi.fn(),
		handleCtrlZ: vi.fn(),
		cycleThinkingLevel: vi.fn(),
		cycleModel: vi.fn(async () => undefined),
		handleDebugCommand: vi.fn(),
		showModelSelector: vi.fn(async () => undefined),
		loadTuiHistoryOnDemand: vi.fn(),
		toggleThinkingBlockVisibility: vi.fn(async () => undefined),
		openExternalEditor: vi.fn(async () => undefined),
		handleFollowUp: vi.fn(async () => undefined),
		handleDequeue: vi.fn(),
		handleClearCommand: vi.fn(async () => undefined),
		showSessionSelector: vi.fn(),
		handleClipboardImagePaste: vi.fn(async () => undefined),
		...overrides,
	};
}

const keyHandlersHost = Reflect.get(InteractiveMode.prototype, "keyHandlersHost") as (
	this: KeyHandlersHostThis,
) => keyHandlers.KeyHandlersHost;

describe("InteractiveMode.keyHandlersHost live bindings", () => {
	test("Escape aborts bash on the session swapped in after a reload, not the one at setup time", () => {
		const staleSession: FakeSession = { isStreaming: false, isBashRunning: false, abortBash: vi.fn() };
		const fakeThis = makeFakeThis({ session: staleSession });

		const host = keyHandlersHost.call(fakeThis);
		keyHandlers.setupKeyHandlers(host);

		// Simulate /reload swapping in a new session via the runtimeHost.
		const reloadedSession: FakeSession = { isStreaming: false, isBashRunning: true, abortBash: vi.fn() };
		fakeThis.session = reloadedSession;

		fakeThis.defaultEditor.onEscape?.();

		expect(reloadedSession.abortBash).toHaveBeenCalledTimes(1);
		expect(staleSession.abortBash).not.toHaveBeenCalled();
	});

	test("double-escape /tree trigger reads the editor swapped in via setEditor, not the one at setup time", () => {
		const staleEditor: FakeEditor = { getText: () => "leftover text", setText: vi.fn() };
		const fakeThis = makeFakeThis({ editor: staleEditor, lastEscapeTime: Date.now() - 100 });

		const host = keyHandlersHost.call(fakeThis);
		keyHandlers.setupKeyHandlers(host);

		// Simulate an extension custom editor calling setEditor, swapping the active editor.
		const newEditor: FakeEditor = { getText: () => "", setText: vi.fn() };
		fakeThis.editor = newEditor;

		fakeThis.defaultEditor.onEscape?.();

		expect(fakeThis.showTreeSelector).toHaveBeenCalledTimes(1);
	});
});
