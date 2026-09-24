import { isRecord } from "../utils/value-guards.ts";
import { requestBoundedAccountJson } from "./account-request.ts";
import { buildOpenAICodexHeaders, DEFAULT_OPENAI_CODEX_BASE_URL } from "./openai-codex-auth.ts";

export { OPENAI_CODEX_FEDRAMP_HEADER } from "./openai-codex-auth.ts";

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
	credentialHeaders?: Record<string, string>;
}

export class OpenAICodexAccountError extends Error {
	readonly status?: number;
	readonly retryAfterMs?: number;

	constructor(message: string, status?: number, retryAfterMs?: number) {
		super(message);
		this.name = "OpenAICodexAccountError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
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
	endpoint: "usage" | "reset-credits" | "consume-reset-credit" | "models",
): string {
	const normalized = normalizeAccountBaseUrl(baseUrl);
	const usesChatGptPaths = new URL(normalized).pathname.split("/").includes("backend-api");
	if (endpoint === "models") return `${normalized}${usesChatGptPaths ? "/codex/models" : "/api/codex/models"}`;
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

async function requestAccountJson(
	options: OpenAICodexAccountRequestOptions,
	endpoint: "usage" | "reset-credits" | "consume-reset-credit" | "models",
	init: RequestInit,
	query?: Record<string, string>,
): Promise<unknown> {
	const headers = buildOpenAICodexHeaders({
		token: options.accessToken,
		userAgent: "pi",
		credentialHeaders: options.credentialHeaders,
	});
	new Headers(init.headers).forEach((value, key) => {
		headers.set(key, value);
	});
	const url = new URL(resolveOpenAICodexAccountEndpoint(options.baseUrl, endpoint));
	for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
	return requestBoundedAccountJson({
		url: url.toString(),
		headers,
		init,
		signal: options.signal,
		fetch: options.fetch,
		label: "OpenAI Codex account",
		createError: (message, status, retryAfterMs) => new OpenAICodexAccountError(message, status, retryAfterMs),
	});
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

/**
 * The Codex client release whose model protocol pi's Codex transport speaks. The models endpoint
 * lists only the models a client of this version may use, so it is part of what the account can use.
 * It is the release scripts/data/codex-models.json was pinned from (scripts/sync-codex-models.ts),
 * so the model catalogue and what the account is asked for always name the same release.
 */
export const OPENAI_CODEX_CLIENT_VERSION = "0.156.1";

export interface OpenAICodexAccountModel {
	slug: string;
	displayName: string;
	/** `list` models are offered for picking; `hide` models exist but are not meant to be chosen. */
	visibility: string;
	supportedInApi: boolean;
	/** Lower comes first: the Codex CLI's own default is the first listed model. */
	priority: number;
}

function parseAccountModel(value: unknown): OpenAICodexAccountModel {
	if (!isRecord(value)) throw new OpenAICodexAccountError("OpenAI Codex models response has an invalid model");
	const supportedInApi = value.supported_in_api;
	if (typeof supportedInApi !== "boolean") {
		throw new OpenAICodexAccountError("OpenAI Codex models response has invalid supported_in_api");
	}
	return {
		slug: requiredString(value, "slug"),
		displayName: optionalString(value, "display_name") ?? requiredString(value, "slug"),
		visibility: requiredString(value, "visibility"),
		supportedInApi,
		priority: requiredInteger(value, "priority"),
	};
}

/** The models this ChatGPT account may use with Codex, as the Codex CLI asks for them. */
export async function listOpenAICodexAccountModels(
	options: OpenAICodexAccountRequestOptions & { clientVersion?: string },
): Promise<OpenAICodexAccountModel[]> {
	const json = await requestAccountJson(
		options,
		"models",
		{ method: "GET" },
		{
			client_version: options.clientVersion ?? OPENAI_CODEX_CLIENT_VERSION,
		},
	);
	if (!isRecord(json) || !Array.isArray(json.models)) {
		throw new OpenAICodexAccountError("OpenAI Codex models response has no models list");
	}
	return json.models.map(parseAccountModel);
}

export type OpenAICodexUsageWindow = {
	usedPercent: number;
	windowSeconds?: number;
	resetsAt?: number;
};

export const OPENAI_CODEX_LIMIT_REACHED_TYPES = [
	"rate_limit_reached",
	"workspace_owner_credits_depleted",
	"workspace_member_credits_depleted",
	"workspace_owner_usage_limit_reached",
	"workspace_member_usage_limit_reached",
	"unknown",
] as const;
export type OpenAICodexLimitReachedType = (typeof OPENAI_CODEX_LIMIT_REACHED_TYPES)[number];

export type OpenAICodexUsageLimit = {
	name: string;
	allowed?: boolean;
	limitReached?: boolean;
	primary?: OpenAICodexUsageWindow;
	secondary?: OpenAICodexUsageWindow;
};

export type OpenAICodexSpendControl = {
	reached: boolean;
	individualLimit?: { usedPercent: number; used: string; limit: string; resetsAt?: number };
};

export type OpenAICodexUsage = {
	planType?: string;
	limits: OpenAICodexUsageLimit[];
	credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
	limitReachedType?: OpenAICodexLimitReachedType;
	resetCreditsAvailable?: number;
	spendControl?: OpenAICodexSpendControl;
};

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageWindow(value: unknown): OpenAICodexUsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const usedPercent = finiteNumber(value.used_percent);
	if (usedPercent === undefined) return undefined;
	const windowSeconds = finiteNumber(value.limit_window_seconds);
	const resetsAt = finiteNumber(value.reset_at);
	return {
		usedPercent,
		...(windowSeconds !== undefined && windowSeconds > 0 ? { windowSeconds } : {}),
		...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt } : {}),
	};
}

