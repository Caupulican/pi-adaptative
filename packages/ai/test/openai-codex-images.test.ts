import { afterEach, describe, expect, it, vi } from "vitest";
import {
	generateImagesOpenAICodex,
	MAX_CODEX_IMAGE_RESPONSE_BYTES,
	OPENAI_CODEX_IMAGE_MODEL,
} from "../src/providers/images/openai-codex.ts";

const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`;
const input = { input: [{ type: "text" as const, text: "A quiet forest" }] };
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDogAAAAASUVORK5CYII=";
const response = () =>
	Response.json({ data: [{ b64_json: image }], usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 } });
afterEach(() => vi.useRealTimers());

describe("ChatGPT subscription images", () => {
	it("uses the native Codex JSON contract and records subscription token usage", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		const result = await generateImagesOpenAICodex(OPENAI_CODEX_IMAGE_MODEL, input, {
			accessToken: token,
			turnId: "turn-1",
			fetch,
		});
		expect(result.stopReason).toBe("stop");
		expect(result.output).toEqual([{ type: "image", mimeType: "image/png", data: image }]);
		expect(result.usage).toMatchObject({ input: 7, output: 11, totalTokens: 18, cost: { total: 0 } });
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
		expect(JSON.parse(String(init?.body))).toEqual({
			prompt: "A quiet forest",
			model: "gpt-image-2",
			background: "auto",
			quality: "auto",
			size: "auto",
		});
		expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
		expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("account");
		expect(new Headers(init?.headers).get("x-codex-image-turn-id")).toBe("turn-1");
		expect(init?.redirect).toBe("error");
	});

	it("sends references to the edit endpoint, never an unrelated Responses model request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
		await generateImagesOpenAICodex(
			OPENAI_CODEX_IMAGE_MODEL,
			{ input: [...input.input, { type: "image", data: image, mimeType: "image/png" }] },
			{ accessToken: token, fetch },
		);
		expect(fetch.mock.calls[0]?.[0]).toMatch(/images\/edits$/);
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).images).toEqual([
			{ image_url: `data:image/png;base64,${image}` },
		]);
	});

	it("refuses missing OAuth, wrong provider and untrusted endpoint before network", async () => {
		const fetch = vi.fn(async () => response());
		for (const [model, options] of [
			[OPENAI_CODEX_IMAGE_MODEL, { apiKey: token }],
			[{ ...OPENAI_CODEX_IMAGE_MODEL, provider: "openai" }, { accessToken: token }],
			[{ ...OPENAI_CODEX_IMAGE_MODEL, baseUrl: "https://evil.invalid" }, { accessToken: token }],
		] as const) {
			const result = await generateImagesOpenAICodex(model, input, { ...options, fetch });
			expect(result.stopReason).toBe("error");
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([401, 403, 404, 429, 500])(
		"discloses backend %i without echoing secrets or retrying paid work",
		async (status) => {
			const fetch = vi.fn(async () =>
				Response.json({ error: { message: token, code: token, resets_at: 12345 } }, { status }),
			);
			const result = await generateImagesOpenAICodex(OPENAI_CODEX_IMAGE_MODEL, input, {
				accessToken: token,
				fetch,
				maxRetries: 10,
			});
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(String(status));
			expect(JSON.stringify(result)).not.toContain(token);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it("cancels a stalled response body and releases its reader", async () => {
		const cancel = vi.fn();
		const controller = new AbortController();
		let reading!: () => void;
		const started = new Promise<void>((resolve) => {
			reading = resolve;
		});
		const body = new ReadableStream<Uint8Array>({
			pull() {
				reading();
			},
			cancel,
		});
		const pending = generateImagesOpenAICodex(OPENAI_CODEX_IMAGE_MODEL, input, {
			accessToken: token,
			signal: controller.signal,
			fetch: async () => new Response(body),
		});
		await started;
		controller.abort();
		expect((await pending).stopReason).toBe("aborted");
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(body.locked).toBe(false);
	});

	it("rejects declared and streamed overflow before parsing", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(MAX_CODEX_IMAGE_RESPONSE_BYTES + 1));
			},
			cancel,
		});
		const result = await generateImagesOpenAICodex(OPENAI_CODEX_IMAGE_MODEL, input, {
			accessToken: token,
			fetch: async () => new Response(body),
		});
		expect(result.errorMessage).toMatch(/limit|large/);
		expect(cancel).toHaveBeenCalled();
	});

	it("never reflects malformed OAuth header material", async () => {
		const invalid = `${token}\nprivate-access-material`;
		const result = await generateImagesOpenAICodex(OPENAI_CODEX_IMAGE_MODEL, input, {
			accessToken: invalid,
			fetch: async () => response(),
		});
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result)).not.toContain("private-access-material");
	});

	it("does not reflect a response-reader transport error", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error(token));
			},
		});
		const result = await generateImagesOpenAICodex(OPENAI_CODEX_IMAGE_MODEL, input, {
			accessToken: token,
			fetch: async () => new Response(body),
		});
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result)).not.toContain(token);
		expect(result.errorMessage).toMatch(/interrupted|transport/);
	});

	it("bounds timeout over stalled bodies and refuses already-canceled calls", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel })));
		const pending = generateImagesOpenAICodex(OPENAI_CODEX_IMAGE_MODEL, input, {
			accessToken: token,
			timeoutMs: 20,
			fetch,
		});
		await vi.advanceTimersByTimeAsync(20);
		expect((await pending).errorMessage).toMatch(/timed out/);
		expect(cancel).toHaveBeenCalled();
		const canceled = await generateImagesOpenAICodex(OPENAI_CODEX_IMAGE_MODEL, input, {
			accessToken: token,
			signal: AbortSignal.abort(),
			fetch,
		});
		expect(canceled.stopReason).toBe("aborted");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ data: [] },
		{ data: [{ b64_json: "not base64!" }] },
		{ data: [{ b64_json: image }, { b64_json: image }] },
	])("rejects malformed or unexpected multiple results", async (json) => {
		const result = await generateImagesOpenAICodex(OPENAI_CODEX_IMAGE_MODEL, input, {
			accessToken: token,
			fetch: async () => Response.json(json),
		});
		expect(result.stopReason).toBe("error");
		expect(result.output).toEqual([]);
	});
});
