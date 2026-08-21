import type { Component, OverlayHandle, OverlayOptions } from "@caupulican/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { TranscriptPager } from "./transcript-pager.ts";

export interface TranscriptOverlayOptions {
	source: Component;
	viewportRows: () => number;
	keybindings: KeybindingsManager;
	getToolsExpanded: () => boolean;
	setToolsExpanded: (expanded: boolean) => void;
	getActionsExpanded: () => boolean;
	setActionsExpanded: (expanded: boolean) => void;
	showOverlay: (component: Component, options: OverlayOptions) => OverlayHandle;
}

/** Owns the detailed transcript projection and restores both expansion states exactly once. */
export function openTranscriptOverlay(options: TranscriptOverlayOptions): OverlayHandle {
	const previousToolsExpanded = options.getToolsExpanded();
	const previousActionsExpanded = options.getActionsExpanded();
	let handle: OverlayHandle | undefined;
	let restored = false;
	const restoreProjectionState = () => {
		if (restored) return;
		restored = true;
		options.setActionsExpanded(previousActionsExpanded);
		options.setToolsExpanded(previousToolsExpanded);
	};
	const pager = new TranscriptPager({
		source: options.source,
		viewportRows: options.viewportRows,
		keybindings: options.keybindings,
		onClose: () => handle?.hide(),
	});

	try {
		options.setToolsExpanded(true);
		options.setActionsExpanded(true);
		handle = options.showOverlay(pager, {
			width: "100%",
			maxHeight: "100%",
			row: 0,
			col: 0,
			onRemove: restoreProjectionState,
		});
		return handle;
	} catch (error) {
		restoreProjectionState();
		throw error;
	}
}
