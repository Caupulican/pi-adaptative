/**
 * Clipboard-image paste and user-input assembly extracted from interactive-mode.
 *
 * `handleClipboardImagePaste` reads an image off the clipboard, labels it, and
 * queues it for the next submission; `takeClipboardImagesForText` drains the
 * queued images whose labels survive in the submitted text; and
 * `buildUserInputSubmission` pairs the text with those images. They mutate the
 * pending-image queue/counter through a `ClipboardInputHost` seam;
 * interactive-mode keeps thin wrappers.
 */

import type { ImageContent } from "@caupulican/pi-ai";
import type { EditorComponent, TUI } from "@caupulican/pi-tui";
import { readClipboardImage } from "../../utils/clipboard-image.ts";

export type UserInputSubmission = {
	text: string;
	images?: ImageContent[];
};

export type PendingClipboardImage = {
	label: string;
	content: ImageContent;
};

export interface ClipboardQueueHost {
	pendingClipboardImages: PendingClipboardImage[];
	clipboardImageCounter: number;
}

export interface ClipboardInputHost extends ClipboardQueueHost {
	readonly editor: Pick<EditorComponent, "insertTextAtCursor">;
	readonly ui: Pick<TUI, "requestRender">;
	showStatus(message: string): void;
	showWarning(message: string): void;
}

export interface BuildSubmissionHost {
	takeClipboardImagesForText(text: string): ImageContent[] | undefined;
}

export async function handleClipboardImagePaste(host: ClipboardInputHost): Promise<void> {
	try {
		const image = await readClipboardImage();
		if (!image) {
			return;
		}

		const label = nextClipboardImageLabel(host);
		const mimeType = image.mimeType.split(";")[0]?.trim().toLowerCase() || image.mimeType;
		host.pendingClipboardImages.push({
			label,
			content: {
				type: "image",
				data: Buffer.from(image.bytes).toString("base64"),
				mimeType,
			},
		});

		host.editor.insertTextAtCursor?.(`${label} `);
		host.showStatus(`Attached clipboard image ${label} (${mimeType})`);
		host.ui.requestRender();
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		host.showWarning(`Failed to paste image: ${message}`);
	}
}

function nextClipboardImageLabel(host: ClipboardQueueHost): string {
	if (host.pendingClipboardImages.length === 0) {
		host.clipboardImageCounter = 0;
	}
	host.clipboardImageCounter += 1;
	return `[Image #${host.clipboardImageCounter}]`;
}

export function takeClipboardImagesForText(host: ClipboardQueueHost, text: string): ImageContent[] | undefined {
	if (host.pendingClipboardImages.length === 0) {
		return undefined;
	}

	const images = host.pendingClipboardImages
		.filter((image) => text.includes(image.label))
		.map((image) => image.content);
	host.pendingClipboardImages = [];
	host.clipboardImageCounter = 0;
	return images.length > 0 ? images : undefined;
}

export function buildUserInputSubmission(host: BuildSubmissionHost, text: string): UserInputSubmission {
	const images = host.takeClipboardImagesForText(text);
	return images ? { text, images } : { text };
}
