import { describe, expect, it } from "vitest";
import { bindClipboardQueue, type ClipboardQueueState } from "../src/modes/interactive/clipboard-input.ts";

describe("clipboard queue binding", () => {
	it("keeps every host bound to the authoritative queue state", () => {
		const state: ClipboardQueueState = {
			pendingClipboardImages: [],
			clipboardImageCounter: 0,
		};
		const first = bindClipboardQueue(state, { owner: "interactive" });
		const second = bindClipboardQueue(state, { owner: "question" });
		const attachment = {
			label: "[Image #1]",
			content: { type: "image" as const, data: "AQID", mimeType: "image/png" },
		};

		first.pendingClipboardImages = [attachment];
		first.clipboardImageCounter = 1;

		expect(state).toEqual({ pendingClipboardImages: [attachment], clipboardImageCounter: 1 });
		expect(second.pendingClipboardImages).toBe(state.pendingClipboardImages);
		expect(second.clipboardImageCounter).toBe(1);
		expect(first.owner).toBe("interactive");
		expect(second.owner).toBe("question");
	});
});
