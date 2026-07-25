import { buildOpenAICodexHeaders, DEFAULT_OPENAI_CODEX_BASE_URL } from "./openai-codex-auth.ts";

const MAX_ACCOUNT_RESPONSE_BYTES = 256 * 1024;
const MAX_ERROR_DETAIL_CHARS = 2_000;

export type OpenAICodexRateLimitResetCredit = {
	id: string;
	resetType: string;
	status: string;
	grantedAt: string;
	expiresAt?: string;
	title?: string;
	description?: string;
};

export type OpenAICodexRateLimitResetCredits = {
	credits: OpenAICodexRateLimitResetCredit[];
	availableCount: number;
};

export type OpenAICodexResetOutcome = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

export type OpenAICodexConsumeRateLimitResetResult = {
	outcome: OpenAICodexResetOutcome;
	windowsReset: number;
};

export interface OpenAICodexAccountRequestOptions {
	accessToken: string;
	baseUrl?: string;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

export class OpenAICodexAccountError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "OpenAICodexAccountError";
		this.status = status;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new OpenAICodexAccountError(`OpenAI Codex account response has invalid ${key}`);
	}
	return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new OpenAICodexAccountError(`OpenAI Codex account response has invalid ${key}`);
	}
	return value || undefined;
}

function requiredInteger(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		throw new OpenAICodexAccountError(`OpenAI Codex account response has invalid ${key}`);
	}
	return value;
}

function normalizeAccountBaseUrl(baseUrl?: string): string {
	let normalized = (baseUrl?.trim() || DEFAULT_OPENAI_CODEX_BASE_URL).replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) normalized = normalized.slice(0, -"/codex/responses".length);
	else if (normalized.endsWith("/codex")) normalized = normalized.slice(0, -"/codex".length);
	if (normalized.endsWith("/api")) normalized = normalized.slice(0, -"/api".length);

	const url = new URL(normalized);
	if (
		(url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") &&
		!url.pathname.split("/").includes("backend-api")
	) {
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/backend-api`;
	}
	return url.toString().replace(/\/+$/, "");
}

export function resolveOpenAICodexAccountEndpoint(
	baseUrl: string | undefined,
	endpoint: "usage" | "reset-credits" | "consume-reset-credit",
): string {
	const normalized = normalizeAccountBaseUrl(baseUrl);
	const usesChatGptPaths = new URL(normalized).pathname.split("/").includes("backend-api");
	const suffix = usesChatGptPaths
		? endpoint === "usage"
			? "/wham/usage"
			: endpoint === "reset-credits"
				? "/wham/rate-limit-reset-credits"
				: "/wham/rate-limit-reset-credits/consume"
		: endpoint === "usage"
			? "/api/codex/usage"
			: endpoint === "reset-credits"
				? "/api/codex/rate-limit-reset-credits"
				: "/api/codex/rate-limit-reset-credits/consume";
	return `${normalized}${suffix}`;
}

async function readBoundedResponseText(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		bytes += next.value.byteLength;
		if (bytes > MAX_ACCOUNT_RESPONSE_BYTES) {
			await reader.cancel().catch(() => {});
			throw new OpenAICodexAccountError("OpenAI Codex account response exceeded the 256 KiB limit", response.status);
		}
		text += decoder.decode(next.value, { stream: true });
	}
	return text + decoder.decode();
}

async function requestAccountJson(
	options: OpenAICodexAccountRequestOptions,
	endpoint: "reset-credits" | "consume-reset-credit",
	init: RequestInit,
): Promise<unknown> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") throw new OpenAICodexAccountError("Fetch is unavailable in this runtime");
	const headers = buildOpenAICodexHeaders({ token: options.accessToken, userAgent: "pi" });
	new Headers(init.headers).forEach((value, key) => {
		headers.set(key, value);
	});
	const response = await fetchImpl(resolveOpenAICodexAccountEndpoint(options.baseUrl, endpoint), {
		...init,
		headers,
		signal: options.signal,
	});
	const text = await readBoundedResponseText(response);
	if (!response.ok) {
		const detail = text.trim().slice(0, MAX_ERROR_DETAIL_CHARS);
		throw new OpenAICodexAccountError(
			`OpenAI Codex account request failed (${response.status})${detail ? `: ${detail}` : ""}`,
			response.status,
		);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new OpenAICodexAccountError("OpenAI Codex account response was not valid JSON", response.status);
	}
}

function parseResetCredit(value: unknown): OpenAICodexRateLimitResetCredit {
	if (!isRecord(value)) throw new OpenAICodexAccountError("OpenAI Codex account response has an invalid credit");
	return {
		id: requiredString(value, "id"),
		resetType: requiredString(value, "reset_type"),
		status: requiredString(value, "status"),
		grantedAt: requiredString(value, "granted_at"),
		expiresAt: optionalString(value, "expires_at"),
		title: optionalString(value, "title"),
		description: optionalString(value, "description"),
	};
}

export async function listOpenAICodexRateLimitResetCredits(
	options: OpenAICodexAccountRequestOptions,
): Promise<OpenAICodexRateLimitResetCredits> {
	const json = await requestAccountJson(options, "reset-credits", { method: "GET" });
	if (!isRecord(json) || !Array.isArray(json.credits)) {
		throw new OpenAICodexAccountError("OpenAI Codex account response has invalid reset credits");
	}
	return {
		credits: json.credits.map(parseResetCredit),
		availableCount: Math.max(0, requiredInteger(json, "available_count")),
	};
}

export async function consumeOpenAICodexRateLimitResetCredit(
	options: OpenAICodexAccountRequestOptions,
	redeemRequestId: string,
	creditId?: string,
): Promise<OpenAICodexConsumeRateLimitResetResult> {
	const json = await requestAccountJson(options, "consume-reset-credit", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			redeem_request_id: redeemRequestId,
			...(creditId ? { credit_id: creditId } : {}),
		}),
	});
	if (!isRecord(json)) throw new OpenAICodexAccountError("OpenAI Codex account response has invalid reset result");
	const outcome = requiredString(json, "code");
	if (
		outcome !== "reset" &&
		outcome !== "nothing_to_reset" &&
		outcome !== "no_credit" &&
		outcome !== "already_redeemed"
	) {
		throw new OpenAICodexAccountError(`OpenAI Codex account response has unknown reset outcome: ${outcome}`);
	}
	return { outcome, windowsReset: requiredInteger(json, "windows_reset") };
}
