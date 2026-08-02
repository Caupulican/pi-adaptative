import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type PresentationEditor = {
	setPaddingX: ReturnType<typeof vi.fn>;
	setAutocompleteMaxVisible: ReturnType<typeof vi.fn>;
};

type PresentationContext = {
	settingsManager: {
		getEditorPaddingX(): number;
		getAutocompleteMaxVisible(): number;
	};
	defaultEditor: PresentationEditor;
	editor: PresentationEditor;
};

type RefreshContext = {
	keybindings: { reload(): void };
	setupAutocompleteProvider(): void;
	refreshExtensionPresentation(): void;
	session: { extensionRunner: object };
	extensionUiHost: { setupExtensionShortcuts(runner: object): void };
	rebuildChatFromMessages(): Promise<void>;
	footer: { invalidate(): void };
	ui: { requestRender(): void };
	showError(message: string): void;
};

type InteractivePresentationPrivate = {
	applyEditorPresentationSettings(this: PresentationContext): void;
	refreshUIAfterExtensionsChanged(this: RefreshContext): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractivePresentationPrivate;

describe("InteractiveMode presentation ownership", () => {
	it("applies editor presentation to the default and distinct active editor", () => {
		const context: PresentationContext = {
			settingsManager: {
				getEditorPaddingX: () => 3,
				getAutocompleteMaxVisible: () => 7,
			},
			defaultEditor: { setPaddingX: vi.fn(), setAutocompleteMaxVisible: vi.fn() },
			editor: { setPaddingX: vi.fn(), setAutocompleteMaxVisible: vi.fn() },
		};

		prototype.applyEditorPresentationSettings.call(context);

		expect(context.defaultEditor.setPaddingX).toHaveBeenCalledWith(3);
		expect(context.defaultEditor.setAutocompleteMaxVisible).toHaveBeenCalledWith(7);
		expect(context.editor.setPaddingX).toHaveBeenCalledWith(3);
		expect(context.editor.setAutocompleteMaxVisible).toHaveBeenCalledWith(7);
	});

	it("does not apply settings twice when the default editor is active", () => {
		const editor = { setPaddingX: vi.fn(), setAutocompleteMaxVisible: vi.fn() };
		const context: PresentationContext = {
			settingsManager: {
				getEditorPaddingX: () => 2,
				getAutocompleteMaxVisible: () => 5,
			},
			defaultEditor: editor,
			editor,
		};

		prototype.applyEditorPresentationSettings.call(context);

		expect(editor.setPaddingX).toHaveBeenCalledOnce();
		expect(editor.setAutocompleteMaxVisible).toHaveBeenCalledOnce();
	});

	it("routes live extension changes through the shared presentation refresh", async () => {
		const calls: string[] = [];
		const runner = {};
		const context: RefreshContext = {
			keybindings: { reload: () => calls.push("keybindings") },
			setupAutocompleteProvider: () => calls.push("autocomplete"),
			refreshExtensionPresentation: () => calls.push("presentation"),
			session: { extensionRunner: runner },
			extensionUiHost: {
				setupExtensionShortcuts: (received) => calls.push(received === runner ? "shortcuts" : "wrong-runner"),
			},
			rebuildChatFromMessages: async () => {
				calls.push("chat");
			},
			footer: { invalidate: () => calls.push("footer") },
			ui: { requestRender: () => calls.push("render") },
			showError: (message) => calls.push(`error:${message}`),
		};

		await prototype.refreshUIAfterExtensionsChanged.call(context);

		expect(calls).toEqual(["keybindings", "autocomplete", "presentation", "shortcuts", "chat", "footer", "render"]);
	});
});
