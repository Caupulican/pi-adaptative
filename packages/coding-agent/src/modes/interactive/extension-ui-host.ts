/**
 * Extension UI host.
 *
 * Extracted verbatim from interactive-mode.ts (god-file decomposition). Owns the interactive-mode
 * surface of the extension UI API: extension-provided dialogs (selector / confirm / input / multi-line
 * editor / custom component), widget mounting above and below the editor, extension status text, custom
 * footer and header swaps, the custom editor-component swap, keyboard-shortcut wiring, terminal-input
 * listeners, and the `ExtensionUIContext` handed to extensions. It owns exactly the state this cluster
 * mutates (the live dialog components, the widget maps, the terminal-input unsubscribers, the custom
 * footer/header, and the current custom-editor factory) and reaches everything else — the mutable
 * `editor`, the render-core containers, the working-indicator, autocomplete wiring, theme/tools state —
 * through a narrow deps/ui surface rather than the whole InteractiveMode instance. Extensions must see
 * identical behavior, so the render-core operations (working indicator, hidden-thinking label,
 * autocomplete rebuild) stay host-side and are invoked here as delegations.
 */

import type {
	AutocompleteProvider,
	Component,
	EditorComponent,
	KeyId,
	LoaderIndicatorOptions,
	OverlayHandle,
	OverlayOptions,
} from "@caupulican/pi-tui";
import { Container, matchesKey, Spacer, Text, type TUI } from "@caupulican/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.ts";
import type { FooterDataProvider, ReadonlyFooterDataProvider } from "../../core/footer-data-provider.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import type { CustomEditor } from "./components/custom-editor.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import type { FooterComponent } from "./components/footer.ts";
import type { EditorOverlayHost } from "./editor-overlay-host.ts";
import {
	getAvailableThemesWithPaths,
	getEditorTheme,
	getThemeByName,
	setTheme,
	setThemeInstance,
	Theme,
	theme,
} from "./theme/theme.ts";

/** Components that can be expanded/collapsed (custom headers may opt in). */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

/**
 * The narrow slice of InteractiveMode the extension UI host drives. Stable containers and the TUI are
 * passed directly; mutable render-core state (the active editor, built-in header, loading animation,
 * autocomplete wrappers, tools-expansion) is read/written through accessors so InteractiveMode keeps
 * ownership; and render-core / status operations stay host-side and are exposed here as callbacks.
 */
export interface ExtensionUiHostUi {
	readonly tui: TUI;
	readonly overlayHost: EditorOverlayHost;
	readonly keybindings: KeybindingsManager;
	readonly footer: FooterComponent;
	readonly footerDataProvider: FooterDataProvider;
	readonly headerContainer: Container;
	readonly chatContainer: Container;
	readonly editorContainer: Container;
	readonly defaultEditor: CustomEditor;
	readonly widgetContainerAbove: Container;
	readonly widgetContainerBelow: Container;

	getEditor(): EditorComponent;
	setEditor(editor: EditorComponent): void;
	getBuiltInHeader(): Component | undefined;
	getAutocompleteProvider(): AutocompleteProvider | undefined;
	getToolsExpanded(): boolean;
	pushAutocompleteProviderWrapper(factory: AutocompleteProviderFactory): void;
	resetAutocompleteProviderWrappers(): void;

	setupAutocompleteProvider(): void;
	setWorkingVisible(visible: boolean): void;
	setWorkingIndicator(options?: LoaderIndicatorOptions): void;
	setHiddenThinkingLabel(label?: string): void;
	setWorkingMessage(message: string | undefined): void;
	resetWorkingIndicators(): void;
	setToolsExpanded(expanded: boolean): void;
	toggleToolsExpanded(): void;
	updateTerminalTitle(): void;
	markShutdownRequested(): void;
	abort(): void;
	reload(): Promise<void>;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
}

export interface ExtensionUiHostDeps {
	getSession(): AgentSession;
	ui: ExtensionUiHostUi;
}

export class ExtensionUiHost {
	private readonly deps: ExtensionUiHostDeps;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	// Current custom editor-component factory (undefined = default editor)
	private editorComponentFactory: EditorFactory | undefined;

	constructor(deps: ExtensionUiHostDeps) {
		this.deps = deps;
	}

	private get session(): AgentSession {
		return this.deps.getSession();
	}
	private get ui(): ExtensionUiHostUi {
		return this.deps.ui;
	}

