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
import { type EditorComponent, pasteIntoEditor, type TUI } from "@caupulican/pi-tui";
import type { SessionImageStore } from "../core/session-image-store.ts";
import { readClipboardText } from "../utils/clipboard.ts";
import { readClipboardImage } from "../utils/clipboard-image.ts";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.ts";

export type UserInputSubmission = {
	text: string;
	images?: ImageContent[];
};

export type PendingClipboardImage = {
	label: string;
	content: ImageContent;
};

export interface ClipboardQueueState {
	pendingClipboardImages: PendingClipboardImage[];
	clipboardImageCounter: number;
}

export interface ClipboardQueueHost extends ClipboardQueueState {
	readonly clipboardImageStore?: Pick<SessionImageStore, "resolveReferences">;
}

export interface ClipboardInputHost extends ClipboardQueueHost {
	readonly editor: Pick<EditorComponent, "handleInput" | "insertTextAtCursor" | "pasteText">;
	readonly ui: Pick<TUI, "requestRender" | "pasteText">;
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

export function bindClipboardQueue(
	state: ClipboardQueueState,
	controls: Omit<ClipboardInputHost, keyof ClipboardQueueHost>,
): ClipboardInputHost;
export function bindClipboardQueue<TControls extends object>(
	state: ClipboardQueueState,
	controls: TControls,
): ClipboardQueueHost & TControls;
export function bindClipboardQueue<TControls extends object>(
	state: ClipboardQueueState,
	controls: TControls,
): ClipboardQueueHost & TControls {
	return {
		...controls,
		get pendingClipboardImages() {
			return state.pendingClipboardImages;
		},
		set pendingClipboardImages(value) {
			state.pendingClipboardImages = value;
		},
		get clipboardImageCounter() {
			return state.clipboardImageCounter;
		},
		set clipboardImageCounter(value) {
			state.clipboardImageCounter = value;
		},
	};
}

export async function handleClipboardImagePaste(host: ClipboardInputHost): Promise<void> {
	try {
		const image = await readClipboardImage();
		if (!image) {
			const text = await readClipboardText();
			if (text) {
				if (typeof host.ui.pasteText !== "function" || !host.ui.pasteText(text)) {
					pasteIntoEditor(host.editor, text);
				}
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

const IMAGE_LABEL = /\[Image #(\d+)\]/g;

function imageLabelNumber(label: string): number {
	return Number(/\[Image #(\d+)\]/.exec(label)?.[1] ?? 0);
}

function sameImage(stored: { mimeType: string; bytes: Uint8Array } | undefined, image: ImageContent): boolean {
	return (
		stored !== undefined &&
		stored.mimeType === image.mimeType &&
		Buffer.from(stored.bytes).equals(Buffer.from(image.data, "base64"))
	);
}

/** A queue host that can also give restored images a durable identity in the session image store. */
export interface ClipboardRestoreHost extends ClipboardQueueState {
	readonly clipboardImageStore?: Pick<SessionImageStore, "resolveReferences" | "retainContent" | "read">;
}

/**
 * Hand restored inputs' images back to the pending clipboard queue, ahead of the editor's own
 * images (the restored text precedes the editor's text), under labels that resolve to exactly
 * those images when the text is submitted again. A label is kept when it already names these bytes
 * in the session image store, or names nothing yet; otherwise the store's own allocator gives the
 * image a sequence, and every reference to the old label in that input's text is renamed.
 */
export function restoreClipboardImages(host: ClipboardRestoreHost, inputs: readonly UserInputSubmission[]): string[] {
	const store = host.clipboardImageStore;
	const restored: PendingClipboardImage[] = [];
	const labelTaken = (label: string, image: ImageContent) =>
		[...restored, ...host.pendingClipboardImages].some(
			(pending) =>
				pending.label === label &&
				(pending.content.data !== image.data || pending.content.mimeType !== image.mimeType),
		) ||
		(store !== undefined &&
			store.read(imageLabelNumber(label)) !== undefined &&
			!sameImage(store.read(imageLabelNumber(label)), image));
	const freeNumber = (): number => {
		let candidate =
			Math.max(
				host.clipboardImageCounter,
				...[...restored, ...host.pendingClipboardImages].map((pending) => imageLabelNumber(pending.label)),
			) + 1;
		while (store?.read(candidate) !== undefined) candidate++;
		return candidate;
	};
	const texts = inputs.map((input) => {
		let text = input.text;
		const available = [...new Set([...text.matchAll(IMAGE_LABEL)].map((match) => match[0]))];
		for (const image of input.images ?? []) {
			let label =
				available.find(
					(candidate) => store !== undefined && sameImage(store.read(imageLabelNumber(candidate)), image),
				) ?? available.find((candidate) => !labelTaken(candidate, image));
			if (label) {
				available.splice(available.indexOf(label), 1);
			} else {
				let sequence: number;
				try {
					sequence = store ? store.retainContent(image).sequence : freeNumber();
				} catch {
					// Durable retention is an optimization of identity, not a condition of recovery.
					sequence = freeNumber();
				}
				label = `[Image #${sequence}]`;
				const replaced = available.shift();
				text = replaced ? text.split(replaced).join(label) : `${text} ${label}`;
			}
			restored.push({ label, content: image });
			host.clipboardImageCounter = Math.max(host.clipboardImageCounter, imageLabelNumber(label));
		}
		return text;
	});
	host.pendingClipboardImages = [...restored, ...host.pendingClipboardImages];
	return texts;
}

export function buildUserInputSubmission(host: BuildSubmissionHost, text: string): UserInputSubmission {
	const images = host.takeClipboardImagesForText(text);
	return images ? { text, images } : { text };
}
