import type { Model, Usage, UsageDetails } from "../types.ts";
import { calculateCost, parseProviderReportedCost } from "../usage.ts";
import { isRecord } from "../utils/value-guards.ts";

function count(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("Invalid Anthropic token or request count");
	return value;
}

/** Owns cumulative Anthropic usage for one response, including optional compatible-provider cost. */
export class AnthropicUsageAccumulator {
	private readonly model: Model<"anthropic-messages">;
	private readonly usage: Usage;
	private providerReportedCost: number | undefined;
	private outputReported = false;
	private cacheWriteReported = false;

	constructor(model: Model<"anthropic-messages">, usage: Usage) {
		this.model = model;
		this.usage = usage;
	}

	update(value: unknown): void {
		if (!isRecord(value)) throw new Error("Invalid Anthropic usage metadata");
		// Publish only after validation: malformed metadata cannot leave half-updated usage behind.
		const next: Usage = { ...this.usage, cost: { ...this.usage.cost } };
		for (const [source, target] of [
			["input_tokens", "input"],
			["output_tokens", "output"],
			["cache_read_input_tokens", "cacheRead"],
			["cache_creation_input_tokens", "cacheWrite"],
		] as const) {
			if (value[source] != null) next[target] = count(value[source]);
		}
		next.totalTokens = next.input + next.output + next.cacheRead + next.cacheWrite;
		if (!Number.isSafeInteger(next.totalTokens)) throw new Error("Anthropic aggregate usage exceeds its size limit");
		const details: UsageDetails = { ...next.details };
		if (value.output_tokens_details != null) {
			if (!isRecord(value.output_tokens_details)) throw new Error("Invalid Anthropic output usage details");
			if (value.output_tokens_details.thinking_tokens != null) {
				details.reasoningTokens = count(value.output_tokens_details.thinking_tokens);
			}
		}
		if (value.cache_creation != null) {
			if (!isRecord(value.cache_creation)) throw new Error("Invalid Anthropic cache usage details");
			const windows = new Map(details.cacheWriteWindows?.map((window) => [window.ttlSeconds, window.tokens]));
			for (const [key, ttlSeconds] of [
				["ephemeral_5m_input_tokens", 300],
				["ephemeral_1h_input_tokens", 3600],
			] as const) {
				if (value.cache_creation[key] != null) windows.set(ttlSeconds, count(value.cache_creation[key]));
			}
			details.cacheWriteWindows = [...windows].map(([ttlSeconds, tokens]) => ({ ttlSeconds, tokens }));
		}
		if (value.server_tool_use != null) {
			if (!isRecord(value.server_tool_use)) throw new Error("Invalid Anthropic server tool usage");
			const requests = { ...details.serverToolRequests };
			for (const [source, target] of [
				["web_search_requests", "webSearch"],
				["web_fetch_requests", "webFetch"],
			] as const) {
				if (value.server_tool_use[source] != null) requests[target] = count(value.server_tool_use[source]);
			}
			details.serverToolRequests = requests;
		}
		for (const [source, target] of [
			["service_tier", "serviceTier"],
			["inference_geo", "inferenceRegion"],
		] as const) {
			if (value[source] == null) continue;
			if (typeof value[source] !== "string" || value[source].length > 100)
				throw new Error("Invalid Anthropic usage identity");
			details[target] = value[source];
		}
		if (Object.keys(details).length > 0) next.details = details;
		const outputReported = this.outputReported || value.output_tokens != null;
		const cacheWriteReported = this.cacheWriteReported || value.cache_creation_input_tokens != null;
		if (outputReported && details.reasoningTokens !== undefined && details.reasoningTokens > next.output)
			throw new Error("Invalid Anthropic reasoning token subtotal");
		if (details.cacheWriteWindows !== undefined) {
			const cached = details.cacheWriteWindows.reduce((sum, window) => sum + window.tokens, 0);
			if (!Number.isSafeInteger(cached) || (cacheWriteReported && cached > next.cacheWrite))
				throw new Error("Invalid Anthropic cache token subtotals");
		}
		const reportedCost = parseProviderReportedCost(value.cost, this.providerReportedCost);
		const providerSuppliedTotal = reportedCost !== undefined;
		if (reportedCost !== undefined) {
			next.cost.total = reportedCost;
		}
		if (!providerSuppliedTotal && details.serviceTier !== undefined && details.serviceTier !== "standard")
			next.cost.estimate = "base-rates";
		else delete next.cost.estimate;
		// Detail counts are inclusive subtotals, never additional tokens or dollar amounts.
		calculateCost(this.model, next, { providerSuppliedTotal });
		Object.assign(this.usage, next);
		this.providerReportedCost = reportedCost;
		this.outputReported = outputReported;
		this.cacheWriteReported = cacheWriteReported;
	}
}
