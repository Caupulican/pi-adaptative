import { isRecord } from "../utils/value-guards.ts";
import { requestBoundedAccountJson } from "./account-request.ts";
import { ANTHROPIC_USAGE_USER_AGENT } from "./anthropic-identity.ts";

export const ANTHROPIC_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const ANTHROPIC_OAUTH_USAGE_USER_AGENT = ANTHROPIC_USAGE_USER_AGENT;
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const ANTHROPIC_USAGE_WINDOWS = [
	"five_hour",
	"seven_day",
	"seven_day_opus",
	"seven_day_sonnet",
	"seven_day_oauth_apps",
];

export class AnthropicAccountError extends Error {
	readonly status?: number;
	readonly retryAfterMs?: number;

	constructor(message: string, status?: number, retryAfterMs?: number) {
		super(message);
		this.name = "AnthropicAccountError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

export interface AnthropicAccountRequestOptions {
	accessToken: string;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

export type AnthropicUsageWindow = {
	name: string;
	usedPercent: number;
	resetsAt?: number;
	lockedReason?: string;
};

export type AnthropicExtraUsage = {
	enabled: boolean;
	usedCredits?: number;
	monthlyLimit?: number;
	currency?: string;
};

export type AnthropicOAuthUsage = {
	windows: AnthropicUsageWindow[];
	extraUsage?: AnthropicExtraUsage;
};

function optionalAmount(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new AnthropicAccountError(`Anthropic usage response has an invalid extra_usage ${field}`);
	}
	return value;
}

function parseExtraUsage(value: unknown): AnthropicExtraUsage | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value) || typeof value.is_enabled !== "boolean") {
		throw new AnthropicAccountError("Anthropic usage response has an invalid extra_usage");
	}
	if (!value.is_enabled) return { enabled: false };
	const usedCredits = optionalAmount(value.used_credits, "used_credits");
	const monthlyLimit = optionalAmount(value.monthly_limit, "monthly_limit");
	if (value.currency !== undefined && value.currency !== null && typeof value.currency !== "string") {
		throw new AnthropicAccountError("Anthropic usage response has an invalid extra_usage currency");
	}
	const currency =
		typeof value.currency === "string" && /^[A-Za-z]{3}$/.test(value.currency.trim())
			? value.currency.trim().toUpperCase()
			: undefined;
	return {
		enabled: true,
		...(usedCredits !== undefined ? { usedCredits } : {}),
		...(monthlyLimit !== undefined ? { monthlyLimit } : {}),
		...(currency ? { currency } : {}),
	};
}

function parseWindow(name: string, value: unknown): AnthropicUsageWindow | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) throw new AnthropicAccountError(`Anthropic usage response has an invalid ${name} window`);
	const usedPercent = value.utilization;
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) {
		throw new AnthropicAccountError(`Anthropic usage response has an invalid ${name} utilization`);
	}
	let resetsAt: number | undefined;
	if (value.resets_at !== undefined && value.resets_at !== null) {
		resetsAt = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : Number.NaN;
		if (!Number.isFinite(resetsAt)) {
			throw new AnthropicAccountError(`Anthropic usage response has an invalid ${name} resets_at`);
		}
	}
	const lockedReason =
		typeof value.locked_reason === "string" && value.locked_reason.trim() ? value.locked_reason.trim() : undefined;
	return {
		name,
		usedPercent,
		...(resetsAt !== undefined ? { resetsAt } : {}),
		...(lockedReason ? { lockedReason } : {}),
	};
}

export async function getAnthropicOAuthUsage(options: AnthropicAccountRequestOptions): Promise<AnthropicOAuthUsage> {
	const token = options.accessToken;
	if (!token || token.length > 64 * 1024 || /[^\x21-\x7e]/.test(token)) {
		throw new AnthropicAccountError("Anthropic OAuth access token is not a valid header value.");
	}
	const json = await requestBoundedAccountJson({
		url: ANTHROPIC_OAUTH_USAGE_URL,
		headers: new Headers({
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			"anthropic-beta": ANTHROPIC_OAUTH_BETA,
			"User-Agent": ANTHROPIC_OAUTH_USAGE_USER_AGENT,
		}),
		init: { method: "GET" },
		signal: options.signal,
		fetch: options.fetch,
		label: "Anthropic account",
		createError: (message, status, retryAfterMs) => new AnthropicAccountError(message, status, retryAfterMs),
	});
	if (!isRecord(json)) throw new AnthropicAccountError("Anthropic usage response is not an object");
	const windows: AnthropicUsageWindow[] = [];
	for (const name of ANTHROPIC_USAGE_WINDOWS) {
		const window = parseWindow(name, json[name]);
		if (window) windows.push(window);
	}
	const extraUsage = parseExtraUsage(json.extra_usage);
	return { windows, ...(extraUsage ? { extraUsage } : {}) };
}
