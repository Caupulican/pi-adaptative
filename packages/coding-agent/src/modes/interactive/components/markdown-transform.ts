import type { Markdown } from "@caupulican/pi-tui";
import type { MarkdownTransformerContext } from "../../../core/extensions/types.ts";

/** Signature shared with `ExtensionAPI.registerMarkdownTransformer` (P2g). */
export type MarkdownTransformFn = (markdown: string, context: MarkdownTransformerContext) => string;

/** One display-only markdown block tracked so its transform can be re-run per render width. */
export interface MarkdownTransformSlot {
	component: Markdown;
	rawText: string;
	messageType: MarkdownTransformerContext["messageType"];
	lastTransformed?: string;
}

/**
 * Re-run a markdown transform chain for the current viewport width and push the result into the
 * underlying Markdown component only when it actually changed, so a render at an unchanged width
 * with unchanged transform output stays on Markdown's own text+width cache fast path instead of
 * forcing a reparse every frame. Callers must only ever pass already display-expanded text (path
 * aliases resolved) -- transformers are display-only and must never see raw wire-format tokens.
 */
export function applyMarkdownTransform(
	slot: MarkdownTransformSlot,
	transformMarkdown: MarkdownTransformFn,
	isStreaming: boolean,
	availableWidth: number,
): void {
	let transformed: string;
	try {
		transformed = transformMarkdown(slot.rawText, {
			messageType: slot.messageType,
			isStreaming,
			availableWidth,
		});
	} catch {
		transformed = slot.rawText;
	}
	if (transformed !== (slot.lastTransformed ?? slot.rawText)) {
		slot.component.setText(transformed);
	}
	slot.lastTransformed = transformed;
}
