import { isLoopbackModelEndpoint } from "./model-endpoint.ts";

/** Native Ollama media endpoints. Audio is deliberately kept out of Pi's image message type. */
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_ITEMS = 16;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_SPEECH_CHARS = 4096;
const DEFAULT_TIMEOUT_MS = 120_000;

async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
	const reader = response.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	let buffer = Buffer.alloc(Math.min(limit, 64 * 1024));
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) return buffer.subarray(0, size);
			const next = size + part.value.byteLength;
			if (next > limit) throw new Error(`Response exceeds ${limit} bytes`);
			if (next > buffer.length) {
				const grown = Buffer.alloc(Math.min(limit, Math.max(next, buffer.length * 2)));
				buffer.copy(grown, 0, 0, size);
				buffer = grown;
			}
			buffer.set(part.value, size);
			size = next;
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export class Lfm3MediaClient {
	private readonly baseUrl: string;
	private readonly transport: typeof fetch;

	constructor(args: { baseUrl: string; fetch?: typeof fetch }) {
		const url = new URL(args.baseUrl);
		if (
			!isLoopbackModelEndpoint(args.baseUrl) ||
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new Error(
				"Ollama media endpoint must be a loopback HTTP(S) URL without credentials, query, or fragment",
			);
		this.baseUrl = args.baseUrl.replace(/\/$/, "");
		this.transport = args.fetch ?? fetch;
	}

	private async request(path: string, init: RequestInit): Promise<Response> {
		const response = await this.transport(`${this.baseUrl}${path}`, {
			...init,
			redirect: "error",
			signal: init.signal
				? AbortSignal.any([init.signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
				: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
		});
		if (!response.ok) {
			let details: string;
			try {
				details = (await readBoundedResponse(response, MAX_TEXT_BYTES)).toString("utf8").slice(0, 2048);
			} catch (error) {
				throw new Error(`Ollama ${path} HTTP ${response.status}: unable to read bounded error response`, {
					cause: error,
				});
			}
			throw new Error(`Ollama ${path} HTTP ${response.status}: ${details}`);
		}
		return response;
	}

	async chat(args: {
		model: string;
		prompt: string;
		images?: readonly Uint8Array[];
		audio?: Uint8Array;
		signal?: AbortSignal;
	}): Promise<string> {
		if ((args.images?.length ?? 0) + (args.audio ? 1 : 0) > MAX_MEDIA_ITEMS)
			throw new Error("Media must contain at most 16 items");
		const media = [...(args.images ?? []), ...(args.audio ? [args.audio] : [])];
		if (
			media.length > MAX_MEDIA_ITEMS ||
			media.some((item) => item.byteLength === 0) ||
			media.reduce((sum, item) => sum + item.byteLength, 0) > MAX_MEDIA_BYTES
		)
			throw new Error("Media must contain at most 16 nonempty items totaling at most 32 MiB");
		const response = await this.request("/api/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: args.signal,
			body: JSON.stringify({
				model: args.model,
				stream: false,
				think: false,
				options: { temperature: 0.1, top_k: 50, repeat_penalty: 1.1, num_predict: 256 },
				messages: [
					{
						role: "user",
						content: args.prompt,
						...(media.length ? { images: media.map((item) => Buffer.from(item).toString("base64")) } : {}),
					},
				],
			}),
		});
		const result: unknown = JSON.parse((await readBoundedResponse(response, MAX_TEXT_BYTES)).toString("utf8"));
		if (
			!result ||
			typeof result !== "object" ||
			!("done" in result) ||
			result.done !== true ||
			("done_reason" in result && result.done_reason !== "stop") ||
			!("message" in result) ||
			!result.message ||
			typeof result.message !== "object" ||
			!("content" in result.message) ||
			typeof result.message.content !== "string"
		)
			throw new Error("Ollama chat did not return a completed text response");
		return result.message.content;
	}

	async speak(args: { model: string; input: string; voice?: string; signal?: AbortSignal }): Promise<Uint8Array> {
		if (!args.input.trim() || Array.from(args.input).length > MAX_SPEECH_CHARS)
			throw new Error("Speech input must contain 1–4096 characters");
		const response = await this.request("/v1/audio/speech", {
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: args.signal,
			body: JSON.stringify({ model: args.model, input: args.input, voice: args.voice, response_format: "wav" }),
		});
		const bytes = await readBoundedResponse(response, MAX_MEDIA_BYTES);
		if (
			bytes.length <= 44 ||
			bytes.length > MAX_MEDIA_BYTES ||
			Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "RIFF" ||
			Buffer.from(bytes.subarray(8, 12)).toString("ascii") !== "WAVE"
		)
			throw new Error("Speech response is empty, oversized, or invalid WAV");
		return bytes;
	}

	async transcribe(args: {
		model: string;
		audio: Uint8Array;
		filename?: string;
		signal?: AbortSignal;
	}): Promise<string> {
		if (!args.audio.length || args.audio.length > MAX_MEDIA_BYTES)
			throw new Error("Audio must be nonempty and at most 32 MiB");
		const form = new FormData();
		form.set("model", args.model);
		form.set("file", new Blob([new Uint8Array(args.audio)]), args.filename ?? "audio.wav");
		form.set("response_format", "json");
		const response = await this.request("/v1/audio/transcriptions", {
			method: "POST",
			body: form,
			signal: args.signal,
		});
		const result: unknown = JSON.parse((await readBoundedResponse(response, MAX_TEXT_BYTES)).toString("utf8"));
		if (
			!result ||
			typeof result !== "object" ||
			!("text" in result) ||
			typeof result.text !== "string" ||
			!result.text.trim()
		)
			throw new Error("Transcription did not return completed text");
		return result.text;
	}
}
