/**
 * Command Code account identity, billing credits, subscription period, and usage summary client for `/usage` and
 * proactive subscription-allowance checks.
 */

import { isRecord } from "../utils/value-guards.ts";
import { requestBoundedAccountJson } from "./account-request.ts";
import { COMMAND_CODE_BASE_URL, COMMAND_CODE_CLIENT_VERSION } from "./command-code-request.ts";

export const DEFAULT_COMMAND_CODE_ACCOUNT_BASE_URL = COMMAND_CODE_BASE_URL;

const MAX_AMOUNT = 1e12;
const MAX_STRING_CHARS = 256;
const MAX_ORG_LIMITS = 64;

export class CommandCodeAccountError extends Error {
	readonly status?: number;
	readonly retryAfterMs?: number;

	constructor(message: string, status?: number, retryAfterMs?: number) {
		super(message);
		this.name = "CommandCodeAccountError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

export interface CommandCodeAccountRequestOptions {
	baseUrl?: string;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

export interface CommandCodeUser {
	id?: string;
	name?: string;
	email?: string;
	userName?: string;
}

export interface CommandCodeOrg {
	id?: string;
	name?: string;
	login?: string;
}

export interface CommandCodeOrgLimit {
	scope?: string;
	model?: string;
	modelLabel?: string;
	spent: number;
	limit: number;
	exceeded?: boolean;
	resetInterval?: string;
	resetAt?: string;
}

export interface CommandCodeWhoami {
	user: CommandCodeUser;
	org?: CommandCodeOrg;
	orgLimits: CommandCodeOrgLimit[];
}

export interface CommandCodeWindowLimit {
	used: number;
	cap: number;
	resetAt?: number;
}

export interface CommandCodeWindowLimits {
	limited?: boolean;
	fiveHour?: CommandCodeWindowLimit;
	weekly?: CommandCodeWindowLimit;
}

export interface CommandCodeCredits {
	planId?: string;
	/** Remaining monthly included subscription credits (USD) reported by `/alpha/billing/credits`. */
	monthlyCredits?: number;
	purchasedCredits?: number;
	freeCredits?: number;
}

export interface CommandCodeBillingCredits {
	credits?: CommandCodeCredits;
	windowLimits?: CommandCodeWindowLimits;
}

export interface CommandCodeSubscription {
	planId?: string;
	status?: string;
	currentPeriodStart?: string;
	currentPeriodEnd?: number;
}

export interface CommandCodeUsageSummary {
	totalCost?: number;
	totalCount?: number;
	periodBasis?: string;
}

export interface CommandCodeAccountUsage {
	whoami: CommandCodeWhoami;
	billingCredits?: CommandCodeBillingCredits;
	subscription?: CommandCodeSubscription;
	usageSummary?: CommandCodeUsageSummary;
	planId?: string;
	plan?: string;
	/** Known monthly included credit cap (USD) for `planId` from Command Code 1.88.5's plan table, when recognized. */
	planMonthlyCredits?: number;
}

interface PlanSpec {
	readonly key: string;
	readonly label: string;
	readonly monthlyCredits: number;
}

const KNOWN_PLAN_SPECS: readonly PlanSpec[] = [
	{ key: "teams_pro", label: "Teams Pro", monthlyCredits: 40 },
	{ key: "provider", label: "Provider", monthlyCredits: 15 },
	{ key: "pro_v1", label: "Pro v1", monthlyCredits: 80 },
	{ key: "go_v1", label: "Go v1", monthlyCredits: 10 },
	{ key: "ultra", label: "Ultra", monthlyCredits: 300 },
	{ key: "goat", label: "Goat", monthlyCredits: 70 },
	{ key: "max", label: "Max", monthlyCredits: 150 },
	{ key: "pro", label: "Pro", monthlyCredits: 30 },
	{ key: "go", label: "Go", monthlyCredits: 10 },
];

function normalizePlanKey(planId: string): string {
	return planId
		.trim()
		.toLowerCase()
		.replace(/^individual[-_]+/, "")
		.replace(/[-\s]+/g, "_");
}

function matchKnownPlan(planId: string | undefined): PlanSpec | undefined {
	if (!planId?.trim()) return undefined;
	const key = normalizePlanKey(planId);
	return KNOWN_PLAN_SPECS.find((spec) => key === spec.key || key.startsWith(`${spec.key}_`));
}

export function formatCommandCodePlanLabel(planId: string): string {
	const known = matchKnownPlan(planId);
	if (known) return known.label;
	const cleaned = normalizePlanKey(planId);
	if (!cleaned) return planId.trim().slice(0, 64);
	return cleaned
		.split("_")
		.filter(Boolean)
		.map((part) => (/^v\d+$/i.test(part) ? part.toLowerCase() : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`))
		.join(" ")
		.slice(0, 64);
}

export function getCommandCodePlanMonthlyCredits(planId: string | undefined): number | undefined {
	return matchKnownPlan(planId)?.monthlyCredits;
}

function cleanString(value: unknown, maxChars = MAX_STRING_CHARS): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxChars) return undefined;
	return trimmed;
}

function nonNegativeAmount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_AMOUNT) return undefined;
	return Math.max(0, value);
}

function parseTimestampMs(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isFinite(value) && value > 0 ? value : undefined;
	}
	if (typeof value === "string" && value.trim() && value.length <= MAX_STRING_CHARS) {
		const parsed = Date.parse(value.trim());
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	}
	return undefined;
}

function parseIsoTimestamp(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim() && value.length <= MAX_STRING_CHARS) {
		const trimmed = value.trim();
		const parsed = Date.parse(trimmed);
		return Number.isFinite(parsed) && parsed > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return new Date(value).toISOString();
	}
	return undefined;
}

function resolveBaseUrl(baseUrl: string | undefined): string {
	const raw = baseUrl?.trim() || DEFAULT_COMMAND_CODE_ACCOUNT_BASE_URL;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new CommandCodeAccountError("Command Code base URL is invalid.");
	}
	if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
		throw new CommandCodeAccountError("Command Code base URL must use HTTP or HTTPS without credentials.");
	}
	return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

function buildEndpointUrl(base: string, route: string, params?: Record<string, string | undefined>): string {
	const url = new URL(`${base}${route}`);
	if (params) {
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "") search.set(key, value);
		}
		const query = search.toString();
		if (query) url.search = query;
	}
	return url.toString();
}

function accountHeaders(apiKey: string): Headers {
	return new Headers({
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		"User-Agent": "cli",
		"x-command-code-version": COMMAND_CODE_CLIENT_VERSION,
		"x-cli-environment": "production",
	});
}

function parseOrgLimit(value: unknown): CommandCodeOrgLimit | undefined {
	if (!isRecord(value)) return undefined;
	const spent = nonNegativeAmount(value.spent);
	const limit = nonNegativeAmount(value.limit);
	const exceeded = typeof value.exceeded === "boolean" ? value.exceeded : undefined;
	if (limit === undefined && exceeded !== true) return undefined;
	const scope = cleanString(value.scope, 64);
	const model = cleanString(value.model, 128);
	const modelLabel = cleanString(value.modelLabel, 128);
	const resetInterval = cleanString(value.resetInterval, 32);
	const resetAt = parseIsoTimestamp(value.resetAt);
	return {
		spent: spent ?? 0,
		limit: limit ?? 0,
		...(scope ? { scope } : {}),
		...(model ? { model } : {}),
		...(modelLabel ? { modelLabel } : {}),
		...(exceeded !== undefined ? { exceeded } : {}),
		...(resetInterval ? { resetInterval } : {}),
		...(resetAt ? { resetAt } : {}),
	};
}

function parseWhoami(json: unknown): CommandCodeWhoami {
	if (!isRecord(json) || json.success === false || !isRecord(json.user)) {
		throw new CommandCodeAccountError("Command Code whoami response is missing user data.");
	}
	const userRecord = json.user;
	const user: CommandCodeUser = {
		...(cleanString(userRecord.id) ? { id: cleanString(userRecord.id) } : {}),
		...(cleanString(userRecord.name) ? { name: cleanString(userRecord.name) } : {}),
		...(cleanString(userRecord.email) ? { email: cleanString(userRecord.email) } : {}),
		...(cleanString(userRecord.userName) ? { userName: cleanString(userRecord.userName) } : {}),
	};
	let org: CommandCodeOrg | undefined;
	if (isRecord(json.org)) {
		const id = cleanString(json.org.id);
		const name = cleanString(json.org.name);
		const login = cleanString(json.org.login);
		if (id || name || login) {
			org = {
				...(id ? { id } : {}),
				...(name ? { name } : {}),
				...(login ? { login } : {}),
			};
		}
	}
	const orgLimits: CommandCodeOrgLimit[] = [];
	if (Array.isArray(json.orgLimits)) {
		for (const item of json.orgLimits.slice(0, MAX_ORG_LIMITS)) {
			const parsed = parseOrgLimit(item);
			if (parsed) orgLimits.push(parsed);
		}
	}
	return { user, ...(org ? { org } : {}), orgLimits };
}

function parseWindowLimit(value: unknown): CommandCodeWindowLimit | undefined {
	if (!isRecord(value)) return undefined;
	const used = nonNegativeAmount(value.used);
	const cap = nonNegativeAmount(value.cap);
	if (used === undefined || cap === undefined) return undefined;
	const resetAt = parseTimestampMs(value.resetAt);
	return {
		used,
		cap,
		...(resetAt !== undefined ? { resetAt } : {}),
	};
}

function parseBillingCredits(json: unknown): CommandCodeBillingCredits | undefined {
	if (!isRecord(json)) return undefined;
	let credits: CommandCodeCredits | undefined;
	if (isRecord(json.credits)) {
		const planId = cleanString(json.credits.planId, 64);
		const monthlyCredits = nonNegativeAmount(json.credits.monthlyCredits);
		const purchasedCredits = nonNegativeAmount(json.credits.purchasedCredits);
		const freeCredits = nonNegativeAmount(json.credits.freeCredits);
		if (
			planId !== undefined ||
			monthlyCredits !== undefined ||
			purchasedCredits !== undefined ||
			freeCredits !== undefined
		) {
			credits = {
				...(planId ? { planId } : {}),
				...(monthlyCredits !== undefined ? { monthlyCredits } : {}),
				...(purchasedCredits !== undefined ? { purchasedCredits } : {}),
				...(freeCredits !== undefined ? { freeCredits } : {}),
			};
		}
	}
	let windowLimits: CommandCodeWindowLimits | undefined;
	if (isRecord(json.windowLimits)) {
		const limited = typeof json.windowLimits.limited === "boolean" ? json.windowLimits.limited : undefined;
		const fiveHour = parseWindowLimit(json.windowLimits.fiveHour);
		const weekly = parseWindowLimit(json.windowLimits.weekly);
		if (limited !== undefined || fiveHour !== undefined || weekly !== undefined) {
			windowLimits = {
				...(limited !== undefined ? { limited } : {}),
				...(fiveHour ? { fiveHour } : {}),
				...(weekly ? { weekly } : {}),
			};
		}
	}
	if (!credits && !windowLimits) return undefined;
	return {
		...(credits ? { credits } : {}),
		...(windowLimits ? { windowLimits } : {}),
	};
}

function parseSubscription(json: unknown): CommandCodeSubscription | undefined {
	if (!isRecord(json) || json.success === false) return undefined;
	const data = isRecord(json.data) ? json.data : undefined;
	if (!data) return undefined;
	const planId = cleanString(data.planId, 64);
	const status = cleanString(data.status, 32);
	const currentPeriodStart = parseIsoTimestamp(data.currentPeriodStart);
	const currentPeriodEnd = parseTimestampMs(data.currentPeriodEnd);
	if (!planId && !status && !currentPeriodStart && currentPeriodEnd === undefined) return undefined;
	return {
		...(planId ? { planId } : {}),
		...(status ? { status } : {}),
		...(currentPeriodStart ? { currentPeriodStart } : {}),
		...(currentPeriodEnd !== undefined ? { currentPeriodEnd } : {}),
	};
}

function parseUsageSummary(json: unknown): CommandCodeUsageSummary | undefined {
	const root = isRecord(json) ? (json.totalCost === undefined && isRecord(json.data) ? json.data : json) : undefined;
	if (!root) return undefined;
	const totalCost = nonNegativeAmount(root.totalCost);
	const rawCount = nonNegativeAmount(root.totalCount);
	const totalCount = rawCount !== undefined ? Math.round(rawCount) : undefined;
	const periodBasis = cleanString(root.periodBasis, 64);
	if (totalCost === undefined && totalCount === undefined && !periodBasis) return undefined;
	return {
		...(totalCost !== undefined ? { totalCost } : {}),
		...(totalCount !== undefined ? { totalCount } : {}),
		...(periodBasis ? { periodBasis } : {}),
	};
}

export async function fetchCommandCodeAccountUsage(
	apiKey: string,
	options?: CommandCodeAccountRequestOptions,
): Promise<CommandCodeAccountUsage> {
	options?.signal?.throwIfAborted();
	if (!apiKey || apiKey.length > 64 * 1024 || /[^\x21-\x7e]/.test(apiKey)) {
		throw new CommandCodeAccountError("Command Code API key is not a valid header value.");
	}
	const base = resolveBaseUrl(options?.baseUrl);
	const signal = options?.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
		: AbortSignal.timeout(30_000);

	const getJson = (route: string, params?: Record<string, string | undefined>) =>
		requestBoundedAccountJson({
			url: buildEndpointUrl(base, route, params),
			headers: accountHeaders(apiKey),
			init: { method: "GET" },
			signal,
			fetch: options?.fetch,
			label: "Command Code account",
			createError: (message, status, retryAfterMs) => new CommandCodeAccountError(message, status, retryAfterMs),
		});

	const whoamiJson = await getJson("/alpha/whoami", { limits: "1" });
	signal.throwIfAborted();
	const whoami = parseWhoami(whoamiJson);
	const orgId = whoami.org?.id;

	const [creditsSettled, subscriptionSettled] = await Promise.allSettled([
		getJson("/alpha/billing/credits", { orgId }),
		getJson("/alpha/billing/subscriptions", { orgId }),
	]);
	signal.throwIfAborted();

	const billingCredits = creditsSettled.status === "fulfilled" ? parseBillingCredits(creditsSettled.value) : undefined;
	const subscription =
		subscriptionSettled.status === "fulfilled" ? parseSubscription(subscriptionSettled.value) : undefined;

	let usageSummary: CommandCodeUsageSummary | undefined;
	try {
		const summaryJson = await getJson("/alpha/usage/summary", {
			orgId,
			since: subscription?.currentPeriodStart,
		});
		usageSummary = parseUsageSummary(summaryJson);
	} catch {
		signal.throwIfAborted();
		usageSummary = undefined;
	}
	signal.throwIfAborted();

	const rawPlanId = subscription?.planId ?? billingCredits?.credits?.planId;
	const plan = rawPlanId ? formatCommandCodePlanLabel(rawPlanId) : undefined;
	const planMonthlyCredits = getCommandCodePlanMonthlyCredits(rawPlanId);

	return {
		whoami,
		...(billingCredits ? { billingCredits } : {}),
		...(subscription ? { subscription } : {}),
		...(usageSummary ? { usageSummary } : {}),
		...(rawPlanId ? { planId: rawPlanId } : {}),
		...(plan ? { plan } : {}),
		...(planMonthlyCredits !== undefined ? { planMonthlyCredits } : {}),
	};
}
