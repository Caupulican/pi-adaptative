import { isRecord } from "../utils/value-guards.ts";
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

async function readBoundedResponseText(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	const textParts: string[] = [];
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		bytes += next.value.byteLength;
		if (bytes > MAX_ACCOUNT_RESPONSE_BYTES) {
			await reader.cancel().catch(() => {});
			throw new OpenAICodexAccountError("OpenAI Codex account response exceeded the 256 KiB limit", response.status);
		}
		textParts.push(decoder.decode(next.value, { stream: true }));
	}
	textParts.push(decoder.decode());
	return textParts.join("");
}

async function requestAccountJson(
	options: OpenAICodexAccountRequestOptions,
	endpoint: "reset-credits" | "consume-reset-credit" | "models",
	init: RequestInit,
	query?: Record<string, string>,
): Promise<unknown> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") throw new OpenAICodexAccountError("Fetch is unavailable in this runtime");
	const headers = buildOpenAICodexHeaders({ token: options.accessToken, userAgent: "pi" });
	new Headers(init.headers).forEach((value, key) => {
		headers.set(key, value);
	});
	const url = new URL(resolveOpenAICodexAccountEndpoint(options.baseUrl, endpoint));
	for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
	const response = await fetchImpl(url.toString(), {
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
