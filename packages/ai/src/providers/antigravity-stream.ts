import { abortableSleep } from "../utils/abort-signals.ts";
import { ANTIGRAVITY_ENDPOINT, antigravityObject } from "../utils/antigravity.ts";
import {
	getProviderRetryDirective,
	isRetryableProviderError,
	type ProviderRetryOptions,
	validateServerRetryDelayMs,
} from "../utils/provider-retry.ts";
import { StreamingLineDecoder } from "../utils/streaming-lines.ts";
import { isRecord } from "../utils/value-guards.ts";
import { readBoundedResponseText } from "./account-request.ts";
import { AntigravityContinuationState, type AntigravityStreamEvent } from "./antigravity-continuation.ts";
import { parseAntigravityCredits } from "./antigravity-credits.ts";
import type { GoogleGenAiResponse } from "./google-streaming.ts";

interface AntigravityRequestBody extends Record<string, unknown> {
	request: Record<string, unknown> & { generationConfig: Record<string, unknown> & { maxOutputTokens?: number } };
}

const NATIVE_MAX_RETRY_DELAY_MS = 60_000;

class AntigravityStreamFailure extends Error {
	readonly status: number | undefined;
	readonly headers: Headers | undefined;
	readonly error: unknown;
	readonly transport: boolean;

	constructor(
		message: string,
		status: number | undefined,
		headers: Headers | undefined,
		error: unknown,
		transport = false,
	) {
		super(message, transport ? { cause: error } : undefined);
		this.status = status;
		this.headers = headers;
		this.error = transport ? undefined : error;
		this.transport = transport;
	}
}

/** Eager first HTTP admission, followed by bounded CCPA checkpoint legs. */
export class AntigravityStreamAdapter {
	private readonly template: AntigravityRequestBody;
	private readonly firstBody: string;
	private readonly headers: Headers;
	private readonly signal: AbortSignal | undefined;
	private readonly maxRetryDelayMs: number;
	private readonly continuation: AntigravityContinuationState;

	constructor(
		body: AntigravityRequestBody,
		headers: Headers,
		options: Pick<ProviderRetryOptions, "signal" | "maxRetries" | "maxRetryDelayMs"> = {},
	) {
		this.firstBody = JSON.stringify(body);
		// Retain exactly the JSON submitted, independent of later caller/payload-hook mutation.
		this.template = JSON.parse(this.firstBody) as AntigravityRequestBody;
		this.headers = new Headers(headers);
		this.signal = options.signal;
		const requestedDelay = options.maxRetryDelayMs ?? NATIVE_MAX_RETRY_DELAY_MS;
		if (!Number.isFinite(requestedDelay)) throw new Error("Invalid Antigravity retry delay limit");
		this.maxRetryDelayMs =
			requestedDelay > 0 ? Math.min(requestedDelay, NATIVE_MAX_RETRY_DELAY_MS) : NATIVE_MAX_RETRY_DELAY_MS;
		this.continuation = new AntigravityContinuationState(
			this.template.request.generationConfig.maxOutputTokens,
			options.maxRetries,
		);
	}

	async open(): Promise<AsyncIterable<GoogleGenAiResponse>> {
		// Keep initial 401 failures inside executeWithAuthRecovery's promise boundary.
		const response = await this.openLeg(this.firstBody);
		return this.readGeneration(response);
	}

