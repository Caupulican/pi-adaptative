import { isRecord } from "../utils/value-guards.ts";
import { requestBoundedAccountJson } from "./account-request.ts";

export const DEFAULT_OPENROUTER_ACCOUNT_BASE_URL = "https://openrouter.ai/api/v1";
const MAX_AMOUNT = 1e12;

export class OpenRouterAccountError extends Error {
	readonly status?: number;
	readonly retryAfterMs?: number;

	constructor(message: string, status?: number, retryAfterMs?: number) {
		super(message);
		this.name = "OpenRouterAccountError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

export interface OpenRouterAccountRequestOptions {
	apiKey: string;
	baseUrl?: string;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

export type OpenRouterKeyLimit = {
	limit?: number;
	limitRemaining?: number;
	limitReset?: string;
	usage?: number;
	usageDaily?: number;
	usageWeekly?: number;
	usageMonthly?: number;
};

export type OpenRouterAccountUsage = {
	totalCredits: number;
	totalUsage: number;
	key?: OpenRouterKeyLimit;
	keyUnavailable?: boolean;
};

function amount(data: Record<string, unknown>, field: string, required: boolean): number | undefined {
	const value = data[field];
	if (value === undefined || value === null) {
		if (required) throw new OpenRouterAccountError(`OpenRouter account response has no ${field}`);
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_AMOUNT) {
		throw new OpenRouterAccountError(`OpenRouter account response has an invalid ${field}`);
	}
	return value;
}

function dataOf(json: unknown, what: string): Record<string, unknown> {
	if (!isRecord(json) || !isRecord(json.data)) {
		throw new OpenRouterAccountError(`OpenRouter ${what} response has no data object`);
	}
	return json.data;
}

function parseKey(keyData: Record<string, unknown>): OpenRouterKeyLimit {
	const reset = keyData.limit_reset;
	if (reset !== undefined && reset !== null && typeof reset !== "string") {
		throw new OpenRouterAccountError("OpenRouter account response has an invalid limit_reset");
	}
	const limitReset = typeof reset === "string" && /^[a-z]{1,16}$/.test(reset.trim()) ? reset.trim() : undefined;
	const limit = amount(keyData, "limit", false);
	const limitRemaining = amount(keyData, "limit_remaining", false);
	const usage = amount(keyData, "usage", false);
	const usageDaily = amount(keyData, "usage_daily", false);
	const usageWeekly = amount(keyData, "usage_weekly", false);
	const usageMonthly = amount(keyData, "usage_monthly", false);
	return {
		...(limit !== undefined ? { limit } : {}),
		...(limitRemaining !== undefined ? { limitRemaining } : {}),
		...(limitReset ? { limitReset } : {}),
		...(usage !== undefined ? { usage } : {}),
		...(usageDaily !== undefined ? { usageDaily } : {}),
		...(usageWeekly !== undefined ? { usageWeekly } : {}),
		...(usageMonthly !== undefined ? { usageMonthly } : {}),
	};
}

export async function getOpenRouterAccountUsage(
	options: OpenRouterAccountRequestOptions,
): Promise<OpenRouterAccountUsage> {
	const apiKey = options.apiKey;
	if (!apiKey || apiKey.length > 64 * 1024 || /[^\x21-\x7e]/.test(apiKey)) {
		throw new OpenRouterAccountError("OpenRouter API key is not a valid header value.");
	}
	const base = (options.baseUrl?.trim() || DEFAULT_OPENROUTER_ACCOUNT_BASE_URL).replace(/\/+$/, "");
	const get = (path: string) =>
		requestBoundedAccountJson({
			url: `${base}${path}`,
			headers: new Headers({ Accept: "application/json", Authorization: `Bearer ${apiKey}` }),
			init: { method: "GET" },
			signal: options.signal,
			fetch: options.fetch,
			label: "OpenRouter account",
			createError: (message, status, retryAfterMs) => new OpenRouterAccountError(message, status, retryAfterMs),
		});
	const [creditsResult, keyResult] = await Promise.allSettled([get("/credits"), get("/key")]);
	if (creditsResult.status === "rejected") throw creditsResult.reason;
	const credits = dataOf(creditsResult.value, "credits");
	const totalCredits = amount(credits, "total_credits", true) as number;
	const totalUsage = amount(credits, "total_usage", true) as number;
	let key: OpenRouterKeyLimit | undefined;
	try {
		if (keyResult.status === "rejected") throw keyResult.reason;
		key = parseKey(dataOf(keyResult.value, "key"));
	} catch {
		key = undefined;
	}
	return { totalCredits, totalUsage, ...(key ? { key } : { keyUnavailable: true }) };
}
