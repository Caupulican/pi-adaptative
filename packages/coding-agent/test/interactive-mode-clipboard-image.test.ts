import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const mocks = vi.hoisted(() => ({
	readClipboardImage: vi.fn<() => Promise<null>>(),
}));

vi.mock("../src/utils/clipboard-image.ts", () => ({
	readClipboardImage: mocks.readClipboardImage,
}));

type ClipboardPasteContext = {
	showStatus: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
};

type InteractiveModePrivate = {
	handleClipboardImagePaste(this: ClipboardPasteContext): Promise<void>;
};

describe("InteractiveMode clipboard image paste", () => {
	it("does not show a no-image status when a text paste chord has no image", async () => {
		mocks.readClipboardImage.mockResolvedValueOnce(null);
		const context: ClipboardPasteContext = {
			showStatus: vi.fn(),
			showWarning: vi.fn(),
		};

		await (InteractiveMode.prototype as unknown as InteractiveModePrivate).handleClipboardImagePaste.call(context);

		expect(mocks.readClipboardImage).toHaveBeenCalledTimes(1);
		expect(context.showStatus).not.toHaveBeenCalled();
		expect(context.showWarning).not.toHaveBeenCalled();
	});
});
