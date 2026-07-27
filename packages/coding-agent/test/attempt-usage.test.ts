import { describe, expect, it } from "vitest";
import {
	providerUsageFromAttemptUsage,
	reconcileAttemptUsage,
	remainingTokenBudget,
	validateProviderUsage,
} from "../src/core/orchestration/attempt-usage.ts";
import type { AttemptUsageSnapshot } from "../src/core/orchestration/contracts.ts";

function usage(overrides: Partial<AttemptUsageSnapshot> = {}): AttemptUsageSnapshot {
	return {
		toolCalls: 1,
		inputTokens: 2,
		outputTokens: 3,
		cacheReadTokens: 5,
		cacheWriteTokens: 7,
		totalTokens: 17,
		costUsd: 0.25,
		activeWallClockMs: 100,
		...overrides,
	};
}

describe("durable attempt usage", () => {
	it("preserves provider cache categories and authoritative totals", () => {
		expect(providerUsageFromAttemptUsage(usage())).toEqual({
			input: 2,
			output: 3,
			cacheRead: 5,
			cacheWrite: 7,
			totalTokens: 17,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
		});
		expect(remainingTokenBudget(20, usage())).toBe(3);
	});

	it("reconciles a checkpoint with later transcript evidence without double-counting", () => {
		const checkpoint = usage({
			toolCalls: 4,
			inputTokens: 20,
			outputTokens: 10,
			cacheReadTokens: 8,
			cacheWriteTokens: 2,
			totalTokens: 40,
			costUsd: 1,
			activeWallClockMs: 500,
		});
		const transcript = usage({
			toolCalls: 5,
			inputTokens: 23,
			outputTokens: 10,
			cacheReadTokens: 9,
			cacheWriteTokens: 2,
			totalTokens: 44,
			costUsd: 1.1,
			activeWallClockMs: 0,
		});

		expect(reconcileAttemptUsage(checkpoint, transcript)).toEqual({
			...transcript,
			activeWallClockMs: 500,
		});
	});

	it("rejects non-finite costs and non-integer provider token claims before durable accounting", () => {
		expect(() =>
			validateProviderUsage({
				input: 1,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.POSITIVE_INFINITY },
			}),
		).toThrow("provider usage.cost.total must be finite and non-negative.");
		expect(() =>
			validateProviderUsage({
				input: 1.5,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			}),
		).toThrow("provider usage.input must be a non-negative safe integer.");
	});

	it("rejects unknown enumerable getters without invoking them or cloning their values", () => {
		let invoked = false;
		const usage = {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		Object.defineProperty(usage, "unexpected", {
			enumerable: true,
			get: () => {
				invoked = true;
				return "unbounded";
			},
		});

		expect(() => validateProviderUsage(usage)).toThrow("provider usage contains an unsupported field.");
		expect(invoked).toBe(false);
	});
});