	private async openLeg(body: string): Promise<Response> {
		this.signal?.throwIfAborted();
		let response: Response;
		try {
			response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
				method: "POST",
				redirect: "error",
				signal: this.signal,
				headers: this.headers,
				body,
			});
		} catch (error) {
			this.signal?.throwIfAborted();
			throw new AntigravityStreamFailure(
				"Antigravity inference transport failed",
				undefined,
				undefined,
				error,
				true,
			);
		}
		if (!response.ok) {
			const raw = ((await readBoundedResponseText(response, 64 * 1024).catch(() => "")) ?? "").trim();
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				parsed = undefined;
			}
			throw responseFailure(response.status, response.headers, isRecord(parsed) ? parsed.error : undefined, raw);
		}
		if (!response.body) throw new Error("Antigravity returned no stream");
		return response;
	}

	private async *readGeneration(firstResponse: Response): AsyncGenerator<GoogleGenAiResponse> {
		let response = firstResponse;
		for (;;) {
			let decision: ReturnType<AntigravityContinuationState["finishLeg"]>;
			try {
				for await (const event of readAntigravityEvents(response, this.signal)) {
					yield this.continuation.record(event);
				}
				decision = this.continuation.finishLeg();
			} catch (error) {
				const terminal = await this.recover(error, false);
				if (terminal) {
					yield terminal;
					return;
				}
				decision = "continue";
			}
			if (decision === "complete") return;
			if (decision !== "continue") {
				yield decision;
				return;
			}
			for (;;) {
				try {
					response = await this.openLeg(
						JSON.stringify({
							...this.template,
							requestId: crypto.randomUUID(),
							request: { ...this.template.request, continuationToken: this.continuation.continuationToken },
						}),
					);
					break;
				} catch (error) {
					const terminal = await this.recover(error, true);
					if (terminal) {
						yield terminal;
						return;
					}
				}
			}
		}
	}

	private async recover(error: unknown, dialFailure: boolean): Promise<GoogleGenAiResponse | undefined> {
		this.signal?.throwIfAborted();
		if (!(error instanceof AntigravityStreamFailure)) throw error;
		const detail = isRecord(error.error) ? error.error : undefined;
		const message = typeof detail?.message === "string" ? detail.message.toLowerCase() : "";
		const status = detail?.status;
		if (
			error.status === 400 &&
			(detail?.code === undefined || detail.code === 400) &&
			(status === "INVALID_ARGUMENT" || status === "OUT_OF_RANGE") &&
			((message.includes("max_output_tokens") && message.includes("has already been exhausted")) ||
				message.includes("the input token count exceeds the maximum number of tokens allowed") ||
				message.includes("more than the max tokens limit allowed"))
		) {
			const terminal = this.continuation.finishBudgetError();
			if (terminal) return terminal;
		}
		if (
			error.status === 429 ||
			status === "RESOURCE_EXHAUSTED" ||
			(error.cause instanceof Error && error.cause.name === "AbortError")
		)
			throw error;
		const directive = getProviderRetryDirective(error);
		// Reuse Pi's provider policy; native checkpoint and cancellation guards remain mandatory.
		if (
			(!error.transport && error.status === undefined && directive?.shouldRetry !== true) ||
			!isRetryableProviderError(error)
		)
			throw error;
		let serverDelay = directive?.retryAfterMs ?? 0;
		if (Array.isArray(detail?.details)) {
			if (detail.details.length > 200) throw error;
			for (const entry of detail.details) {
				if (!isRecord(entry) || entry["@type"] !== "type.googleapis.com/google.rpc.RetryInfo") continue;
				if (typeof entry.retryDelay !== "string" || !/^\d{1,9}(?:\.\d{1,9})?s$/.test(entry.retryDelay)) throw error;
				serverDelay = Math.max(serverDelay, Number(entry.retryDelay.slice(0, -1)) * 1000);
			}
		}
		validateServerRetryDelayMs(serverDelay, this.maxRetryDelayMs, error);
		if (!this.continuation.resumeAfterError(error, dialFailure)) throw error;
		const base = Math.min(100 * 2 ** Math.min(this.continuation.retryCount - 1, 6), 5000);
		await abortableSleep(Math.max(serverDelay, base * (0.5 + Math.random() / 2)), this.signal);
		return undefined;
	}
}

function responseFailure(
	status: number | undefined,
	headers: Headers,
	error: unknown,
	raw = "",
): AntigravityStreamFailure {
	const detail = isRecord(error)
		? [error.status, error.message].filter((part): part is string => typeof part === "string").join(": ")
		: raw;
	const flat = (detail || raw).replace(/\s+/g, " ").trim();
	const bounded = flat.length <= 500 ? flat : `${flat.slice(0, 499)}…`;
	return new AntigravityStreamFailure(
		`Antigravity inference failed${status !== undefined ? ` (HTTP ${status})` : ""}${bounded ? `: ${bounded}` : ""}`,
		status,
		headers,
		error,
	);
}

