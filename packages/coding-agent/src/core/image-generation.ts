import type { AgentMessage, AgentToolResult } from "@caupulican/pi-agent-core";
import {
	type Api,
	generateImages,
	type ImageContent,
	MAX_CODEX_EDIT_IMAGES,
	MAX_CODEX_IMAGE_BYTES,
	MAX_CODEX_IMAGE_PROMPT_BYTES,
	MAX_CODEX_REFERENCE_IMAGE_BYTES,
	type Model,
	OPENAI_CODEX_IMAGE_MODEL,
	validateCodexImageContent,
} from "@caupulican/pi-ai";
import { detectSupportedImageMimeType } from "../utils/mime.ts";
import type { SessionImageStore } from "./session-image-store.ts";
import { resolveToCwd } from "./tools/path-utils.ts";
import { readFilePrefixSync } from "./util/bounded-file.ts";

const MAX_INLINE_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;
const AUTH_RESOLUTION_TIMEOUT_MS = 30_000;

export interface ImageGenerationInput {
	prompt: string;
	referenced_image_paths?: string[];
	num_last_images_to_include?: number;
}

export interface ImageGenerationDetails {
	provider: "openai-codex";
	model: string;
	operation: "generate" | "edit";
	path: string;
	sequence: number;
	bytes: number;
	inline: boolean;
}

export interface ImageGenerationOptions {
	getModel(): Pick<Model<Api>, "provider"> | undefined;
	getOAuthToken(): Promise<string | undefined>;
	getImageStore(): Pick<SessionImageStore, "retainContent"> | undefined;
	getMessages?(): readonly AgentMessage[];
	generateImages?: typeof generateImages;
}

/** Owns model/auth admission, reference selection and durable output. Transport stays in the Images registry. */
export class ImageGenerationController {
	private readonly cwd: string;
	private readonly options: ImageGenerationOptions;

	constructor(cwd: string, options: ImageGenerationOptions) {
		this.cwd = cwd;
		this.options = options;
	}

	async generate(
		callId: string,
		input: ImageGenerationInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ImageGenerationDetails>> {
		signal?.throwIfAborted();
		this.requireSubscriptionProvider();
		if (
			typeof input.prompt !== "string" ||
			!input.prompt.trim() ||
			input.prompt.length > MAX_CODEX_IMAGE_PROMPT_BYTES ||
			Buffer.byteLength(input.prompt, "utf8") > MAX_CODEX_IMAGE_PROMPT_BYTES
		) {
			throw new Error("Image generation requires a non-empty prompt of at most 32 KiB.");
		}
		const store = this.options.getImageStore();
		if (!store) throw new Error("Durable image storage is unavailable; no image-generation request was submitted.");
		const images = this.references(input);
		const token = await this.resolveToken(signal);
		signal?.throwIfAborted();
		this.requireSubscriptionProvider();
		if (!token)
			throw new Error(
				"ChatGPT OAuth login is required for image generation; use /login openai-codex. API keys are not used.",
			);
		const result = await (this.options.generateImages ?? generateImages)(
			OPENAI_CODEX_IMAGE_MODEL,
			{
				input: [{ type: "text", text: input.prompt }, ...images],
			},
			{ accessToken: token, turnId: callId, signal },
		);
		signal?.throwIfAborted();
		if (result.stopReason !== "stop")
			throw new Error(result.errorMessage ?? "Image generation failed without a completed result.");
		if (result.output.length !== 1 || result.output[0]?.type !== "image")
			throw new Error("Image generation returned no single completed image.");
		const image = result.output[0];
		validateCodexImageContent(image, MAX_CODEX_IMAGE_BYTES);
		if (detectSupportedImageMimeType(Buffer.from(image.data, "base64")) !== image.mimeType)
			throw new Error("Generated image bytes do not match their supported image format.");
		// Retention failure is terminal, not a signal to submit another generation request.
		let stored: ReturnType<SessionImageStore["retainContent"]>;
		try {
			stored = store.retainContent(image);
		} catch {
			throw new Error(
				"Image generation completed, but durable artifact storage failed. Subscription usage may have been consumed; do not automatically regenerate.",
			);
		}
		const inline = image.data.length <= MAX_INLINE_IMAGE_BASE64_BYTES;
		return {
			content: [
				{
					type: "text",
					text: `Generated image saved as image #${stored.sequence} at ${JSON.stringify(stored.path)}. Original: ${stored.bytes.byteLength} bytes.${inline ? "" : " Image exceeds the inline display bound; use read on the saved path for a bounded preview."} Uses ChatGPT subscription limits; no API-key billing fallback.`,
				},
				...(inline ? [image] : []),
			],
			usage: result.usage,
			details: {
				provider: "openai-codex",
				model: OPENAI_CODEX_IMAGE_MODEL.id,
				operation: images.length ? "edit" : "generate",
				path: stored.path,
				sequence: stored.sequence,
				bytes: stored.bytes.byteLength,
				inline,
			},
		};
	}

	private requireSubscriptionProvider(): void {
		if (this.options.getModel()?.provider !== "openai-codex")
			throw new Error("Image generation is available only with an active openai-codex ChatGPT subscription model.");
	}

	private async resolveToken(signal?: AbortSignal): Promise<string | undefined> {
		let onAbort: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await new Promise<string | undefined>((resolve, reject) => {
				onAbort = () => reject(new Error("Image generation canceled while resolving ChatGPT OAuth."));
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) {
					onAbort();
					return;
				}
				timer = setTimeout(
					() => reject(new Error("ChatGPT OAuth resolution timed out; no image request was submitted.")),
					AUTH_RESOLUTION_TIMEOUT_MS,
				);
				this.options
					.getOAuthToken()
					.then(resolve, () =>
						reject(new Error("ChatGPT OAuth resolution failed; no image request was submitted.")),
					);
			});
		} finally {
			if (timer) clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}

