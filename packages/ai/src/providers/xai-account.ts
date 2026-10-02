import { isRecord } from "../utils/value-guards.ts";
import { requestBoundedAccountJson } from "./account-request.ts";
import { XAI_CLI_PROXY_BASE_URL, xaiCliHeaders } from "./xai-cli-identity.ts";

export class XaiAccountError extends Error {
	readonly status?: number;
	readonly retryAfterMs?: number;

	constructor(message: string, status?: number, retryAfterMs?: number) {
		super(message);
		this.name = "XaiAccountError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

export interface XaiAccountUsage {
	usedPercent?: number;
	periodType?: string;
	resetsAt?: number;
	monthlyLimitCents?: number;
	onDemandCapCents?: number;
	onDemandUsedCents?: number;
	prepaidBalanceCents?: number;
	onDemandEnabled?: boolean;
}

export interface XaiAccountRequestOptions {
	accessToken: string;
	userId?: string;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.length > 256) {
		throw new XaiAccountError(`xAI billing response has an invalid ${field}`);
	}
	return value;
}

function optionalCents(value: unknown, field: string): number | undefined {
	if (value === undefined || value === null) return undefined;
	// Billing amounts contain signed integer cents in a val object.
	if (!isRecord(value) || typeof value.val !== "number" || !Number.isSafeInteger(value.val)) {
		throw new XaiAccountError(`xAI billing response has an invalid ${field}`);
	}
	return value.val;
}

export async function getXaiAccountUsage(options: XaiAccountRequestOptions): Promise<XaiAccountUsage> {
	options.signal?.throwIfAborted();
	for (const [field, value] of [
		["access token", options.accessToken],
		["user id", options.userId],
	] as const) {
		if (
			(field === "access token" || value !== undefined) &&
			(!value || value.length > 64 * 1024 || /[^\x21-\x7e]/.test(value))
		) {
			throw new XaiAccountError(`xAI ${field} is not a valid header value`);
		}
	}
	const json = await requestBoundedAccountJson({
		url: `${XAI_CLI_PROXY_BASE_URL}/billing?format=credits`,
		headers: new Headers({
			...xaiCliHeaders(options.userId),
			Accept: "application/json",
			Authorization: `Bearer ${options.accessToken}`,
		}),
		init: { method: "GET" },
		signal: options.signal,
		fetch: options.fetch,
		label: "xAI account",
		createError: (message, status, retryAfterMs) => new XaiAccountError(message, status, retryAfterMs),
	});
	options.signal?.throwIfAborted();
	if (!isRecord(json) || !isRecord(json.config)) throw new XaiAccountError("xAI billing response has no config");
	const config = json.config;
	const usage: XaiAccountUsage = {};
	if (config.creditUsagePercent !== undefined && config.creditUsagePercent !== null) {
		if (
			typeof config.creditUsagePercent !== "number" ||
			!Number.isFinite(config.creditUsagePercent) ||
			config.creditUsagePercent < 0
		) {
			throw new XaiAccountError("xAI billing response has an invalid creditUsagePercent");
		}
		usage.usedPercent = config.creditUsagePercent;
	}
	if (config.currentPeriod !== undefined && config.currentPeriod !== null) {
		if (!isRecord(config.currentPeriod))
			throw new XaiAccountError("xAI billing response has an invalid currentPeriod");
		const type = optionalString(config.currentPeriod.type, "currentPeriod.type");
		const end = optionalString(config.currentPeriod.end, "currentPeriod.end");
		if (type) usage.periodType = type;
		if (end !== undefined) {
			const resetsAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(end)
				? Date.parse(end)
				: Number.NaN;
			if (!Number.isFinite(resetsAt))
				throw new XaiAccountError("xAI billing response has an invalid currentPeriod.end");
			usage.resetsAt = resetsAt;
		}
	}
	for (const [field, target] of [
		["monthlyLimit", "monthlyLimitCents"],
		["onDemandCap", "onDemandCapCents"],
		["onDemandUsed", "onDemandUsedCents"],
		["prepaidBalance", "prepaidBalanceCents"],
	] as const) {
		const cents = optionalCents(config[field], field);
		if (cents !== undefined) usage[target] = cents;
	}
	if (json.on_demand_enabled !== undefined && json.on_demand_enabled !== null) {
		if (typeof json.on_demand_enabled !== "boolean")
			throw new XaiAccountError("xAI billing response has an invalid on_demand_enabled");
		usage.onDemandEnabled = json.on_demand_enabled;
	}
	if (
		usage.usedPercent === undefined &&
		usage.monthlyLimitCents === undefined &&
		usage.onDemandCapCents === undefined &&
		usage.onDemandUsedCents === undefined &&
		usage.prepaidBalanceCents === undefined
	) {
		throw new XaiAccountError("xAI billing response has no reported usage or credit amounts");
	}
	return usage;
}
