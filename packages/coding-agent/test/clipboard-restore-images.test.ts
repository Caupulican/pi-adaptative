import type { ImageContent } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionImageStore } from "../src/core/session-image-store.ts";
import {
	type ClipboardRestoreHost,
	restoreClipboardImages,
	takeClipboardImagesForText,
} from "../src/modes/interactive/clipboard-input.ts";
import { tempDir } from "./temp-dir.ts";

const image = (words: string): ImageContent => ({
	type: "image",
	data: Buffer.from(words).toString("base64"),
	mimeType: "image/png",
});

function host(
	pending: ClipboardRestoreHost["pendingClipboardImages"] = [],
	store?: SessionImageStore,
): ClipboardRestoreHost {
	return {
		pendingClipboardImages: pending,
		clipboardImageCounter: pending.length,
		...(store ? { clipboardImageStore: store } : {}),
	};
}

function sessionStore(...stored: string[]): SessionImageStore {
	const directory = tempDir("pi-restore-images-");
	const store = new SessionImageStore({ agentDir: directory, cwd: directory, sessionId: "restore", directory });
	for (const words of stored) store.write(Buffer.from(words), "image/png");
	return store;
}

const words = (images: ImageContent[] | undefined) =>
	images?.map((part) => Buffer.from(part.data, "base64").toString());

describe("restoring queued input to the editor keeps its images", () => {
	it("a labelled image returns under its label and is attached again by the same text", () => {
		const queue = host();
		const [text] = restoreClipboardImages(queue, [{ text: "look [Image #1] here", images: [image("a")] }]);
		expect(text).toBe("look [Image #1] here");
		expect(takeClipboardImagesForText(queue, text!)).toEqual([image("a")]);
	});

	it("an unlabelled image gets a label so the restored text can carry it", () => {
		const queue = host();
		const [text] = restoreClipboardImages(queue, [{ text: "plain words", images: [image("b")] }]);
		expect(text).toBe("plain words [Image #1]");
		expect(takeClipboardImagesForText(queue, text!)).toEqual([image("b")]);
	});

	it("without a store, colliding labels are made distinct and images follow the restored text order", () => {
		const queue = host([{ label: "[Image #1]", content: image("editor") }]);
		const texts = restoreClipboardImages(queue, [
			{ text: "first [Image #1]", images: [image("first")] },
			{ text: "second [Image #1]", images: [image("second")] },
		]);
		expect(texts).toEqual(["first [Image #2]", "second [Image #3]"]);
		expect(words(takeClipboardImagesForText(queue, [...texts, "editor [Image #1]"].join("\n\n")))).toEqual([
			"first",
			"second",
			"editor",
		]);
	});
});

describe("restoring with the session image store keeps durable identity exact", () => {
	it("a renamed restored image never takes an occupied durable sequence of an unrelated image", () => {
		const store = sessionStore("editor", "unrelated");
		const queue = host([{ label: "[Image #1]", content: image("editor") }], store);
		const [text] = restoreClipboardImages(queue, [{ text: "restore [Image #1]", images: [image("restored")] }]);
		expect(text).not.toBe("restore [Image #2]");
		expect(words(takeClipboardImagesForText(queue, `${text}\n\neditor [Image #1]`))).toEqual(["restored", "editor"]);
	});

	it("a label whose durable bytes are these bytes is kept", () => {
		const store = sessionStore("kept");
		const queue = host([], store);
		const [text] = restoreClipboardImages(queue, [{ text: "see [Image #1]", images: [image("kept")] }]);
		expect(text).toBe("see [Image #1]");
		expect(words(takeClipboardImagesForText(queue, text!))).toEqual(["kept"]);
	});

	it("an occupied durable label naming other bytes is renamed, every reference to it with it", () => {
		const store = sessionStore("other");
		const queue = host([], store);
		const [text] = restoreClipboardImages(queue, [
			{ text: "[Image #1] then again [Image #1]", images: [image("mine")] },
		]);
		expect(text).not.toContain("[Image #1]");
		expect(text?.match(/\[Image #\d+\]/g)?.length).toBe(2);
		expect(words(takeClipboardImagesForText(queue, text!))).toEqual(["mine"]);
	});

	it("reordered references pair each image with the label that names its bytes", () => {
		const store = sessionStore("one", "two");
		const queue = host([], store);
		const [text] = restoreClipboardImages(queue, [
			{ text: "second [Image #2] before first [Image #1]", images: [image("one"), image("two")] },
		]);
		expect(text).toBe("second [Image #2] before first [Image #1]");
		expect(words(takeClipboardImagesForText(queue, text!))).toEqual(["one", "two"]);
	});

	it("an unlabelled image and two restored entries with the same label each get their own durable sequence", () => {
		const store = sessionStore("taken");
		const queue = host([], store);
		const texts = restoreClipboardImages(queue, [
			{ text: "a [Image #1]", images: [image("alpha")] },
			{ text: "b [Image #1]", images: [image("beta")] },
			{ text: "c", images: [image("gamma")] },
		]);
		const labels = texts.map((text) => text.match(/\[Image #\d+\]/)?.[0]);
		expect(new Set(labels).size).toBe(3);
		expect(labels).not.toContain("[Image #1]");
		expect(words(takeClipboardImagesForText(queue, texts.join("\n\n")))).toEqual(["alpha", "beta", "gamma"]);
	});

	it("control: an ordinary stored reference still resolves after a restore", () => {
		const store = sessionStore("stored");
		const queue = host([], store);
		restoreClipboardImages(queue, [{ text: "r [Image #9]", images: [image("restored")] }]);
		queue.pendingClipboardImages = [];
		expect(words(takeClipboardImagesForText(queue, "look at [Image #1]"))).toEqual(["stored"]);
	});
});
