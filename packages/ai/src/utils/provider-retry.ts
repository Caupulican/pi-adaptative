import { abortableSleep, createAbortError } from "./abort-signals.ts";

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

export interface ProviderRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
}

export interface ProviderRetryDirective {
	/** Explicit provider override from headers or structured availability metadata. */
	shouldRetry?: boolean;
	/** Minimum provider-requested delay before another request. */
	retryAfterMs?: number;
}

type ProviderHeaders = Headers | Record<string, string | string[] | undefined>;

interface ProviderError extends Error {
	status: number | undefined;
	headers: ProviderHeaders | undefined;
	/** Structured provider body retained by SDK errors, when available. */
	error?: unknown;
}

const providerRetryDirectiveOverrides = new WeakMap<Error, ProviderRetryDirective>();

function isProviderHeaders(value: unknown): value is ProviderHeaders | undefined {
	return value === undefined || (typeof value === "object" && value !== null);
}

function getProviderHeader(headers: ProviderHeaders | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	if ("get" in headers && typeof headers.get === "function") {
		const value = headers.get(name);
		return value === null ? undefined : value;
	}
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
	return Array.isArray(entry) ? entry.join(", ") : entry;
}

function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (error.status === undefined || typeof error.status === "number") && isProviderHeaders(error.headers);
}

function getExplicitShouldRetry(headers: ProviderHeaders | undefined): boolean | undefined {
	const value = getProviderHeader(headers, "x-should-retry")?.trim().toLowerCase();
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function getStructuredAvailability(error: ProviderError): Record<string, unknown> | undefined {
	const body = asRecord(error.error);
	if (!body) return undefined;
	const direct = asRecord(body.availability);
	if (direct) return direct;
	return asRecord(asRecord(body.error)?.availability);
}

function getStructuredShouldRetry(error: ProviderError): boolean | undefined {
	const retryable = getStructuredAvailability(error)?.retryable;
	return typeof retryable === "boolean" ? retryable : undefined;
}

function getStructuredRetryDelayMs(error: ProviderError): number | undefined {
	const seconds = getStructuredAvailability(error)?.retry_after;
	return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function getHeaderRetryDelayMs(error: ProviderError, nowMs = Date.now()): number | undefined {
	const retryAfterMs = getProviderHeader(error.headers, "retry-after-ms");
	if (retryAfterMs !== null && retryAfterMs !== undefined) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value)) return Math.max(0, value);
	}

	const retryAfter = getProviderHeader(error.headers, "retry-after");
	if (retryAfter !== null && retryAfter !== undefined) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - nowMs : seconds * 1000;
		if (Number.isFinite(delayMs)) return Math.max(0, delayMs);
	}
	return undefined;
}

function getServerRetryDelayMs(error: ProviderError): number | undefined {
	const delays = [getHeaderRetryDelayMs(error), getStructuredRetryDelayMs(error)].filter(
		(delay): delay is number => delay !== undefined,
	);
	return delays.length > 0 ? Math.max(...delays) : undefined;
}

function combineShouldRetry(...values: Array<boolean | undefined>): boolean | undefined {
	if (values.includes(false)) return false;
	return values.includes(true) ? true : undefined;
}

/** Extract redacted semantic retry guidance without retaining raw provider headers. */
export function getProviderRetryDirective(error: unknown): ProviderRetryDirective | undefined {
	if (!(error instanceof Error)) return undefined;
	const override = providerRetryDirectiveOverrides.get(error);
	if (override) return override;
	if (!isProviderError(error)) return undefined;

	const shouldRetry = combineShouldRetry(getExplicitShouldRetry(error.headers), getStructuredShouldRetry(error));
	const retryAfterMs = getServerRetryDelayMs(error);
	if (shouldRetry === undefined && retryAfterMs === undefined) return undefined;
	return {
		...(shouldRetry !== undefined ? { shouldRetry } : {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
	};
}

function formatRetrySeconds(delayMs: number): string {
	const seconds = delayMs / 1000;
	return Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(3)));
}

/** Preserve retry guidance through string-only error/session boundaries. */
export function appendProviderRetryDirective(message: string, error: unknown): string {
	const directive = getProviderRetryDirective(error);
	let suffix: string | undefined;
	if (directive?.shouldRetry === false) {
		suffix = "Provider retry directive: do not retry.";
	} else if (directive?.retryAfterMs !== undefined) {
		suffix = `Provider retry directive: retry after ${formatRetrySeconds(directive.retryAfterMs)}s.`;
	} else if (directive?.shouldRetry === true) {
		suffix = "Provider retry directive: retry.";
	}
	if (!suffix || message.includes(suffix)) return message;
	return message.length > 0 ? `${message}\n${suffix}` : suffix;
}

/** Mirrors the pinned OpenAI and Anthropic SDK retry policy. */
function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = combineShouldRetry(getExplicitShouldRetry(error.headers), getStructuredShouldRetry(error));
	if (shouldRetry !== undefined) return shouldRetry;
	if (error.status === undefined) return true;
	return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
}

function createRetryDelayExceededError(error: ProviderError, delayMs: number, maxDelayMs: number): Error {
	const boundedError = new Error(
		`Server requested ${formatRetrySeconds(delayMs)}s retry delay (max: ${formatRetrySeconds(maxDelayMs)}s). ${error.message}`,
		{ cause: error },
	);
	providerRetryDirectiveOverrides.set(boundedError, { shouldRetry: false, retryAfterMs: delayMs });
	return boundedError;
}

function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	error: ProviderError,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		throw createRetryDelayExceededError(error, delayMs, maxDelayMs);
	}
	return delayMs;
}

function getFallbackRetryDelayMs(retryIndex: number): number {
	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return exponentialDelay * (1 - Math.random() * 0.25);
}

/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs with an abortable backoff.
 * Call the SDK with `maxRetries: 0`; this helper is the sole provider-request retry owner.
 */
export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 0));
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			return await request();
		} catch (error) {
			if (options.signal?.aborted) throw createAbortError();
			if (!isProviderError(error) || !isRetryableProviderError(error)) throw error;

			const serverDelayMs = getServerRetryDelayMs(error);
			const boundedServerDelayMs =
				serverDelayMs === undefined
					? undefined
					: validateServerRetryDelayMs(serverDelayMs, options.maxRetryDelayMs, error);
			if (retriesRemaining <= 0) throw error;

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			await abortableSleep(boundedServerDelayMs ?? getFallbackRetryDelayMs(retryIndex), options.signal);
		}
	}
}
