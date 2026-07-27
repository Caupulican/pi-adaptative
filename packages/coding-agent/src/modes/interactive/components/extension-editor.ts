/**
 * Multi-line editor component for extensions.
 * Supports Ctrl+G for external editor.
 */

import {
	Container,
	Editor,
	type EditorOptions,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@caupulican/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { editInExternalEditor } from "../external-editor.ts";
import { getEditorTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface ExtensionEditorOptions extends EditorOptions {
	/** Visible owner-only content that must not enter editor history, autocomplete, or external files. */
	privateContent?: boolean;
	/** Muted reassurance/instruction shown immediately above the editor. */
	notice?: string;
	/** External editors create plaintext temporary files, so private editors always disable this. */
	allowExternalEditor?: boolean;
	/** Programmatic cancellation for tool-owned dialogs. */
	signal?: AbortSignal;
}

export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private keybindings: KeybindingsManager;
	private readonly allowExternalEditor: boolean;
	private readonly signal: AbortSignal | undefined;
	private readonly onAbort: (() => void) | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: ExtensionEditorOptions,
	) {
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		this.allowExternalEditor = options?.privateContent ? false : (options?.allowExternalEditor ?? true);
		this.signal = options?.signal;
		this.onAbort = this.signal ? () => this.onCancelCallback() : undefined;
		if (this.onAbort) this.signal?.addEventListener("abort", this.onAbort, { once: true });

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add title
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));
		const notice =
			options?.notice ??
			(options?.privateContent
				? "Private editor · visible only in this terminal · not sent to the model"
				: undefined);
		if (notice) {
			this.addChild(new Text(theme.fg("muted", notice), 1, 0));
			this.addChild(new Spacer(1));
		}

		// Create editor
		this.editor = new Editor(tui, getEditorTheme(), options);
		if (prefill) {
			this.editor.setText(prefill);
		}
		// Wire up Enter to submit (Shift+Enter for newlines, like the main editor)
		this.editor.onSubmit = (text: string) => {
			this.onSubmitCallback(text);
		};
		this.addChild(this.editor);

		this.addChild(new Spacer(1));

		// Add hint
		const hasExternalEditor = this.allowExternalEditor && !!(process.env.VISUAL || process.env.EDITOR);
		const hint =
			keyHint("tui.select.confirm", "submit") +
			"  " +
			keyHint("tui.input.newLine", "newline") +
			"  " +
			keyHint("tui.select.cancel", "cancel") +
			(hasExternalEditor ? `  ${keyHint("app.editor.external", "external editor")}` : "");
		this.addChild(new Text(hint, 1, 0));

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Escape or Ctrl+C to cancel
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		// External editor (app keybinding)
		if (this.keybindings.matches(keyData, "app.editor.external")) {
			if (this.allowExternalEditor) this.openExternalEditor();
			return;
		}

		// Forward to editor
		this.editor.handleInput(keyData);
	}

	private async openExternalEditor(): Promise<void> {
		if (!this.allowExternalEditor) return;
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			return;
		}

		const currentText = this.editor.getText();

		try {
			this.tui.stop();
			const result = await editInExternalEditor({ command: editorCmd, content: currentText });
			if (result.status === "complete") {
				this.editor.setText(result.content);
			}
		} finally {
			this.tui.start();
			// Force full re-render since external editor uses alternate screen
			this.tui.requestRender(true);
		}
	}

	dispose(): void {
		if (this.onAbort) this.signal?.removeEventListener("abort", this.onAbort);
		this.editor.clear();
	}
}
