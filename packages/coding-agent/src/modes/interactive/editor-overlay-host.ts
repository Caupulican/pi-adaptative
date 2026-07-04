import type { Component, Container } from "@caupulican/pi-tui";

/** Focus operation the host performs after mounting a component. */
export type EditorOverlayFocusMode = "set" | "restore";

/** How the host requests a render after swapping the mounted component. */
export type EditorOverlayRenderMode = "default" | "sync" | "none";

/** The subset of the TUI the host drives. */
export interface EditorOverlayUi {
	setFocus(component: Component | null): void;
	restoreFocus(component: Component | null): void;
	requestRender(force?: boolean): void;
}

export interface EditorOverlaySwapOptions {
	/** Component to focus after mounting. Defaults to the mounted component. */
	focus?: Component;
	/**
	 * Whether to `setFocus` the target (default) or `restoreFocus` it. The latter
	 * prefers the topmost visible overlay and is used when returning to the editor
	 * from a selector.
	 */
	focusMode?: EditorOverlayFocusMode;
	/**
	 * Render request issued after the swap:
	 * - `"default"` (default): `requestRender()`
	 * - `"sync"`: `requestRender(true)` — force an immediate paint
	 * - `"none"`: leave rendering to the caller
	 */
	render?: EditorOverlayRenderMode;
}

/**
 * Owns the single-slot editor container and performs the recurring
 * "clear → mount one component → focus a target → request a render" swap that
 * interactive mode uses to show overlays (selectors, dialogs, loaders) in place
 * of the editor and to restore the editor afterwards.
 *
 * The host is stateless beyond its container/ui references: every swap names the
 * component to mount, so a changing active editor never has to be tracked here.
 */
export class EditorOverlayHost {
	private readonly container: Container;
	private readonly ui: EditorOverlayUi;

	constructor(container: Container, ui: EditorOverlayUi) {
		this.container = container;
		this.ui = ui;
	}

	/**
	 * Replace whatever the editor container currently holds with `component`,
	 * focus a target, and (by default) request a render.
	 */
	swap(component: Component, options: EditorOverlaySwapOptions = {}): void {
		this.container.clear();
		this.container.addChild(component);
		const target = options.focus ?? component;
		if (options.focusMode === "restore") {
			this.ui.restoreFocus(target);
		} else {
			this.ui.setFocus(target);
		}
		switch (options.render ?? "default") {
			case "default":
				this.ui.requestRender();
				break;
			case "sync":
				this.ui.requestRender(true);
				break;
			case "none":
				break;
		}
	}
}
