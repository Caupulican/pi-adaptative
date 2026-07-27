import type { Usage } from "@caupulican/pi-ai";
import { isPlainRecord } from "../util/value-guards.ts";
import type { AttemptUsageSnapshot } from "./contracts.ts";

export const EMPTY_ATTEMPT_USAGE: AttemptUsageSnapshot = {
	toolCalls: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
	activeWallClockMs: 0,
};

/**
 * Validate an untrusted provider-neutral usage report before it reaches durable accounting.
 * Provider totals are authoritative and therefore need not equal the detail field sum.
 */
const PROVIDER_USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
const PROVIDER_USAGE_COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function parseExactDataRecord(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
	if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object.`);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !fields.includes(key))
			throw new TypeError(`${label} contains an unsupported field.`);
	}
	const parsed: Record<string, unknown> = {};
	for (const field of fields) {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		if (!descriptor || !("value" in descriptor)) throw new TypeError(`${label}.${field} must be a data field.`);
		parsed[field] = descriptor.value;
	}
	return parsed;
}

/** Parse an untrusted provider-neutral usage report into a closed, known-field value. */
export function validateProviderUsage(value: unknown, label = "provider usage"): Usage {
	const usage = parseExactDataRecord(value, PROVIDER_USAGE_FIELDS, label);
	const cost = parseExactDataRecord(usage.cost, PROVIDER_USAGE_COST_FIELDS, `${label}.cost`);
	const tokenFields: Array<[string, number]> = [
		["input", usage.input as number],
		["output", usage.output as number],
		["cacheRead", usage.cacheRead as number],
		["cacheWrite", usage.cacheWrite as number],
		["totalTokens", usage.totalTokens as number],
	];
	for (const [field, value] of tokenFields) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(`${label}.${field} must be a non-negative safe integer.`);
		}
	}
	const costFields: Array<[string, number]> = [
		["input", cost.input as number],
		["output", cost.output as number],
		["cacheRead", cost.cacheRead as number],
		["cacheWrite", cost.cacheWrite as number],
		["total", cost.total as number],
	];
	for (const [field, value] of costFields) {
		if (!Number.isFinite(value) || value < 0) {
			throw new Error(`${label}.cost.${field} must be finite and non-negative.`);
		}
	}
	return {
		input: usage.input as number,
		output: usage.output as number,
		cacheRead: usage.cacheRead as number,
		cacheWrite: usage.cacheWrite as number,
		totalTokens: usage.totalTokens as number,
		cost: {
			input: cost.input as number,
			output: cost.output as number,
			cacheRead: cost.cacheRead as number,
			cacheWrite: cost.cacheWrite as number,
			total: cost.total as number,
		},
	};
}

/** Validate the one durable cumulative usage shape shared by checkpoints, recovery, and results. */
export function validateAttemptUsageSnapshot(
	usage: AttemptUsageSnapshot,
	label = "attempt usage",
): AttemptUsageSnapshot {
	if (!Number.isSafeInteger(usage.toolCalls) || usage.toolCalls < 0) {
		throw new Error(`${label}.toolCalls must be a non-negative safe integer.`);
	}
	if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0) {
		throw new Error(`${label}.inputTokens must be a non-negative safe integer.`);
	}
	if (!Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) {
		throw new Error(`${label}.outputTokens must be a non-negative safe integer.`);
	}
	if (!Number.isSafeInteger(usage.cacheReadTokens) || usage.cacheReadTokens < 0) {
		throw new Error(`${label}.cacheReadTokens must be a non-negative safe integer.`);
	}
	if (!Number.isSafeInteger(usage.cacheWriteTokens) || usage.cacheWriteTokens < 0) {
		throw new Error(`${label}.cacheWriteTokens must be a non-negative safe integer.`);
	}
	if (!Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0) {
		throw new Error(`${label}.totalTokens must be a non-negative safe integer.`);
	}
	if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
		throw new Error(`${label}.costUsd must be finite and non-negative.`);
	}
	if (!Number.isFinite(usage.activeWallClockMs) || usage.activeWallClockMs < 0) {
		throw new Error(`${label}.activeWallClockMs must be finite and non-negative.`);
	}
	return structuredClone(usage);
}

export function attemptUsageFromGatewayUsage(usage: {
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	wallClockMs: number;
}): AttemptUsageSnapshot {
	return validateAttemptUsageSnapshot(
		{
			toolCalls: usage.toolCalls,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens,
			cacheWriteTokens: usage.cacheWriteTokens,
			totalTokens: usage.totalTokens,
			costUsd: usage.costUsd,
			activeWallClockMs: usage.wallClockMs,
		},
		"gateway usage",
	);
}

export function addAttemptUsage(
	base: AttemptUsageSnapshot,
	delta: AttemptUsageSnapshot,
	label = "attempt usage",
): AttemptUsageSnapshot {
	validateAttemptUsageSnapshot(base, `${label} base`);
	validateAttemptUsageSnapshot(delta, `${label} delta`);
	return validateAttemptUsageSnapshot(
		{
			toolCalls: base.toolCalls + delta.toolCalls,
			inputTokens: base.inputTokens + delta.inputTokens,
			outputTokens: base.outputTokens + delta.outputTokens,
			cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
			cacheWriteTokens: base.cacheWriteTokens + delta.cacheWriteTokens,
			totalTokens: base.totalTokens + delta.totalTokens,
			costUsd: base.costUsd + delta.costUsd,
			activeWallClockMs: base.activeWallClockMs + delta.activeWallClockMs,
		},
		label,
	);
}

/**
 * Recover the strongest cumulative evidence across an atomic checkpoint and its durable transcript.
 * Both inputs are cumulative views of the same attempt, so summing would double-count; component
 * maxima close append-before-checkpoint crash windows conservatively.
 */
export function reconcileAttemptUsage(
	checkpoint: AttemptUsageSnapshot,
	transcript: AttemptUsageSnapshot,
): AttemptUsageSnapshot {
	validateAttemptUsageSnapshot(checkpoint, "attempt checkpoint usage");
	validateAttemptUsageSnapshot(transcript, "attempt transcript usage");
	return validateAttemptUsageSnapshot({
		toolCalls: Math.max(checkpoint.toolCalls, transcript.toolCalls),
		inputTokens: Math.max(checkpoint.inputTokens, transcript.inputTokens),
		outputTokens: Math.max(checkpoint.outputTokens, transcript.outputTokens),
		cacheReadTokens: Math.max(checkpoint.cacheReadTokens, transcript.cacheReadTokens),
		cacheWriteTokens: Math.max(checkpoint.cacheWriteTokens, transcript.cacheWriteTokens),
		totalTokens: Math.max(checkpoint.totalTokens, transcript.totalTokens),
		costUsd: Math.max(checkpoint.costUsd, transcript.costUsd),
		activeWallClockMs: Math.max(checkpoint.activeWallClockMs, transcript.activeWallClockMs),
	});
}

export function remainingTokenBudget(maxTokens: number | undefined, usage: AttemptUsageSnapshot): number | undefined {
	if (maxTokens === undefined) return undefined;
	const remaining = maxTokens - usage.totalTokens;
	return Math.max(0, remaining);
}

/** Convert durable cumulative accounting into the provider-neutral report shape exactly once. */
export function providerUsageFromAttemptUsage(usage: AttemptUsageSnapshot): Usage {
	const validated = validateAttemptUsageSnapshot(usage);
	return {
		input: validated.inputTokens,
		output: validated.outputTokens,
		cacheRead: validated.cacheReadTokens,
		cacheWrite: validated.cacheWriteTokens,
		totalTokens: validated.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: validated.costUsd },
	};
}
