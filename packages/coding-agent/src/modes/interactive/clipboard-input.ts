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
import type { SessionImageStore } from "../../core/session-image-store.ts";
import { readClipboardText } from "../../utils/clipboard.ts";
import { readClipboardImage } from "../../utils/clipboard-image.ts";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.ts";

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
	readonly clipboardImageStore?: Pick<SessionImageStore, "resolveReferences">;
}

export interface ClipboardInputHost extends ClipboardQueueHost {
	readonly editor: Pick<EditorComponent, "handleInput" | "insertTextAtCursor">;
	readonly ui: Pick<TUI, "requestRender">;
	readonly autoResizeImages: boolean;
	readonly blockImages: boolean;
	readonly blockImagesReason?: string;
	readonly imageStore?: Pick<SessionImageStore, "write">;
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
			const text = await readClipboardText();
			if (text) {
				host.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
				host.ui.requestRender();
			}
			return;
		}
		if (host.blockImages) {
			host.showWarning(host.blockImagesReason ?? "Image paste is blocked by images.blockImages.");
			return;
		}

		let bytes = image.bytes;
		let mimeType = image.mimeType.split(";")[0]?.trim().toLowerCase() || image.mimeType;
		let dimensionNote: string | undefined;
		if (host.autoResizeImages) {
			const resized = await resizeImage(bytes, mimeType);
			if (!resized) {
				host.showWarning("Clipboard image could not be resized below the inline image limit.");
				return;
			}
			bytes = Buffer.from(resized.data, "base64");
			mimeType = resized.mimeType;
			dimensionNote = formatDimensionNote(resized);
		}

		let storedSequence: number | undefined;
		try {
			storedSequence = host.imageStore?.write(bytes, mimeType).sequence;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			host.showWarning(`Image attached but could not be stored: ${message}`);
		}
		const label = storedSequence === undefined ? nextClipboardImageLabel(host) : `[Image #${storedSequence}]`;
		if (storedSequence !== undefined) host.clipboardImageCounter = storedSequence;
		host.pendingClipboardImages.push({
			label,
			content: {
				type: "image",
				data: Buffer.from(bytes).toString("base64"),
				mimeType,
			},
		});

		host.editor.insertTextAtCursor?.(`${label}${dimensionNote ? ` ${dimensionNote}` : ""} `);
		const sizeKiB = Math.max(1, Math.ceil(bytes.byteLength / 1024));
		host.showStatus(`Attached ${label} · ${mimeType.slice("image/".length).toUpperCase()} · ${sizeKiB} KiB`);
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
	if (host.pendingClipboardImages.length === 0 && !host.clipboardImageStore) {
		return undefined;
	}

	const images = host.pendingClipboardImages
		.filter((image) => text.includes(image.label))
		.map((image) => image.content);
	for (const stored of host.clipboardImageStore?.resolveReferences(text) ?? []) {
		if (!images.some((image) => image.mimeType === stored.mimeType && image.data === stored.data))
			images.push(stored);
	}
	host.pendingClipboardImages = [];
	host.clipboardImageCounter = 0;
	return images.length > 0 ? images : undefined;
}

export function buildUserInputSubmission(host: BuildSubmissionHost, text: string): UserInputSubmission {
	const images = host.takeClipboardImagesForText(text);
	return images ? { text, images } : { text };
}
