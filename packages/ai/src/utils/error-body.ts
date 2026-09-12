// Shared normalization for provider HTTP error objects.
//
// Endpoints behind a proxy / gateway may return a non-2xx response whose body
// the provider SDK cannot fold into `error.message`. The SDK error object still
// carries the HTTP status and the raw/parsed body, but under SDK-specific field
// names. Provider catch blocks that read only `error.message` therefore drop
// the body and surface opaque messages like `"403 status code (no body)"` or
// collapse to `"Unknown: UnknownError"`.
//
// `normalizeProviderError` probes the known SDK field shapes (Mistral,
// `openai`, `@google/genai`, AWS Bedrock) and returns a struct each provider
// composes into its display string. The `messageCarriesBody` flag captures the
// Anthropic / `@google/genai` happy path where the SDK already folded the body
// into the message, so providers can preserve it without double-printing.

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;
/** Bounded depth for the `cause` chain behind a transport failure. */
const MAX_CAUSE_DEPTH = 4;

export interface NormalizedProviderError {
	/** HTTP status code, when one could be extracted from the SDK error object. */
	status?: number;
	/** Raw HTTP body reason, already trimmed and truncated to the cap. */
	body?: string;
	/** `error.message`, or `safeJsonStringify(error)` for a non-`Error` throw. */
	message: string;
	/** True when `message` already contains the body (no separate body to add). */
	messageCarriesBody: boolean;
	/**
	 * Delay the provider asked for before the next attempt, from `retry-after-ms` / `retry-after`
	 * response headers or a structured `availability.retry_after` body field. Surfaced in the
	 * formatted text as "retry after N seconds" so a classifier that only sees the message still
	 * learns the true reset instead of guessing one.
	 */
	retryAfterMs?: number;
	/**
	 * Transport reason behind a failure that never produced an HTTP response, read from the
	 * `cause` chain (undici's `fetch failed` → `ECONNRESET: socket hang up`, Bun's `ConnectionClosed`,
	 * DNS failures). SDKs collapse all of these into "Connection error.", which leaves a session
	 * record that cannot distinguish a dropped proxy connection from a DNS outage.
	 */
	cause?: string;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
	headers?: unknown;
};

function headerValue(headers: unknown, name: string): string | undefined {
	if (!headers) return undefined;
	if (typeof (headers as { get?: unknown }).get === "function") {
		const value = (headers as { get(name: string): string | null }).get(name);
		return value ?? undefined;
	}
	if (typeof headers === "object") {
		const entry = Object.entries(headers as Record<string, unknown>).find(([key]) => key.toLowerCase() === name);
		return typeof entry?.[1] === "string" ? entry[1] : undefined;
	}
	return undefined;
}

/** Provider-requested delay from headers or a structured body, in milliseconds; undefined when none. */
function extractRetryAfterMs(sdkError: SdkErrorShape, nowMs = Date.now()): number | undefined {
	const retryAfterMs = headerValue(sdkError.headers, "retry-after-ms");
	if (retryAfterMs !== undefined) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value) && value >= 0) return value;
	}
	const retryAfter = headerValue(sdkError.headers, "retry-after");
	if (retryAfter !== undefined) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - nowMs : seconds * 1000;
		if (Number.isFinite(delayMs) && delayMs >= 0) return delayMs;
	}
	const body = sdkError.error;
	if (body && typeof body === "object") {
		const record = body as { availability?: unknown; error?: { availability?: unknown } };
		const availability = (record.availability ?? record.error?.availability) as { retry_after?: unknown } | undefined;
		const seconds = availability?.retry_after;
		if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	}
	return undefined;
}

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);
	const cause = status === undefined ? extractCauseChain(error) : undefined;
	const retryAfterMs = extractRetryAfterMs(sdkError);

	return {
		status,
		body,
		message: error.message,
		messageCarriesBody,
		...(cause !== undefined ? { cause } : {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
	} satisfies NormalizedProviderError;
}

/**
 * Walk `error.cause` (bounded) and join each distinct step as `CODE message`, oldest cause last.
 * Returns `undefined` when there is no cause or it only repeats the top-level message.
 */
function extractCauseChain(error: Error): string | undefined {
	const steps: string[] = [];
	const seen = new Set<string>([error.message.trim()]);
	let current: unknown = (error as { cause?: unknown }).cause;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
		const step = describeCause(current);
		if (step && !seen.has(step)) {
			steps.push(step);
			seen.add(step);
		}
		current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
	}
	return steps.length > 0 ? steps.join(" → ") : undefined;
}

function describeCause(cause: unknown): string | undefined {
	if (cause instanceof Error) {
		const code = (cause as { code?: unknown }).code;
		const message = cause.message.trim();
		const text = typeof code === "string" && code && !message.includes(code) ? `${code} ${message}`.trim() : message;
		return text ? truncateErrorText(text, 200) : undefined;
	}
	if (typeof cause === "string") return cause.trim() ? truncateErrorText(cause.trim(), 200) : undefined;
	if (typeof cause === "object") {
		const code = (cause as { code?: unknown }).code;
		const message = (cause as { message?: unknown }).message;
		const parts = [typeof code === "string" ? code : "", typeof message === "string" ? message : ""].filter(Boolean);
		return parts.length ? truncateErrorText(parts.join(" "), 200) : undefined;
	}
	return undefined;
}

/**
 * Probe the HTTP status, first numeric hit wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

/**
 * Probe the raw body reason, first usable hit wins, in SDK-field order:
 * `body` string (Mistral) → `error` parsed JSON body object (`openai` SDK's
 * `this.error`) → `$response.body` (Bedrock). Empty objects and unread response
 * streams are treated as no body so they do not surface as `"{}"` or serialized
 * stream internals. The chosen body is truncated to the cap.
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

function isNonEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

/**
 * Compose a display string from a normalized error. When the message already
 * carries the body (Anthropic / `@google/genai` happy path) or no body/status
 * was extracted, the message is returned unchanged. Otherwise the status and
 * body are surfaced, with an optional provider prefix.
 *
 * - no prefix: `"<status>: <body>"`
 * - prefix:    `"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	let text: string;
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		const message =
			norm.cause && !norm.message.includes(norm.cause) ? `${norm.message} [${norm.cause}]` : norm.message;
		text = prefix !== undefined && norm.status !== undefined ? `${prefix} (${norm.status}): ${message}` : message;
	} else {
		text = prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
	}
	return appendRetryAfter(text, norm.retryAfterMs);
}

const RETRY_AFTER_PHRASE = /\b(?:retry|try)(?:\s+your\s+request)?(?:\s+again)?\s+(?:after|in)\s+\d/i;

/** Append the provider's stated delay unless the text already states one. */
function appendRetryAfter(text: string, retryAfterMs: number | undefined): string {
	if (retryAfterMs === undefined || RETRY_AFTER_PHRASE.test(text)) return text;
	const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
	return `${text.replace(/[.\s]+$/, "")}; retry after ${seconds} seconds.`;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