	/** The active custom header, if an extension has installed one. */
	getCustomHeader(): (Component & { dispose?(): void }) | undefined {
		return this.customHeader;
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.ui.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			hasUI: true,
			mode: "tui",
			cwd: this.session.sessionManager.getCwd(),
			sessionManager: this.session.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isStreaming,
			signal: this.session.agent.signal,
			abort: () => {
				this.ui.abort();
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.ui.markShutdownRequested();
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.session.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			reload: async () => {
				await this.ui.reload();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.ui.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.ui.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.ui.footerDataProvider.setExtensionStatus(key, text);
		this.ui.tui.requestRender();
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, ExtensionUiHost.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > ExtensionUiHost.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui.tui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.tui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.ui.footerDataProvider.clearExtensionStatuses();
		this.ui.footer.invalidate();
		this.ui.resetAutocompleteProviderWrappers();
		this.setCustomEditorComponent(undefined);
		this.ui.setupAutocompleteProvider();
		this.ui.defaultEditor.onExtensionShortcut = undefined;
		this.ui.updateTerminalTitle();
		this.ui.resetWorkingIndicators();
	}

	/**
	 * Render all extension widgets to the widget container.
	 */
	renderWidgets(): void {
		if (!this.ui.widgetContainerAbove || !this.ui.widgetContainerBelow) return;
		this.renderWidgetContainer(this.ui.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.ui.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.tui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.tui.removeChild(this.customFooter);
		} else {
			this.ui.tui.removeChild(this.ui.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui.tui, theme, this.ui.footerDataProvider);
			this.ui.tui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.tui.addChild(this.ui.footer);
		}

		this.ui.tui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		const builtInHeader = this.ui.getBuiltInHeader();
		if (!builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || builtInHeader;
		const index = this.ui.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui.tui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.ui.getToolsExpanded());
			}
			if (index !== -1) {
				this.ui.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.ui.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (isExpandable(builtInHeader)) {
				builtInHeader.setExpanded(this.ui.getToolsExpanded());
			}
			if (index !== -1) {
				this.ui.headerContainer.children[index] = builtInHeader;
			}
		}

		this.ui.tui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.tui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => this.ui.setWorkingMessage(message),
			setWorkingVisible: (visible) => this.ui.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.ui.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.ui.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.tui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.ui.getEditor().handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.ui.getEditor().setText(text),
			getEditorText: () => this.ui.getEditor().getExpandedText?.() ?? this.ui.getEditor().getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.ui.pushAutocompleteProviderWrapper(factory);
				this.ui.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.ui.tui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					if (this.session.settingsManager.getTheme() !== themeOrName) {
						this.session.settingsManager.setTheme(themeOrName);
					}
					this.ui.tui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.ui.getToolsExpanded(),
			setToolsExpanded: (expanded) => this.ui.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui.tui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.ui.toggleToolsExpanded() },
			);

			this.ui.overlayHost.swap(this.extensionSelector);
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.extensionSelector = undefined;
		this.ui.overlayHost.swap(this.ui.getEditor());
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	async showExtensionConfirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui.tui, timeout: opts?.timeout },
			);

			this.ui.overlayHost.swap(this.extensionInput);
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.extensionInput = undefined;
		this.ui.overlayHost.swap(this.ui.getEditor());
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui.tui,
				this.ui.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.ui.overlayHost.swap(this.extensionEditor);
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.extensionEditor = undefined;
		this.ui.overlayHost.swap(this.ui.getEditor());
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;

		// Save text from current editor before switching
		const currentText = this.ui.getEditor().getText();

		this.ui.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui.tui, getEditorTheme(), this.ui.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.ui.defaultEditor.onSubmit;
			newEditor.onChange = this.ui.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.ui.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.ui.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			const autocompleteProvider = this.ui.getAutocompleteProvider();
			if (newEditor.setAutocompleteProvider && autocompleteProvider) {
				newEditor.setAutocompleteProvider(autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.ui.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.ui.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.ui.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.ui.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.ui.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.ui.setEditor(newEditor);
		} else {
			// Restore default editor with text from custom editor
			this.ui.defaultEditor.setText(currentText);
			this.ui.setEditor(this.ui.defaultEditor);
		}

		this.ui.editorContainer.addChild(this.ui.getEditor() as Component);
		this.ui.tui.setFocus(this.ui.getEditor() as Component);
		this.ui.tui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.ui.showError(message);
		} else if (type === "warning") {
			this.ui.showWarning(message);
		} else {
			this.ui.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.ui.getEditor().getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.ui.getEditor().setText(savedText);
			this.ui.overlayHost.swap(this.ui.getEditor(), { focusMode: "restore" });
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.tui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui.tui, theme, this.ui.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.tui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.ui.overlayHost.swap(component);
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.ui.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.ui.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.tui.requestRender();
	}
}
