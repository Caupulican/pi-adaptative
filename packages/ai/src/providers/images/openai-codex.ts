import type { AssistantImages, ImageContent, ImagesFunction, ImagesModel, ImagesOptions, Usage } from "../../types.ts";
import { combineAbortSignals } from "../../utils/abort-signals.ts";
import { buildOpenAICodexHeaders, DEFAULT_OPENAI_CODEX_BASE_URL } from "../openai-codex-auth.ts";

export const MAX_CODEX_EDIT_IMAGES = 5;
export const MAX_CODEX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CODEX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_CODEX_IMAGE_RESPONSE_BYTES = Math.ceil(MAX_CODEX_IMAGE_BYTES / 3) * 4 + 64 * 1024;
export const MAX_CODEX_IMAGE_PROMPT_BYTES = 32 * 1024;
export const MAX_CODEX_IMAGE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

/** Fixed subscription endpoint. Model base URLs and custom headers cannot redirect OAuth credentials. */
export const OPENAI_CODEX_IMAGE_MODEL: ImagesModel<"openai-codex-images"> = Object.freeze({
	id: "gpt-image-2",
	name: "GPT Image 2 (ChatGPT subscription)",
	api: "openai-codex-images",
	provider: "openai-codex",
	baseUrl: DEFAULT_OPENAI_CODEX_BASE_URL,
	input: ["text", "image"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies ImagesModel<"openai-codex-images">);

export interface OpenAICodexImagesOptions extends ImagesOptions {
	/** Refreshed stored ChatGPT OAuth access token. apiKey is deliberately not accepted as a fallback. */
	accessToken?: string;
	turnId?: string;
	/** Trusted transport injection for deterministic tests; never model-controlled. */
	fetch?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Validate before decoding so oversized or malformed input cannot trigger an unbounded allocation. */
export function validateCodexImageContent(image: ImageContent, maxBytes: number): void {
	if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) {
		throw new Error("Unsupported image type; use PNG, JPEG, WEBP or GIF.");
	}
	const data = image.data;
	if (typeof data !== "string" || data.length === 0 || data.length > Math.ceil(maxBytes / 3) * 4) {
		throw new Error("Image exceeded its byte limit or is empty.");
	}
	if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
		throw new Error("Image must contain canonical base64 data.");
	}
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(
		data[data.length - padding - 1]!,
	);
	if (
		(padding === 2 && (last & 15) !== 0) ||
		(padding === 1 && (last & 3) !== 0) ||
		(data.length / 4) * 3 - padding > maxBytes
	) {
		throw new Error("Image base64 padding or byte limit is invalid.");
	}
}

async function readImageResponse(response: Response, signal: AbortSignal | undefined): Promise<unknown> {
	if (!response.body) throw new Error("Image backend returned no response body.");
	const limit = response.ok ? MAX_CODEX_IMAGE_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES;
	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		signal?.throwIfAborted();
		const declared = response.headers.get("content-length");
		if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
			throw new Error("Image backend response exceeded its byte limit.");
		}
		// Geometric capacity growth bounds tiny-chunk bookkeeping and avoids quadratic concatenation.
		let bytes = new Uint8Array(Math.min(64 * 1024, limit));
		let length = 0;
		while (true) {
			const chunk = await reader.read().catch(() => {
				throw new Error(
					"Image response transport was interrupted; backend completion is unknown. Not automatically retried.",
				);
			});
			signal?.throwIfAborted();
			if (chunk.done) break;
			const next = length + chunk.value.byteLength;
			if (next > limit) throw new Error("Image backend response exceeded its byte limit.");
			if (next > bytes.byteLength) {
				const grown = new Uint8Array(Math.min(limit, Math.max(next, bytes.byteLength * 2)));
				grown.set(bytes.subarray(0, length));
				bytes = grown;
			}
			bytes.set(chunk.value, length);
			length = next;
		}
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
		} catch {
			throw new Error(`Image backend returned invalid JSON (HTTP ${response.status}).`);
		}
	} finally {
		signal?.removeEventListener("abort", cancel);
		// Do not await an uncooperative stream's cancellation promise.
		cancel();
		reader.releaseLock();
	}
}

function backendError(status: number, body: unknown): Error {
	const error = record(record(body)?.error);
	const code = error?.code ?? error?.type;
	const detail =
		status === 401
			? "ChatGPT authentication was rejected; sign in again."
			: status === 403 || status === 404 || code === "usage_not_included"
				? "Image generation is unavailable for this ChatGPT account or backend entitlement."
				: status === 429
					? "ChatGPT image-generation usage or rate limit was reached."
					: "ChatGPT image-generation backend failed. The request was not automatically retried.";
	const resets = error?.resets_at;
	const resetNotice =
		status === 429 && typeof resets === "number" && Number.isSafeInteger(resets) && resets > 0
			? ` Reset epoch seconds: ${resets}.`
			: "";
	// Never echo a backend body: it can contain tokens, prompts or arbitrary HTML.
	return new Error(`${detail} (HTTP ${status}).${resetNotice}`);
}

