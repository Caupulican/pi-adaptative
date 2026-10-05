import {
	ANTIGRAVITY_ACCOUNT_METADATA,
	ANTIGRAVITY_ENDPOINT,
	antigravityHeaders,
	antigravityProjectId,
} from "../utils/antigravity.ts";
import { isRecord } from "../utils/value-guards.ts";
import { requestBoundedAccountJson } from "./account-request.ts";
import { parseAntigravityCredits } from "./antigravity-credits.ts";

export class AntigravityAccountError extends Error {
	readonly status?: number;
	readonly retryAfterMs?: number;

	constructor(message: string, status?: number, retryAfterMs?: number) {
		super(message);
		this.name = "AntigravityAccountError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

export interface AntigravityQuotaBucket {
	id: string;
	name: string;
	window?: string;
	description?: string;
	disabled: boolean;
	remaining: { kind: "fraction"; fraction: number } | { kind: "amount"; amount: number } | { kind: "unreported" };
	resetsAt?: number;
}

export interface AntigravityAccountUsage {
	plan?: string;
	description?: string;
	groups: { name: string; description?: string; buckets: AntigravityQuotaBucket[] }[];
	credits: { type: string; amount: number; minimum: number }[];
}

export interface AntigravityAccountRequestOptions {
	accessToken: string;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

function text(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.length > 4096)
		throw new AntigravityAccountError("Antigravity account response has invalid text");
	return value;
}

function amount(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	// ProtoJSON represents int64 credit and quota amounts as decimal strings.
	const numeric = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
	if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < 0)
		throw new AntigravityAccountError("Antigravity account response has an invalid amount");
	return numeric;
}

function list(value: unknown): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 200)
		throw new AntigravityAccountError("Antigravity account response has an invalid list");
	return value;
}

function bucket(value: unknown): AntigravityQuotaBucket {
	if (!isRecord(value)) throw new AntigravityAccountError("Invalid Antigravity quota bucket");
	const id = text(value.bucketId);
	if (!id) throw new AntigravityAccountError("Antigravity quota bucket has no identifier");
	if (value.disabled !== undefined && typeof value.disabled !== "boolean")
		throw new AntigravityAccountError("Antigravity quota bucket has invalid availability");
	let remaining: AntigravityQuotaBucket["remaining"] = { kind: "unreported" };
	if (value.remainingFraction !== undefined) {
		const fraction = value.remainingFraction;
		if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1)
			throw new AntigravityAccountError("Antigravity quota bucket has an invalid remaining fraction");
		if (value.remainingAmount !== undefined)
			throw new AntigravityAccountError("Antigravity quota bucket has conflicting remaining amounts");
		remaining = { kind: "fraction", fraction };
	} else {
		const left = amount(value.remainingAmount);
		if (left !== undefined) remaining = { kind: "amount", amount: left };
	}
	const reset = text(value.resetTime);
	const resetsAt = reset === undefined ? undefined : Date.parse(reset);
	if (
		reset !== undefined &&
		(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(reset) ||
			resetsAt === undefined ||
			!Number.isFinite(resetsAt))
	)
		throw new AntigravityAccountError("Antigravity quota bucket has an invalid reset time");
	return {
		id,
		name: text(value.displayName) || id,
		window: text(value.window),
		description: text(value.description),
		disabled: value.disabled === true,
		remaining,
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
}

export async function getAntigravityAccountUsage(
	options: AntigravityAccountRequestOptions,
): Promise<AntigravityAccountUsage> {
	options.signal?.throwIfAborted();
	if (!options.accessToken || options.accessToken.length > 64 * 1024 || /[^\x21-\x7e]/.test(options.accessToken))
		throw new AntigravityAccountError("Antigravity access token is not a valid header value");
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
		: AbortSignal.timeout(30_000);
	const request = (method: string, body: unknown) =>
		requestBoundedAccountJson({
			url: `${ANTIGRAVITY_ENDPOINT}/v1internal:${method}`,
			headers: new Headers({ ...antigravityHeaders(options.accessToken), Accept: "application/json" }),
			init: { method: "POST", body: JSON.stringify(body) },
			signal,
			fetch: options.fetch,
			label: "Antigravity account",
			createError: (message, status, retryAfterMs) => new AntigravityAccountError(message, status, retryAfterMs),
		});
	const account = await request("loadCodeAssist", { metadata: ANTIGRAVITY_ACCOUNT_METADATA });
	if (!isRecord(account)) throw new AntigravityAccountError("Invalid Antigravity account response");
	const project = antigravityProjectId(account);
	const quota = await request("retrieveUserQuotaSummary", { project });
	signal.throwIfAborted();
	if (!isRecord(quota)) throw new AntigravityAccountError("Invalid Antigravity quota summary");
	const groups = list(quota.groups).map((value) => {
		if (!isRecord(value)) throw new AntigravityAccountError("Invalid Antigravity quota group");
		return {
			name: text(value.displayName) || "Quota",
			description: text(value.description),
			buckets: list(value.buckets).map(bucket),
		};
	});
	const buckets = list(quota.buckets).map(bucket);
	if (buckets.length > 0) groups.push({ name: "Quota", description: undefined, buckets });
	const tier = account.paidTier ?? account.currentTier;
	if (tier !== undefined && !isRecord(tier)) throw new AntigravityAccountError("Invalid Antigravity plan");
	const plan = isRecord(tier) ? text(tier.name) || text(tier.id) : undefined;
	const credits = parseAntigravityCredits(
		isRecord(tier) ? tier.availableCredits : undefined,
		(message) => new AntigravityAccountError(message),
	);
	if (groups.every((group) => group.buckets.length === 0) && credits.length === 0)
		throw new AntigravityAccountError("Antigravity account returned no quota or credits");
	return { plan, description: text(quota.description), groups, credits };
}
