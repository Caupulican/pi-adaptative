import { Container, type Terminal, Text, TUI } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.ts";
import type { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { EditorOverlayHost } from "../src/modes/interactive/editor-overlay-host.ts";
import { ExtensionUiHost } from "../src/modes/interactive/extension-ui-host.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	private inputHandler: ((data: string) => void) | undefined;
	start(onInput: (data: string) => void): void {
		this.inputHandler = onInput;
	}
	stop(): void {
		this.inputHandler = undefined;
	}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	sendInput(data: string): void {
		this.inputHandler?.(data);
	}
}

function createHost() {
	const terminal = new FakeTerminal();
	const tui = new TUI(terminal);
	let renderRequests = 0;
	tui.requestRender = () => {
		renderRequests += 1;
	};
	const editorContainer = new Container();
	let editorText = "";
	const editor = new Text(editorText, 0, 0);
	const editorInput: string[] = [];
	const setEditorText = editor.setText.bind(editor);
	Object.assign(editor, {
		getText: () => editorText,
		setText: (value: string) => {
			editorText = value;
			setEditorText(value);
		},
		handleInput: (data: string) => editorInput.push(data),
	});
	editorContainer.addChild(editor);
	const showError = vi.fn();
	return {
		terminal,
		editorContainer,
		editorInput,
		getRenderRequests: () => renderRequests,
		extensionSelector: undefined as ExtensionSelectorComponent | undefined,
		activeExtensionDialogCancel: undefined as (() => void) | undefined,
		extensionInput: undefined as ExtensionInputComponent | undefined,
		extensionEditor: undefined,
		extensionWidgets: new Map(),
		extensionErrorOverlay: undefined,
		extensionTerminalInputUnsubscribers: new Set<() => void>(),
		ui: {
			tui,
			overlayHost: new EditorOverlayHost(editorContainer, tui),
			getEditor: () => editor,
			keybindings: {},
			toggleToolsExpanded: () => {},
			footerDataProvider: { clearExtensionStatuses: () => {} },
			footer: { invalidate: () => {} },
			resetAutocompleteProviderWrappers: () => {},
			setupAutocompleteProvider: () => {},
			defaultEditor: { onExtensionShortcut: undefined },
			updateTerminalTitle: () => {},
			resetWorkingIndicators: () => {},
			showError,
		},
		showExtensionDialog: Reflect.get(ExtensionUiHost.prototype, "showExtensionDialog"),
		showExtensionSelector: Reflect.get(ExtensionUiHost.prototype, "showExtensionSelector"),
		hideExtensionSelector: Reflect.get(ExtensionUiHost.prototype, "hideExtensionSelector"),
		showExtensionInput: Reflect.get(ExtensionUiHost.prototype, "showExtensionInput"),
		hideExtensionInput: Reflect.get(ExtensionUiHost.prototype, "hideExtensionInput"),
		addExtensionTerminalInputListener: Reflect.get(ExtensionUiHost.prototype, "addExtensionTerminalInputListener"),
		clearExtensionTerminalInputListeners: () => {},
		setExtensionFooter: () => {},
		setExtensionHeader: () => {},
		clearExtensionWidgets: () => {},
		setCustomEditorComponent: () => {},
	};
}

type TestHost = ReturnType<typeof createHost>;
const showSelector = Reflect.get(ExtensionUiHost.prototype, "showExtensionSelector") as (
	this: TestHost,
	title: string,
	options: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
) => Promise<string | undefined>;
const showInput = Reflect.get(ExtensionUiHost.prototype, "showExtensionInput") as (
	this: TestHost,
	title: string,
	placeholder?: string,
	opts?: { signal?: AbortSignal; timeout?: number; sensitive?: boolean },
) => Promise<string | undefined>;
const resetExtensionUI = Reflect.get(ExtensionUiHost.prototype, "resetExtensionUI") as (this: TestHost) => void;
const createExtensionUIContext = Reflect.get(ExtensionUiHost.prototype, "createExtensionUIContext") as (
	this: TestHost,
) => ReturnType<ExtensionUiHost["createExtensionUIContext"]>;
const showCustom = Reflect.get(ExtensionUiHost.prototype, "showExtensionCustom") as <T>(
	this: TestHost,
	factory: (...args: unknown[]) => Text | Promise<Text>,
) => Promise<T>;

