import type { Component, OverlayHandle, OverlayOptions } from "@caupulican/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { TranscriptPager } from "./transcript-pager.ts";

export interface TranscriptOverlayOptions {
	source: Component;
	viewportRows: () => number;
	keybindings: KeybindingsManager;
	getToolsExpanded: () => boolean;
	setToolsExpanded: (expanded: boolean) => void;
	showOverlay: (component: Component, options: OverlayOptions) => OverlayHandle;
}

/** Owns the expanded transcript overlay and restores the caller's tool-detail state exactly once. */
export function openTranscriptOverlay(options: TranscriptOverlayOptions): OverlayHandle {
	const previousToolsExpanded = options.getToolsExpanded();
	let handle: OverlayHandle | undefined;
	let restored = false;
	const restoreToolState = () => {
		if (restored) return;
		restored = true;
		options.setToolsExpanded(previousToolsExpanded);
	};
	const pager = new TranscriptPager({
		source: options.source,
		viewportRows: options.viewportRows,
		keybindings: options.keybindings,
		onClose: () => handle?.hide(),
	});

	options.setToolsExpanded(true);
	try {
		handle = options.showOverlay(pager, {
			width: "100%",
			maxHeight: "100%",
			row: 0,
			col: 0,
			onRemove: restoreToolState,
		});
		return handle;
	} catch (error) {
		restoreToolState();
		throw error;
	}
}
