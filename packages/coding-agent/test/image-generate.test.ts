import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantImages } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageGenerationController, type ImageGenerationOptions } from "../src/core/image-generation.ts";
import { SessionImageStore } from "../src/core/session-image-store.ts";

const image = {
	type: "image" as const,
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDogAAAAASUVORK5CYII=",
};
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-imagegen-test-"));
});
afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
	vi.useRealTimers();
});

function setup(overrides: Partial<ImageGenerationOptions> = {}) {
	const store = new SessionImageStore({ agentDir: directory, cwd: directory, sessionId: "session" });
	const result: AssistantImages = {
		api: "openai-codex-images",
		provider: "openai-codex",
		model: "gpt-image-2",
		output: [image],
		stopReason: "stop",
		timestamp: 0,
	};
	const generateImages = vi.fn<NonNullable<ImageGenerationOptions["generateImages"]>>(async () => result);
	const getOAuthToken = vi.fn(async () => "oauth-token");
	const controller = new ImageGenerationController(directory, {
		getModel: () => ({ provider: "openai-codex" }),
		getOAuthToken,
		getImageStore: () => store,
		generateImages,
		...overrides,
	});
	return { controller, store, generateImages, getOAuthToken, result };
}

describe("image generation host boundary", () => {
	it("persists the original image in existing bounded attachment storage", async () => {
		const { controller, store, generateImages } = setup();
		const result = await controller.generate("call-1", { prompt: "A fox" });
		expect(result.content).toContainEqual(image);
		expect(readFileSync(result.details.path)).toEqual(Buffer.from(image.data, "base64"));
		expect(store.readLatest()?.path).toBe(result.details.path);
		expect(generateImages).toHaveBeenCalledTimes(1);
		expect(result.details).toMatchObject({ provider: "openai-codex", model: "gpt-image-2", operation: "generate" });
	});

	it("fails unsupported provider, missing OAuth or unavailable artifact storage before paid requests", async () => {
		for (const options of [
			{ getModel: () => ({ provider: "openai" }) },
			{ getOAuthToken: async () => undefined },
			{ getImageStore: () => undefined },
		]) {
			const { controller, generateImages } = setup(options);
			await expect(controller.generate("call", { prompt: "A fox" })).rejects.toThrow(/subscription|OAuth|storage/);
			expect(generateImages).not.toHaveBeenCalled();
		}
	});

	it("reads bounded local references and selects the edit operation", async () => {
		writeFileSync(join(directory, "reference.png"), Buffer.from(image.data, "base64"));
		const { controller, generateImages } = setup();
		const result = await controller.generate("edit", {
			prompt: "Add a hat",
			referenced_image_paths: ["reference.png"],
		});
		expect(generateImages.mock.calls[0]?.[1]).toEqual({ input: [{ type: "text", text: "Add a hat" }, image] });
		expect(result.details.operation).toBe("edit");
	});

	it("selects recent images in conversation order without mutating history", async () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [image, { type: "text", text: "edit these" }, image], timestamp: 0 },
		];
		const before = JSON.stringify(messages);
		const { controller, generateImages } = setup({ getMessages: () => messages });
		await controller.generate("edit", { prompt: "Add hats", num_last_images_to_include: 2 });
		expect(generateImages.mock.calls[0]?.[1]).toEqual({ input: [{ type: "text", text: "Add hats" }, image, image] });
		expect(JSON.stringify(messages)).toBe(before);
	});

	it("rejects mixed references and unavailable history rather than silently generating", async () => {
		const { controller, generateImages } = setup();
		await expect(
			controller.generate("edit", {
				prompt: "Hat",
				referenced_image_paths: ["a.png"],
				num_last_images_to_include: 1,
			}),
		).rejects.toThrow(/only one/);
		await expect(controller.generate("edit", { prompt: "Hat", num_last_images_to_include: 1 })).rejects.toThrow(
			/available/,
		);
		expect(generateImages).not.toHaveBeenCalled();
	});

	it("canceling during OAuth never submits a late request or persists output", async () => {
		let resolve!: (value: string) => void;
		const { controller, generateImages, store } = setup({
			getOAuthToken: () =>
				new Promise<string>((done) => {
					resolve = done;
				}),
		});
		const abort = new AbortController();
		const pending = controller.generate("call", { prompt: "A fox" }, abort.signal);
		abort.abort();
		resolve("late-token");
		await expect(pending).rejects.toThrow(/abort|cancel/i);
		expect(generateImages).not.toHaveBeenCalled();
		expect(store.readLatest()).toBeUndefined();
	});

	it("backend failure cannot be reported as an empty successful image", async () => {
		const { controller, result, store } = setup();
		result.stopReason = "error";
		result.errorMessage = "HTTP 403: unavailable entitlement";
		await expect(controller.generate("call", { prompt: "A fox" })).rejects.toThrow(/403/);
		expect(store.readLatest()).toBeUndefined();
	});

	it("keeps large originals out of provider context without losing the saved artifact", async () => {
		const { controller, result } = setup();
		const bytes = Buffer.alloc(4 * 1024 * 1024);
		Buffer.from(image.data, "base64").copy(bytes);
		result.output = [{ ...image, data: bytes.toString("base64") }];
		const generated = await controller.generate("large", { prompt: "A landscape" });
		expect(generated.details.inline).toBe(false);
		expect(generated.content.every((item) => item.type === "text")).toBe(true);
		expect(readFileSync(generated.details.path)).toEqual(bytes);
	});

	it("storage failure after completed generation cannot trigger another paid request", async () => {
		const retainContent = vi.fn(() => {
			throw new Error("disk full");
		});
		const { controller, generateImages } = setup({ getImageStore: () => ({ retainContent }) });
		await expect(controller.generate("failed-save", { prompt: "A fox" })).rejects.toThrow(
			/completed.*storage failed/,
		);
		expect(generateImages).toHaveBeenCalledTimes(1);
		expect(retainContent).toHaveBeenCalledTimes(1);
	});

	it("bounds OAuth resolution and rejects a provider switch before submission", async () => {
		vi.useFakeTimers();
		let finish!: (token: string) => void;
		let provider = "openai-codex";
		const { controller, generateImages } = setup({
			getModel: () => ({ provider }),
			getOAuthToken: () =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		});
		const pending = controller.generate("stalled", { prompt: "A fox" });
		const rejected = expect(pending).rejects.toThrow(/timed out/);
		await vi.advanceTimersByTimeAsync(30_000);
		await rejected;
		finish("late-token");
		const switched = controller.generate("switched", { prompt: "A fox" });
		provider = "anthropic";
		finish("token");
		await expect(switched).rejects.toThrow(/openai-codex/);
		expect(generateImages).not.toHaveBeenCalled();
	});

	it("rejects malformed local content and over-bound references before network", async () => {
		const { controller, generateImages } = setup();
		writeFileSync(join(directory, "not-image.png"), "do not upload me");
		writeFileSync(join(directory, "huge.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
		await expect(
			controller.generate("bad", { prompt: "Edit", referenced_image_paths: ["not-image.png"] }),
		).rejects.toThrow(/not a supported/);
		await expect(
			controller.generate("huge", { prompt: "Edit", referenced_image_paths: ["huge.png"] }),
		).rejects.toThrow(/byte limit/);
		expect(generateImages).not.toHaveBeenCalled();
	});
});
