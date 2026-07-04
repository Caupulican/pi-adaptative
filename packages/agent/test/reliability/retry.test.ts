import { describe, expect, it } from "vitest";
import { computeRetryDelayMs, DEFAULT_RETRY_POLICY, sleepAbortable } from "../../src/reliability/retry.ts";

describe("computeRetryDelayMs", () => {
	it("matches current AgentSession backoff exactly with zero jitter", () => {
		expect(computeRetryDelayMs(DEFAULT_RETRY_POLICY, 1)).toBe(2000);
		expect(computeRetryDelayMs(DEFAULT_RETRY_POLICY, 2)).toBe(4000);
		expect(computeRetryDelayMs(DEFAULT_RETRY_POLICY, 3)).toBe(8000);
	});

	it("caps at maxDelayMs", () => {
		const policy = { maxAttempts: 10, baseDelayMs: 2000, maxDelayMs: 10_000, jitterRatio: 0 };
		expect(computeRetryDelayMs(policy, 6)).toBe(10_000);
	});

	it("applies bounded jitter deterministically via injected random", () => {
		const policy = { ...DEFAULT_RETRY_POLICY, jitterRatio: 0.5 };
		expect(computeRetryDelayMs(policy, 1, { random: () => 0 })).toBe(2000);
		expect(computeRetryDelayMs(policy, 1, { random: () => 1 })).toBe(3000); // 2000 + 0.5*2000*1
	});

	it("prefers a provider retry-after hint, still capped", () => {
		expect(computeRetryDelayMs(DEFAULT_RETRY_POLICY, 1, { retryAfterMs: 15_000 })).toBe(15_000);
		expect(computeRetryDelayMs(DEFAULT_RETRY_POLICY, 1, { retryAfterMs: 500_000 })).toBe(120_000);
	});
});

describe("sleepAbortable", () => {
	it("resolves after the delay", async () => {
		const start = Date.now();
		await sleepAbortable(20);
		expect(Date.now() - start).toBeGreaterThanOrEqual(15);
	});

	it("rejects promptly on abort and clears the timer", async () => {
		const ac = new AbortController();
		const p = sleepAbortable(60_000, ac.signal);
		ac.abort();
		await expect(p).rejects.toThrow();
	});

	it("rejects immediately for an already-aborted signal", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(sleepAbortable(60_000, ac.signal)).rejects.toThrow();
	});
});
