export const MAX_ACCOUNT_RESPONSE_BYTES = 256 * 1024;

export interface AccountJsonRequest {
	url: string;
	headers: Headers;
	init?: RequestInit;
	signal?: AbortSignal;
	fetch?: typeof fetch;
	label: string;
	createError(message: string, status?: number, retryAfterMs?: number): Error;
}

export const MAX_ACCOUNT_RETRY_AFTER_MS = 15 * 60_000;

function retryAfterMs(response: Response): number | undefined {
	const raw = response.headers.get("retry-after")?.trim();
	if (!raw) return undefined;
	const seconds = /^\d{1,6}$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
	return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_ACCOUNT_RETRY_AFTER_MS) : undefined;
}

export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string | undefined> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	const parts: string[] = [];
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		bytes += next.value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel().catch(() => {});
			return undefined;
		}
		parts.push(decoder.decode(next.value, { stream: true }));
	}
	parts.push(decoder.decode());
	return parts.join("");
}

async function readBoundedText(response: Response, request: AccountJsonRequest): Promise<string> {
	const text = await readBoundedResponseText(response, MAX_ACCOUNT_RESPONSE_BYTES);
	if (text === undefined) {
		throw request.createError(`${request.label} response exceeded the 256 KiB limit`, response.status);
	}
	return text;
}

export async function requestBoundedAccountJson(request: AccountJsonRequest): Promise<unknown> {
	const fetchImpl = request.fetch ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") throw request.createError("Fetch is unavailable in this runtime");
	const response = await fetchImpl(request.url, {
		...request.init,
		headers: request.headers,
		signal: request.signal,
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => {});
		throw request.createError(
			`${request.label} request failed (HTTP ${response.status})`,
			response.status,
			retryAfterMs(response),
		);
	}
	const text = await readBoundedText(response, request);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw request.createError(`${request.label} response was not valid JSON`, response.status);
	}
}
