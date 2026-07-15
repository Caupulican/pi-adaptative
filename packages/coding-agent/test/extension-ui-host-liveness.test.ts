import { Container, type Terminal, Text, TUI } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { EditorOverlayHost } from "../src/modes/interactive/editor-overlay-host.ts";
import { ExtensionUiHost } from "../src/modes/interactive/extension-ui-host.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
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
}

function createHost() {
	const tui = new TUI(new FakeTerminal());
	const editorContainer = new Container();
	let editorText = "";
	const editor = new Text(editorText, 0, 0);
	const setEditorText = editor.setText.bind(editor);
	Object.assign(editor, {
		getText: () => editorText,
		setText: (value: string) => {
			editorText = value;
			setEditorText(value);
		},
	});
	editorContainer.addChild(editor);
	return {
		editorContainer,
		extensionSelector: undefined as ExtensionSelectorComponent | undefined,
		activeExtensionDialogCancel: undefined as (() => void) | undefined,
		extensionInput: undefined,
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
		},
		showExtensionSelector: Reflect.get(ExtensionUiHost.prototype, "showExtensionSelector"),
		hideExtensionSelector: Reflect.get(ExtensionUiHost.prototype, "hideExtensionSelector"),
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
const resetExtensionUI = Reflect.get(ExtensionUiHost.prototype, "resetExtensionUI") as (this: TestHost) => void;
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