function subscriptionUsage(value: unknown): Usage | undefined {
	const usage = record(value);
	if (!usage) return undefined;
	const input = usage.input_tokens;
	const output = usage.output_tokens;
	if (
		typeof input !== "number" ||
		typeof output !== "number" ||
		!Number.isSafeInteger(input) ||
		!Number.isSafeInteger(output) ||
		input < 0 ||
		output < 0 ||
		!Number.isSafeInteger(input + output)
	) {
		throw new Error("Image backend returned invalid token usage.");
	}
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** One paid request per call. Transport ambiguity is surfaced, never automatically replayed. */
export const generateImagesOpenAICodex: ImagesFunction<"openai-codex-images", OpenAICodexImagesOptions> = async (
	model,
	context,
	options,
) => {
	const result: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const deadline = new AbortController();
	const combined = combineAbortSignals([options?.signal, deadline.signal]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		combined.signal?.throwIfAborted();
		if (
			model.provider !== "openai-codex" ||
			model.api !== "openai-codex-images" ||
			model.id !== OPENAI_CODEX_IMAGE_MODEL.id ||
			model.baseUrl !== OPENAI_CODEX_IMAGE_MODEL.baseUrl
		) {
			throw new Error("Image generation requires the built-in ChatGPT subscription image provider.");
		}
		if (!options?.accessToken)
			throw new Error("ChatGPT OAuth login is required for image generation; API keys are not used.");
		const timeout = options.timeoutMs ?? 5 * 60 * 1000;
		if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_CODEX_IMAGE_TIMEOUT_MS)
			throw new Error("Invalid image-generation timeout.");
		timer = setTimeout(() => deadline.abort(), timeout);
		if (!Array.isArray(context.input) || context.input.length > MAX_CODEX_EDIT_IMAGES + 1)
			throw new Error("Too many image-generation input blocks.");
		const text = context.input.filter((item) => item.type === "text");
		if (
			text.length !== 1 ||
			typeof text[0]?.text !== "string" ||
			text[0].text.length > MAX_CODEX_IMAGE_PROMPT_BYTES ||
			!text[0].text.trim() ||
			new TextEncoder().encode(text[0].text).byteLength > MAX_CODEX_IMAGE_PROMPT_BYTES
		) {
			throw new Error("Image generation requires one non-empty prompt of at most 32 KiB.");
		}
		const references = context.input.filter((item): item is ImageContent => item.type === "image");
		if (references.length + text.length !== context.input.length || references.length > MAX_CODEX_EDIT_IMAGES)
			throw new Error("Invalid image-generation input.");
		for (const image of references) validateCodexImageContent(image, MAX_CODEX_REFERENCE_IMAGE_BYTES);
		const headers = buildOpenAICodexHeaders({ token: options.accessToken, userAgent: "pi" });
		headers.set("content-type", "application/json");
		headers.set("accept", "application/json");
		if (options.turnId) {
			if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(options.turnId)) throw new Error("Invalid image-generation turn id.");
			headers.set("x-codex-image-turn-id", options.turnId);
		}
		const body = {
			prompt: text[0].text,
			model: model.id,
			background: "auto",
			quality: "auto",
			size: "auto",
			...(references.length
				? { images: references.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })) }
				: {}),
		};
		let response: Response;
		try {
			response = await (options.fetch ?? globalThis.fetch)(
				`${DEFAULT_OPENAI_CODEX_BASE_URL}/codex/images/${references.length ? "edits" : "generations"}`,
				{ method: "POST", headers, body: JSON.stringify(body), signal: combined.signal, redirect: "error" },
			);
		} catch {
			throw new Error(
				"Image-generation transport failed; backend completion is unknown. Not automatically retried.",
			);
		}
		const json = await readImageResponse(response, combined.signal);
		if (!response.ok) throw backendError(response.status, json);
		const parsed = record(json);
		const data = parsed?.data;
		if (!Array.isArray(data) || data.length !== 1)
			throw new Error("Image backend must return exactly one generated image.");
		const encoded = record(data[0])?.b64_json;
		if (typeof encoded !== "string") throw new Error("Image backend returned invalid image data.");
		const image: ImageContent = { type: "image", mimeType: "image/png", data: encoded };
		validateCodexImageContent(image, MAX_CODEX_IMAGE_BYTES);
		result.usage = subscriptionUsage(parsed?.usage);
		result.output = [image];
	} catch (error) {
		result.stopReason = options?.signal?.aborted ? "aborted" : "error";
		result.errorMessage = options?.signal?.aborted
			? "Image generation canceled; any submitted backend work may still consume subscription usage."
			: deadline.signal.aborted
				? "Image generation timed out; backend completion is unknown. Not automatically retried."
				: error instanceof Error
					? error.message.slice(0, 1000)
					: "Image generation failed.";
	} finally {
		if (timer) clearTimeout(timer);
		combined.cleanup();
	}
	return result;
};
