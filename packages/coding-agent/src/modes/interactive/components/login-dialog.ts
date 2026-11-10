import { getOAuthProviders, type OAuthDeviceCodeInfo } from "@caupulican/pi-ai/oauth";
import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { keyHint } from "../../../presentation/keybinding-hints.ts";
import { theme } from "../../../presentation/theme-model.ts";
import { readClipboardText } from "../../../utils/clipboard.ts";
import { openBrowser } from "../../../utils/open-browser.ts";
import { DynamicBorder } from "./dynamic-border.ts";

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private input: Input;
	private tui: TUI;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private onComplete: (success: boolean, message?: string) => void;
	private completed = false;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		providerId: string,
		onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
	) {
		super();
		this.tui = tui;
		this.onComplete = onComplete;

		const providerInfo = getOAuthProviders().find((p) => p.id === providerId);
		const providerName = providerNameOverride || providerInfo?.name || providerId;
		const title = titleOverride ?? interfaceText().dialogs.login.title(providerName);

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		// Dynamic content area
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Input (always present, used when needed)
		this.input = new Input();
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				this.inputResolver(this.input.getValue());
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
			}
		};
		this.input.onEscape = () => {
			this.cancel();
		};

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	private waitForInput(): Promise<string> {
		if (this.completed) return Promise.reject(new Error("Login cancelled"));
		if (this.inputRejecter) {
			const rejectPrevious = this.inputRejecter;
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
			rejectPrevious(new Error("Login input superseded"));
		}
		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	cancel(): void {
		if (this.completed) return;
		this.completed = true;
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	showAuth(url: string, instructions?: string): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		this.showAddress(url);

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}

		openBrowser(url);
		this.tui.requestRender();
	}

	/**
	 * Called by onDeviceCode callback - show URL and user code.
	 */
	showDeviceCode(info: OAuthDeviceCodeInfo): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		this.showAddress(info.verificationUri);
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(
			new Text(theme.fg("warning", interfaceText().dialogs.login.enterCode(info.userCode)), 1, 0),
		);

		openBrowser(info.verificationUri);
		this.tui.requestRender();
	}

	/** The address as a link, and under it how to open it: the same two lines for a login page and a device code. */
	private showAddress(url: string): void {
		const words = interfaceText().dialogs.login;
		const clickHint = process.platform === "darwin" ? words.openClickMac : words.openClickOther;
		const linkedUrl = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(
			new Text(`(${keyHint("tui.select.cancel", interfaceText().dialogs.login.toCancel)})`, 1, 0),
		);
		this.tui.requestRender();

		return this.waitForInput();
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string): Promise<string> {
		const words = interfaceText().dialogs.login;
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		if (placeholder) {
			this.contentContainer.addChild(new Text(theme.fg("dim", words.examplePlaceholder(placeholder)), 1, 0));
		}
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(
			new Text(
				`(${keyHint("tui.select.cancel", words.toCancel)}, ${keyHint("tui.select.confirm", words.toSubmit)})`,
				1,
				0,
			),
		);

		this.input.setValue("");
		this.tui.requestRender();

		return this.waitForInput();
	}

	/**
	 * Show informational text without prompting for input.
	 */
	showInfo(lines: string[]): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		for (const line of lines) {
			this.contentContainer.addChild(new Text(line, 1, 0));
		}
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(
			new Text(`(${keyHint("tui.select.cancel", interfaceText().dialogs.login.toClose)})`, 1, 0),
		);
		this.tui.requestRender();
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.contentContainer.addChild(
			new Text(`(${keyHint("tui.select.cancel", interfaceText().dialogs.login.toCancel)})`, 1, 0),
		);
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.tui.requestRender();
	}

	pasteText(text: string): void {
		this.input.pasteText(text);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		if (kb.matches(data, "app.clipboard.pasteImage")) {
			void this.pasteClipboard();
			return;
		}

		// Pass to input
		this.input.handleInput(data);
	}

	private async pasteClipboard(): Promise<void> {
		const text = await readClipboardText();
		if (!text) return;
		this.input.pasteText(text);
		this.tui.requestRender();
	}
}
