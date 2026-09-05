const OPENAI_CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

export const DEFAULT_OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

type OpenAICodexJwtPayload = {
	[OPENAI_CODEX_JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: unknown;
	};
	[key: string]: unknown;
};

function decodeJwtPayload(token: string): OpenAICodexJwtPayload | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const encoded = parts[1];
		if (!encoded) return undefined;
		const base64 = encoded
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
		const decoded = JSON.parse(atob(base64)) as unknown;
		return typeof decoded === "object" && decoded !== null ? (decoded as OpenAICodexJwtPayload) : undefined;
	} catch {
		return undefined;
	}
}

export function getOpenAICodexAccountId(token: string): string | undefined {
	const accountId = decodeJwtPayload(token)?.[OPENAI_CODEX_JWT_CLAIM_PATH]?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

export function requireOpenAICodexAccountId(token: string): string {
	const accountId = getOpenAICodexAccountId(token);
	if (!accountId) throw new Error("Failed to extract accountId from token");
	return accountId;
}

export function buildOpenAICodexHeaders(options: {
	token: string;
	accountId?: string;
	initial?: Record<string, string>;
	additional?: Record<string, string>;
	userAgent?: string;
}): Headers {
	// Headers constructors include invalid values in thrown errors. Validate credential fields
	// first so callers can safely report failures without accidentally logging bearer material.
	if (!options.token || options.token.length > 64 * 1024 || /[^\x21-\x7e]/.test(options.token)) {
		throw new Error("Invalid ChatGPT OAuth access token.");
	}
	const accountId = options.accountId ?? requireOpenAICodexAccountId(options.token);
	if (!accountId || accountId.length > 1024 || /[^\x21-\x7e]/.test(accountId)) {
		throw new Error("Invalid ChatGPT account identifier.");
	}
	const headers = new Headers(options.initial);
	for (const [key, value] of Object.entries(options.additional ?? {})) headers.set(key, value);
	headers.set("Authorization", `Bearer ${options.token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	if (options.userAgent) headers.set("User-Agent", options.userAgent);
	return headers;
}