function usageLimit(name: string, value: unknown): OpenAICodexUsageLimit | undefined {
	if (!isRecord(value)) return undefined;
	const primary = usageWindow(value.primary_window);
	const secondary = usageWindow(value.secondary_window);
	const allowed = typeof value.allowed === "boolean" ? value.allowed : undefined;
	const limitReached = typeof value.limit_reached === "boolean" ? value.limit_reached : undefined;
	if (!primary && !secondary && allowed === undefined && limitReached === undefined) return undefined;
	return {
		name,
		...(allowed !== undefined ? { allowed } : {}),
		...(limitReached !== undefined ? { limitReached } : {}),
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
	};
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const CREDIT_AMOUNT = /^\d{1,15}(?:\.\d{1,6})?$/;

function spendControl(value: unknown): OpenAICodexSpendControl | undefined {
	if (value === undefined || value === null) return undefined;
	const invalid = () => new OpenAICodexAccountError("OpenAI Codex usage response has invalid spend_control");
	if (!isRecord(value) || typeof value.reached !== "boolean") throw invalid();
	const limit = value.individual_limit;
	if (limit === undefined || limit === null) return { reached: value.reached };
	if (!isRecord(limit)) throw invalid();
	const remainingPercent = finiteNumber(limit.remaining_percent);
	const used = typeof limit.used === "string" ? limit.used.trim() : "";
	const total = typeof limit.limit === "string" ? limit.limit.trim() : "";
	const resetsAt = limit.reset_at === undefined || limit.reset_at === null ? undefined : finiteNumber(limit.reset_at);
	if (
		remainingPercent === undefined ||
		remainingPercent < 0 ||
		remainingPercent > 100 ||
		!CREDIT_AMOUNT.test(used) ||
		!CREDIT_AMOUNT.test(total) ||
		(limit.reset_at !== undefined && limit.reset_at !== null && (resetsAt === undefined || resetsAt <= 0))
	) {
		throw invalid();
	}
	return {
		reached: value.reached,
		individualLimit: {
			usedPercent: 100 - remainingPercent,
			used,
			limit: total,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		},
	};
}

export async function getOpenAICodexUsage(options: OpenAICodexAccountRequestOptions): Promise<OpenAICodexUsage> {
	const json = await requestAccountJson(options, "usage", { method: "GET", headers: { Accept: "application/json" } });
	if (!isRecord(json)) throw new OpenAICodexAccountError("OpenAI Codex usage response is not an object");
	const limits: OpenAICodexUsageLimit[] = [];
	const main = usageLimit("codex", json.rate_limit);
	if (main) limits.push(main);
	if (Array.isArray(json.additional_rate_limits)) {
		for (const additional of json.additional_rate_limits) {
			if (!isRecord(additional)) continue;
			const name = nonEmptyString(additional.limit_name) ?? nonEmptyString(additional.metered_feature);
			const limit = name ? usageLimit(name, additional.rate_limit) : undefined;
			if (limit) limits.push(limit);
		}
	}
	const credits = json.credits;
	const reachedType = isRecord(json.rate_limit_reached_type) ? json.rate_limit_reached_type.type : undefined;
	const reached: OpenAICodexLimitReachedType | undefined =
		typeof reachedType !== "string"
			? undefined
			: (((OPENAI_CODEX_LIMIT_REACHED_TYPES as readonly string[]).includes(reachedType)
					? reachedType
					: "unknown") as OpenAICodexLimitReachedType);
	const resetCredits = isRecord(json.rate_limit_reset_credits)
		? finiteNumber(json.rate_limit_reset_credits.available_count)
		: undefined;
	const spend = spendControl(json.spend_control);
	const balance = isRecord(credits)
		? (nonEmptyString(credits.balance) ?? finiteNumber(credits.balance)?.toString())
		: undefined;
	return {
		...(nonEmptyString(json.plan_type) ? { planType: nonEmptyString(json.plan_type) } : {}),
		limits,
		...(isRecord(credits) && typeof credits.has_credits === "boolean" && typeof credits.unlimited === "boolean"
			? {
					credits: {
						hasCredits: credits.has_credits,
						unlimited: credits.unlimited,
						...(credits.has_credits && balance ? { balance } : {}),
					},
				}
			: {}),
		...(reached ? { limitReachedType: reached } : {}),
		...(resetCredits !== undefined && resetCredits >= 0 ? { resetCreditsAvailable: Math.floor(resetCredits) } : {}),
		...(spend ? { spendControl: spend } : {}),
	};
}