describe("extension UI dialog liveness", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("settles a selector before a newer dialog replaces its overlay", async () => {
		const host = createHost();
		const firstPromise = showSelector.call(host, "First", ["first"]);
		const firstSelector = host.extensionSelector;
		if (!firstSelector) throw new Error("first selector was not mounted");

		const secondPromise = showSelector.call(host, "Second", ["second"]);
		await expect(firstPromise).resolves.toBeUndefined();
		const secondSelector = host.extensionSelector;
		if (!secondSelector) throw new Error("second selector was not mounted");
		expect(secondSelector).not.toBe(firstSelector);

		// A stale callback from the disposed dialog must not close the current one.
		firstSelector.handleInput("\n");
		expect(host.extensionSelector).toBe(secondSelector);
		secondSelector.handleInput("\n");
		await expect(secondPromise).resolves.toBe("second");
	});

	it("removes an old abort listener before a newer dialog mounts", async () => {
		const host = createHost();
		const controller = new AbortController();
		const firstPromise = showSelector.call(host, "First", ["first"], { signal: controller.signal });
		const firstSelector = host.extensionSelector;
		if (!firstSelector) throw new Error("first selector was not mounted");
		firstSelector.handleInput("\n");
		await expect(firstPromise).resolves.toBe("first");

		const secondPromise = showSelector.call(host, "Second", ["second"]);
		const secondSelector = host.extensionSelector;
		if (!secondSelector) throw new Error("second selector was not mounted");
		controller.abort();
		expect(host.extensionSelector).toBe(secondSelector);
		secondSelector.handleInput("\n");
		await expect(secondPromise).resolves.toBe("second");
	});

	it("does not displace an active selector for an already-aborted input request", async () => {
		const host = createHost();
		const selectorPromise = showSelector.call(host, "Active", ["active"]);
		const selector = host.extensionSelector;
		if (!selector) throw new Error("selector was not mounted");
		const controller = new AbortController();
		controller.abort();

		await expect(showInput.call(host, "Ignored", undefined, { signal: controller.signal })).resolves.toBeUndefined();

		expect(host.extensionSelector).toBe(selector);
		expect(host.extensionInput).toBeUndefined();
		expect(host.editorContainer.children).toEqual([selector]);
		selector.handleInput("\n");
		await expect(selectorPromise).resolves.toBe("active");
	});

	it("settles a replaced input and ignores its stale abort callback", async () => {
		const host = createHost();
		const controller = new AbortController();
		const inputPromise = showInput.call(host, "Input", "placeholder", { signal: controller.signal });
		const input = host.extensionInput;
		if (!input) throw new Error("input was not mounted");
		input.handleInput("draft");

		const selectorPromise = showSelector.call(host, "Replacement", ["replacement"]);
		await expect(inputPromise).resolves.toBeUndefined();
		const selector = host.extensionSelector;
		if (!selector) throw new Error("replacement selector was not mounted");

		controller.abort();
		expect(host.extensionInput).toBeUndefined();
		expect(host.extensionSelector).toBe(selector);
		expect(host.editorContainer.children).toEqual([selector]);
		selector.handleInput("\n");
		await expect(selectorPromise).resolves.toBe("replacement");
	});

	it("restores the editor when an input completes", async () => {
		const host = createHost();
		const pending = showInput.call(host, "Input");
		const input = host.extensionInput;
		if (!input) throw new Error("input was not mounted");
		expect(input.focused).toBe(true);
		expect(host.getRenderRequests()).toBe(1);

		input.handleInput("value");
		input.handleInput("\n");

		await expect(pending).resolves.toBe("value");
		expect(input.focused).toBe(false);
		expect(host.getRenderRequests()).toBe(2);
		expect(host.extensionInput).toBeUndefined();
		expect(host.editorContainer.children).toEqual([host.ui.getEditor()]);
	});

	it("settles the active selector when an unrelated overlay supersedes it", async () => {
		const host = createHost();
		const pending = showSelector.call(host, "Pending", ["value"]);
		const replacement = new Text("replacement", 0, 0);

		host.ui.overlayHost.swap(replacement);
		const outcome = await Promise.race([
			pending.then(() => "settled"),
			new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
		]);

		expect(outcome).toBe("settled");
		expect(host.extensionSelector).toBeUndefined();
		expect(host.editorContainer.children).toEqual([replacement]);
	});

	it("settles the active selector when extension UI is reset", async () => {
		const host = createHost();
		const pending = showSelector.call(host, "Pending", ["value"]);
		expect(host.extensionSelector).toBeDefined();

		resetExtensionUI.call(host);

		await expect(pending).resolves.toBeUndefined();
		expect(host.extensionSelector).toBeUndefined();
	});

	it("isolates and retires a failing extension terminal-input listener", () => {
		const host = createHost();
		const extensionUI = createExtensionUIContext.call(host);
		const failingListener = vi.fn(() => {
			throw new Error("terminal listener failed");
		});
		extensionUI.onTerminalInput(failingListener);
		const laterListener = vi.fn((data: string) => ({ data: `${data}:later` }));
		host.ui.tui.addInputListener(laterListener);
		host.ui.tui.setFocus(host.ui.getEditor());
		host.ui.tui.start();
		try {
			expect(() => host.terminal.sendInput("first")).not.toThrow();
			expect(failingListener).toHaveBeenCalledOnce();
			expect(laterListener).toHaveBeenLastCalledWith("first");
			expect(host.editorInput).toEqual(["first:later"]);
			expect(host.ui.showError).toHaveBeenCalledOnce();
			expect(host.ui.showError).toHaveBeenCalledWith("Terminal input handler error: terminal listener failed");

			host.terminal.sendInput("second");
			expect(failingListener).toHaveBeenCalledOnce();
			expect(laterListener).toHaveBeenLastCalledWith("second");
			expect(host.editorInput).toEqual(["first:later", "second:later"]);
			expect(host.ui.showError).toHaveBeenCalledOnce();
		} finally {
			host.ui.tui.stop();
		}
	});

	it("retains successful extension terminal-input transformation across events", () => {
		const host = createHost();
		const extensionUI = createExtensionUIContext.call(host);
		const extensionListener = vi.fn((data: string) => ({ data: `${data}:extension` }));
		extensionUI.onTerminalInput(extensionListener);
		host.ui.tui.addInputListener((data) => ({ data: `${data}:later` }));
		host.ui.tui.setFocus(host.ui.getEditor());
		host.ui.tui.start();
		try {
			host.terminal.sendInput("first");
			host.terminal.sendInput("second");
			expect(extensionListener).toHaveBeenCalledTimes(2);
			expect(host.editorInput).toEqual(["first:extension:later", "second:extension:later"]);
			expect(host.ui.showError).not.toHaveBeenCalled();
		} finally {
			host.ui.tui.stop();
		}
	});

	it("contains a throwing extension terminal-input result getter", () => {
		const host = createHost();
		const extensionUI = createExtensionUIContext.call(host);
		const hostileResult: { data?: string } = {};
		Object.defineProperty(hostileResult, "data", {
			get: () => {
				throw Object.create(null);
			},
		});
		const extensionListener = vi.fn(() => hostileResult);
		extensionUI.onTerminalInput(extensionListener);
		host.ui.tui.setFocus(host.ui.getEditor());
		host.ui.tui.start();
		try {
			expect(() => host.terminal.sendInput("first")).not.toThrow();
			host.terminal.sendInput("second");
			expect(extensionListener).toHaveBeenCalledOnce();
			expect(host.editorInput).toEqual(["first", "second"]);
			expect(host.ui.showError).toHaveBeenCalledWith("Terminal input handler error: Handler failed.");
		} finally {
			host.ui.tui.stop();
		}
	});

	it("rejects a pending custom factory when an unrelated overlay supersedes it", async () => {
		const host = createHost();
		let resolveFactory!: (component: Text) => void;
		const customPromise = showCustom.call(
			host,
			() =>
				new Promise<Text>((resolve) => {
					resolveFactory = resolve;
				}),
		) as Promise<string>;
		const customRejection = expect(customPromise).rejects.toThrow("superseded or reset");
		await Promise.resolve();
		await Promise.resolve();
		const replacement = new Text("replacement", 0, 0);

		host.ui.overlayHost.swap(replacement);
		await customRejection;
		resolveFactory(new Text("late custom", 0, 0));
		await Promise.resolve();
		await Promise.resolve();
		expect(host.editorContainer.children).toEqual([replacement]);
	});

	it("rejects a superseded custom component instead of orphaning its promise", async () => {
		const host = createHost();
		const customPromise = showCustom.call(host, () => new Text("custom", 0, 0)) as Promise<string>;
		const customRejection = expect(customPromise).rejects.toThrow("superseded or reset");
		await Promise.resolve();
		await Promise.resolve();

		const selectorPromise = showSelector.call(host, "Replacement", ["replacement"]);
		await customRejection;
		const selector = host.extensionSelector;
		if (!selector) throw new Error("replacement selector was not mounted");
		selector.handleInput("\n");
		await expect(selectorPromise).resolves.toBe("replacement");
	});
});