async function* readAntigravityEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<AntigravityStreamEvent> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const lines = new StreamingLineDecoder(2 * 1024 * 1024);
	let data: string[] = [];
	let size = 0;
	function consume(line: string): AntigravityStreamEvent | undefined {
		if (line.startsWith("data:")) {
			const value = line.slice(5).replace(/^ /, "");
			size += value.length + 1;
			if (size > 2 * 1024 * 1024) throw new Error("Antigravity event exceeds its size limit");
			data.push(value);
			return;
		}
		if (line !== "" || data.length === 0) return;
		const text = data.join("\n");
		data = [];
		size = 0;
		if (text === "[DONE]") return;
		let envelope: Record<string, unknown>;
		try {
			envelope = antigravityObject(JSON.parse(text));
		} catch {
			throw new Error("Invalid Antigravity event JSON");
		}
		if (envelope.error) {
			const code = isRecord(envelope.error) ? envelope.error.code : undefined;
			throw responseFailure(
				typeof code === "number" && Number.isInteger(code) && code >= 100 && code < 600 ? code : undefined,
				response.headers,
				envelope.error,
			);
		}
		const raw = antigravityObject(envelope.response);
		if (raw.candidates !== undefined && !Array.isArray(raw.candidates))
			throw new Error("Invalid Antigravity candidates");
		for (const value of (raw.candidates ?? []) as unknown[]) {
			const candidate = antigravityObject(value);
			if (candidate.finishReason !== undefined && typeof candidate.finishReason !== "string")
				throw new Error("Invalid Antigravity finish reason");
			if (candidate.continuationToken !== undefined && candidate.continuationToken !== null) {
				if (
					typeof candidate.continuationToken !== "string" ||
					!/^[A-Za-z0-9+/_-]*={0,2}$/.test(candidate.continuationToken)
				)
					throw new Error("Invalid Antigravity continuation token");
				try {
					candidate.continuationToken = btoa(
						atob(candidate.continuationToken.replaceAll("-", "+").replaceAll("_", "/")),
					);
				} catch {
					throw new Error("Invalid Antigravity continuation token");
				}
			}
			if (!candidate.content) continue;
			const content = antigravityObject(candidate.content);
			if (content.parts !== undefined && !Array.isArray(content.parts))
				throw new Error("Invalid Antigravity content");
			for (const value of (content.parts ?? []) as unknown[]) {
				const part = antigravityObject(value);
				if (part.text !== undefined && typeof part.text !== "string") throw new Error("Invalid Antigravity text");
				if (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== "string")
					throw new Error("Invalid Antigravity signature");
				if (part.functionCall !== undefined) {
					const call = antigravityObject(part.functionCall);
					if (
						typeof call.name !== "string" ||
						!call.name ||
						(call.id !== undefined && typeof call.id !== "string")
					)
						throw new Error("Invalid Antigravity function call");
					if (call.args !== undefined) antigravityObject(call.args);
				}
			}
		}
		return {
			candidates: raw.candidates as AntigravityStreamEvent["candidates"],
			usageMetadata: raw.usageMetadata,
			...(envelope.consumedCredits !== undefined || envelope.remainingCredits !== undefined
				? {
						usageCredits: {
							...(envelope.consumedCredits !== undefined
								? { consumedCredits: parseAntigravityCredits(envelope.consumedCredits) }
								: {}),
							...(envelope.remainingCredits !== undefined
								? { remainingCredits: parseAntigravityCredits(envelope.remainingCredits) }
								: {}),
						},
					}
				: {}),
			responseId:
				typeof envelope.traceId === "string"
					? envelope.traceId
					: typeof raw.responseId === "string"
						? raw.responseId
						: undefined,
		};
	}
	try {
		for (;;) {
			signal?.throwIfAborted();
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await reader.read();
			} catch (error) {
				signal?.throwIfAborted();
				throw new AntigravityStreamFailure(
					"Antigravity stream transport failed",
					undefined,
					undefined,
					error,
					true,
				);
			}
			if (chunk.done) break;
			for (const line of lines.push(decoder.decode(chunk.value, { stream: true }))) {
				const event = consume(line);
				if (event) yield event;
			}
		}
		for (const line of lines.push(decoder.decode())) {
			const event = consume(line);
			if (event) yield event;
		}
		const lastLine = lines.finish();
		if (lastLine !== undefined) consume(lastLine);
		const final = consume("");
		if (final) yield final;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