	private references(input: ImageGenerationInput): ImageContent[] {
		if (input.referenced_image_paths !== undefined && input.num_last_images_to_include !== undefined)
			throw new Error("Provide only one reference mode: referenced_image_paths or num_last_images_to_include.");
		if (input.referenced_image_paths !== undefined) {
			const paths = input.referenced_image_paths;
			if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_CODEX_EDIT_IMAGES)
				throw new Error("Provide between 1 and 5 reference image paths.");
			return paths.map((path) => {
				if (typeof path !== "string" || !path.trim() || path.length > 4096 || path.includes("\0"))
					throw new Error("Invalid reference image path.");
				const file = readFilePrefixSync(
					resolveToCwd(path, this.cwd),
					MAX_CODEX_REFERENCE_IMAGE_BYTES,
					"Reference image",
				);
				if (file.truncated) throw new Error("Reference image exceeds its 10 MiB byte limit.");
				const mimeType = detectSupportedImageMimeType(file.content);
				if (!mimeType) throw new Error("Reference is not a supported PNG, JPEG, WEBP or GIF image.");
				return { type: "image", mimeType, data: file.content.toString("base64") };
			});
		}
		const count = input.num_last_images_to_include;
		if (count === undefined) return [];
		if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CODEX_EDIT_IMAGES)
			throw new Error("Recent reference count must be between 1 and 5.");
		const messages = this.options.getMessages?.() ?? [];
		const images: ImageContent[] = [];
		for (let index = messages.length - 1; index >= 0 && images.length < count; index--) {
			const message = messages[index]!;
			if (!("content" in message) || !Array.isArray(message.content)) continue;
			for (let part = message.content.length - 1; part >= 0 && images.length < count; part--) {
				const block = message.content[part]!;
				if (block.type !== "image") continue;
				validateCodexImageContent(block, MAX_CODEX_REFERENCE_IMAGE_BYTES);
				images.push(block);
			}
		}
		if (images.length !== count)
			throw new Error(
				`Requested ${count} recent images, but only ${images.length} were available; attach the missing references.`,
			);
		return images.reverse();
	}
}
