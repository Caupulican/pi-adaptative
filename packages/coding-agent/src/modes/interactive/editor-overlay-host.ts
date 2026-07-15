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
	/** Called exactly once when a later swap or explicit unmount replaces this component. */
	onUnmount?: () => void;
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
	private mountedOnUnmount: (() => void) | undefined;

	constructor(container: Container, ui: EditorOverlayUi) {
		this.container = container;
		this.ui = ui;
	}

	private notifyMountedUnmount(): void {
		// Unmount callbacks may synchronously mount another overlay. Drain those nested generations
		// before the caller installs its replacement so no reentrant component is displaced silently.
		while (this.mountedOnUnmount) {
			const onUnmount = this.mountedOnUnmount;
			this.mountedOnUnmount = undefined;
			try {
				onUnmount();
			} catch {
				// A defective overlay cleanup must not strand the UI on the displaced component.
			}
		}
	}

	/**
	 * Replace whatever the editor container currently holds with `component`,
	 * focus a target, and (by default) request a render.
	 */
	swap(component: Component, options: EditorOverlaySwapOptions = {}): void {
		this.notifyMountedUnmount();
		this.container.clear();
		this.container.addChild(component);
		this.mountedOnUnmount = options.onUnmount;
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

	/** Mount a callback-driven selector and settle it if another overlay supersedes it. */
	showSelector(
		getRestoreComponent: () => Component,
		create: (done: () => void) => {
			component: Component;
			focus: Component;
			onSuperseded?: () => void;
		},
	): void {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			this.swap(getRestoreComponent(), { focusMode: "restore", render: "none" });
		};
		const mounted = create(done);
		this.swap(mounted.component, {
			focus: mounted.focus,
			onUnmount: () => {
				if (settled) {
					try {
						(mounted.component as Component & { dispose?: () => void }).dispose?.();
					} catch {
						// Disposal is best effort after normal completion.
					}
					return;
				}
				settled = true;
				try {
					(mounted.component as Component & { dispose?: () => void }).dispose?.();
				} catch {
					// Supersession still has to settle when component cleanup fails.
				}
				mounted.onSuperseded?.();
			},
		});
	}

	/** Settle and remove the currently mounted component without mounting a replacement. */
	unmount(): void {
		this.notifyMountedUnmount();
		this.container.clear();
	}
}
