import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const mocks = vi.hoisted(() => ({
	readClipboardImage: vi.fn<() => Promise<null | { bytes: Uint8Array; mimeType: string }>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
	resizeImage: vi.fn(),
}));

vi.mock("../src/utils/clipboard-image.ts", () => ({
	readClipboardImage: mocks.readClipboardImage,
}));

vi.mock("../src/utils/clipboard.ts", () => ({
	readClipboardText: mocks.readClipboardText,
}));

vi.mock("../src/utils/image-resize.ts", () => ({
	resizeImage: mocks.resizeImage,
	formatDimensionNote: vi.fn(() => undefined),
}));

type ClipboardPasteContext = {
	clipboardQueue: {
		pendingClipboardImages: unknown[];
		clipboardImageCounter: number;
	};
	clipboardImageStore?: {
		write: ReturnType<typeof vi.fn>;
		resolveReferences: ReturnType<typeof vi.fn>;
	};
	editor: { handleInput: ReturnType<typeof vi.fn>; insertTextAtCursor: ReturnType<typeof vi.fn> };
	ui: { requestRender: ReturnType<typeof vi.fn> };
	settingsManager: { getImageAutoResize: () => boolean; getBlockImages: () => boolean };
	showStatus: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
};

type InteractiveModePrivate = {
	handleClipboardImagePaste(this: ClipboardPasteContext): Promise<void>;
};

describe("InteractiveMode clipboard image paste", () => {
	function createContext(): ClipboardPasteContext {
		return {
			clipboardQueue: {
				pendingClipboardImages: [],
				clipboardImageCounter: 0,
			},
			clipboardImageStore: {
				write: vi.fn((bytes: Uint8Array, mimeType: string) => ({
					sequence: 3,
					path: "/managed/image.png",
					mimeType,
					bytes,
				})),
				resolveReferences: vi.fn(() => []),
			},
			editor: { handleInput: vi.fn(), insertTextAtCursor: vi.fn() },
			ui: { requestRender: vi.fn() },
			settingsManager: { getImageAutoResize: () => false, getBlockImages: () => false },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
		};
	}

	it("does not show a no-image status when a text paste chord has no image", async () => {
		mocks.readClipboardImage.mockResolvedValueOnce(null);
		mocks.readClipboardText.mockResolvedValueOnce(null);
		const context = createContext();

		await (InteractiveMode.prototype as unknown as InteractiveModePrivate).handleClipboardImagePaste.call(context);

		expect(mocks.readClipboardImage).toHaveBeenCalledTimes(1);
		expect(context.showStatus).not.toHaveBeenCalled();
		expect(context.showWarning).not.toHaveBeenCalled();
	});

	it("falls back to ordinary bracketed text paste", async () => {
		mocks.readClipboardImage.mockResolvedValueOnce(null);
		mocks.readClipboardText.mockResolvedValueOnce("plain text");
		const context = createContext();

		await (InteractiveMode.prototype as unknown as InteractiveModePrivate).handleClipboardImagePaste.call(context);

		expect(context.editor.handleInput).toHaveBeenCalledWith("\x1b[200~plain text\x1b[201~");
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("stores and queues a clipboard image with a stable session label", async () => {
		mocks.readClipboardImage.mockResolvedValueOnce({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });
		const context = createContext();

		await (InteractiveMode.prototype as unknown as InteractiveModePrivate).handleClipboardImagePaste.call(context);

		expect(context.clipboardImageStore?.write).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), "image/png");
		expect(context.editor.insertTextAtCursor).toHaveBeenCalledWith("[Image #3] ");
		expect(context.clipboardQueue.pendingClipboardImages).toEqual([
			{ label: "[Image #3]", content: { type: "image", data: "AQID", mimeType: "image/png" } },
		]);
		expect(context.showStatus).toHaveBeenCalledWith("Attached [Image #3] · PNG · 1 KiB");
	});
});
