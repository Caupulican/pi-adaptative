import { afterEach, describe, expect, it, vi } from "vitest";
import type { IsolatedCompletionResult } from "../src/core/agent-session-contracts.ts";
import { runProviderCompletionWithBackoff } from "../src/core/delegation/worker-attempt-executor.ts";

const COMPLETION = { text: "ok" } as IsolatedCompletionResult;

function harness(failures: unknown[], options: { signal?: AbortSignal } = {}) {
	let calls = 0;
	const warnings: string[] = [];
	const released: number[] = [];
	const run = runProviderCompletionWithBackoff({
		attempt: () => {
			calls += 1;
			const failure = failures[calls - 1];
			if (failure !== undefined) return Promise.reject(failure);
			return Promise.resolve(COMPLETION);
		},
		onAttemptFailure: () => released.push(calls),
		provider: "openai-codex",
		laneId: "lane-1",
		warn: (message) => warnings.push(message),
		...(options.signal ? { signal: options.signal } : {}),
	});
	return { run, warnings, released, calls: () => calls };
}

describe("worker provider backoff", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries a transient network failure with backoff and then succeeds", async () => {
		vi.useFakeTimers();
		const { run, warnings, released, calls } = harness([new Error("WebSocket error")]);
		await vi.advanceTimersByTimeAsync(3_000);
		await expect(run).resolves.toBe(COMPLETION);
		expect(calls()).toBe(2);
		expect(released).toEqual([1]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("network");
		expect(warnings[0]).toContain("attempt 2/3");
	});

	it("rethrows non-retryable failures immediately without sleeping", async () => {
		const failure = new Error("401 unauthorized: invalid api key");
		const { run, warnings, released, calls } = harness([failure]);
		await expect(run).rejects.toBe(failure);
		expect(calls()).toBe(1);
		expect(released).toEqual([1]);
		expect(warnings).toHaveLength(0);
	});

	it("gives up after the attempt ceiling and rethrows the final failure", async () => {
		vi.useFakeTimers();
		const failures = [new Error("fetch failed"), new Error("fetch failed"), new Error("socket hang up")];
		const { run, warnings, calls } = harness(failures);
		const settled = expect(run).rejects.toBe(failures[2]);
		await vi.advanceTimersByTimeAsync(60_000);
		await settled;
		expect(calls()).toBe(3);
		expect(warnings).toHaveLength(2);
	});

	it("does not retry once the abort signal fired", async () => {
		const controller = new AbortController();
		controller.abort();
		const failure = new Error("connection lost");
		const { run, calls } = harness([failure], { signal: controller.signal });
		await expect(run).rejects.toBe(failure);
		expect(calls()).toBe(1);
	});
});
