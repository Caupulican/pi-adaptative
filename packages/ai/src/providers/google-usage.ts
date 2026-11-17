import type { GenerateContentResponseUsageMetadata } from "@google/genai";
import type { Usage, UsageBillableUnits, UsageDetails } from "../types.ts";
import { createEmptyUsage } from "../usage.ts";
import { isRecord } from "../utils/value-guards.ts";

export type GoogleUsageMetadata = GenerateContentResponseUsageMetadata & {
	billablePromptUsage?: UsageBillableUnits;
	billableCachedContentUsage?: UsageBillableUnits;
	toolCallStats?: { functionName?: string; toolCallCount?: number; serverExecuted?: boolean }[];
};

const TOKEN_FIELDS = [
	"promptTokenCount",
	"candidatesTokenCount",
	"thoughtsTokenCount",
	"cachedContentTokenCount",
	"toolUsePromptTokenCount",
	"totalTokenCount",
] as const;
const MODALITY_FIELDS = [
	"promptTokensDetails",
	"cacheTokensDetails",
	"candidatesTokensDetails",
	"toolUsePromptTokensDetails",
] as const;

function safeInteger(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("Invalid Google token or unit count");
	return value;
}

function count(value: unknown): number {
	const numeric = safeInteger(value);
	if (numeric < 0) throw new Error("Invalid Google token or unit count");
	return numeric;
}

/** Like the native AGY usage mapping, a negative token count reads as zero. */
function tokenCount(value: unknown): number {
	return Math.max(0, safeInteger(value));
}

/** How one transport's usage scalars become aggregate counts. */
export interface GoogleUsageAccounting {
	/** Whether the tool-use prompt count is billed as input beside the prompt count. */
	toolUsePromptIsInput: boolean;
}

/** Gemini API and Vertex report the tool-use prompt inside `totalTokenCount` and bill it as input. */
export const GEMINI_API_USAGE_ACCOUNTING: GoogleUsageAccounting = Object.freeze({ toolUsePromptIsInput: true });

/** AGY's native usage mapping never reads the tool-use prompt count into input or the total. */
export const ANTIGRAVITY_USAGE_ACCOUNTING: GoogleUsageAccounting = Object.freeze({ toolUsePromptIsInput: false });

function list(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > 200) throw new Error("Invalid Google usage detail list");
	return value;
}

/** Merge cumulative snapshots fieldwise; an optional usage-only event must not erase prior counts. */
export function mergeGoogleUsage(previous: GoogleUsageMetadata | undefined, value: unknown): GoogleUsageMetadata {
	if (!isRecord(value)) throw new Error("Invalid Google usage metadata");
	const next: GoogleUsageMetadata = { ...previous };
	for (const key of TOKEN_FIELDS) if (value[key] !== undefined) next[key] = tokenCount(value[key]);
	for (const key of MODALITY_FIELDS) {
		if (value[key] === undefined) continue;
		next[key] = list(value[key]).map((entry) => {
			if (!isRecord(entry)) throw new Error("Invalid Google modality usage");
			if (entry.modality !== undefined && (typeof entry.modality !== "string" || entry.modality.length > 100))
				throw new Error("Invalid Google modality");
			return {
				modality: entry.modality as NonNullable<GoogleUsageMetadata[typeof key]>[number]["modality"],
				tokenCount: entry.tokenCount === undefined ? 0 : tokenCount(entry.tokenCount),
			};
		});
	}
	if (value.trafficType !== undefined) {
		if (typeof value.trafficType !== "string" || value.trafficType.length > 100)
			throw new Error("Invalid Google usage traffic type");
		next.trafficType = value.trafficType as GoogleUsageMetadata["trafficType"];
	}
	for (const key of ["billablePromptUsage", "billableCachedContentUsage"] as const) {
		if (value[key] === undefined) continue;
		const raw = value[key];
		if (!isRecord(raw)) throw new Error("Invalid Google billable usage");
		const units: UsageBillableUnits = {};
		for (const unit of ["textCount", "imageCount", "videoDurationSeconds", "audioDurationSeconds"] as const) {
			if (raw[unit] === undefined) continue;
			const numeric = raw[unit];
			if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0)
				throw new Error("Invalid Google billable units");
			// Native BillablleUsage encodes all four fields as int32, including whole-second durations.
			units[unit] = count(numeric);
		}
		next[key] = units;
	}
	if (value.toolCallStats !== undefined) {
		next.toolCallStats = list(value.toolCallStats).map((entry) => {
			if (
				!isRecord(entry) ||
				(entry.functionName !== undefined &&
					(typeof entry.functionName !== "string" || entry.functionName.length > 4096)) ||
				(entry.serverExecuted !== undefined && typeof entry.serverExecuted !== "boolean")
			)
				throw new Error("Invalid Google tool call usage");
			return {
				functionName: entry.functionName as string | undefined,
				toolCallCount: entry.toolCallCount === undefined ? 0 : count(entry.toolCallCount),
				serverExecuted: entry.serverExecuted === true,
			};
		});
	}
	return next;
}

/**
 * Details are subtotals. Only the six scalar counts participate in aggregate accounting.
 * The cached count may exceed the prompt count on the wire; like the native client's usage
 * mapping, uncached input floors at zero and the cached count is kept as reported.
 */
export function projectGoogleUsage(
	metadata: GoogleUsageMetadata,
	credits: UsageDetails = {},
	accounting: GoogleUsageAccounting = GEMINI_API_USAGE_ACCOUNTING,
): Usage {
	const usage = createEmptyUsage();
	usage.cacheRead = metadata.cachedContentTokenCount ?? 0;
	usage.input =
		Math.max(0, (metadata.promptTokenCount ?? 0) - usage.cacheRead) +
		(accounting.toolUsePromptIsInput ? (metadata.toolUsePromptTokenCount ?? 0) : 0);
	usage.output = (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0);
	usage.totalTokens = metadata.totalTokenCount ?? usage.input + usage.output + usage.cacheRead;
	if (![usage.input, usage.output, usage.totalTokens].every(Number.isSafeInteger))
		throw new Error("Google aggregate usage exceeds the safe integer limit");
	const details: UsageDetails = { ...credits };
	for (const [source, target] of [
		["promptTokenCount", "promptTokens"],
		["candidatesTokenCount", "answerTokens"],
		["thoughtsTokenCount", "reasoningTokens"],
		["toolUsePromptTokenCount", "toolPromptTokens"],
	] as const) {
		if (metadata[source] !== undefined) details[target] = metadata[source];
	}
	for (const [source, target] of [
		["promptTokensDetails", "promptModalities"],
		["cacheTokensDetails", "cacheModalities"],
		["candidatesTokensDetails", "answerModalities"],
		["toolUsePromptTokensDetails", "toolPromptModalities"],
	] as const) {
		if (metadata[source] !== undefined)
			details[target] = metadata[source].map((entry) => ({
				...(entry.modality !== undefined ? { modality: entry.modality } : {}),
				tokens: entry.tokenCount ?? 0,
			}));
	}
	if (metadata.trafficType !== undefined) details.trafficType = metadata.trafficType;
	if (metadata.billablePromptUsage !== undefined) details.billablePrompt = metadata.billablePromptUsage;
	if (metadata.billableCachedContentUsage !== undefined) details.billableCache = metadata.billableCachedContentUsage;
	if (metadata.toolCallStats !== undefined)
		details.toolCalls = metadata.toolCallStats.map((entry) => ({
			functionName: entry.functionName,
			count: entry.toolCallCount ?? 0,
			serverExecuted: entry.serverExecuted === true,
		}));
	usage.details = details;
	return usage;
}
