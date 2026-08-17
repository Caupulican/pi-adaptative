import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IsolatedCompletionResult } from "../src/core/agent-session-contracts.ts";
import { BoundedCompletionFailureError } from "../src/core/autonomy/bounded-completion.ts";
import { runProviderCompletionWithBackoff } from "../src/core/delegation/worker-attempt-executor.ts";
import { WorkerConversationOwnershipError } from "../src/core/delegation/worker-conversation-revision.ts";
import { WorkerCompletionProtocolError } from "../src/core/delegation/worker-provider-turn-protocol.ts";
import { WorkerTreeBudgetExceededError } from "../src/core/delegation/worker-tree-budget-coordinator.ts";
import { CapabilityGatewayDeniedError } from "../src/core/orchestration/capability-gateway.ts";

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

	it("retries a returned overloaded provider completion and then succeeds", async () => {
		vi.useFakeTimers();
		const overloaded = {
			text: "",
			stopReason: "error",
			errorMessage: "Provider service overloaded; try again later",
			messages: [
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider service overloaded; try again later",
				}),
			],
		} as IsolatedCompletionResult;
		const attempt = vi
			.fn<() => Promise<IsolatedCompletionResult>>()
			.mockResolvedValueOnce(overloaded)
			.mockResolvedValueOnce(COMPLETION);
		const warnings: string[] = [];
		const run = runProviderCompletionWithBackoff({
			attempt,
			onAttemptFailure: vi.fn(),
			provider: "faux",
			laneId: "lane-1",
			warn: (message) => warnings.push(message),
		});

		await vi.advanceTimersByTimeAsync(3_000);

		await expect(run).resolves.toBe(COMPLETION);
		expect(attempt).toHaveBeenCalledTimes(2);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("overloaded");
	});

	it("rethrows non-retryable failures immediately without sleeping, wrapped with the original error preserved as cause", async () => {
		const failure = new Error("401 unauthorized: invalid api key");
		const { run, warnings, released, calls } = harness([failure]);
		const caught = await run.catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(BoundedCompletionFailureError);
		const wrapped = caught as BoundedCompletionFailureError;
		expect(wrapped.name).toBe("BoundedCompletionFailureError");
		expect(wrapped.status).toBe("failed");
		expect(wrapped.reasonCode).toBe("completion_error");
		expect(wrapped.message).toBe(failure.message);
		expect(wrapped.cause).toBe(failure);
		expect(calls()).toBe(1);
		expect(released).toEqual([1]);
		expect(warnings).toHaveLength(0);
	});

	it("never retries an ownership failure even when its message resembles a transient transport error", async () => {
		const failure = new WorkerConversationOwnershipError("WebSocket error");
		const { run, warnings, released, calls } = harness([failure]);
		await expect(run).rejects.toBe(failure);
		expect(calls()).toBe(1);
		expect(released).toEqual([1]);
		expect(warnings).toHaveLength(0);
	});

	it("classifies a worker completion protocol violation separately from provider failures", async () => {
		const failure = new WorkerCompletionProtocolError("provider reservation provenance mismatch");
		const { run, warnings, released, calls } = harness([failure]);
		const caught = await run.catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(BoundedCompletionFailureError);
		const wrapped = caught as BoundedCompletionFailureError;
		expect(wrapped.status).toBe("failed");
		expect(wrapped.reasonCode).toBe("worker_protocol_error");
		expect(wrapped.cause).toBe(failure);
		expect(calls()).toBe(1);
		expect(released).toEqual([1]);
		expect(warnings).toHaveLength(0);
	});

	it("never retries provider authority failures", async () => {
		const failures = [
			new CapabilityGatewayDeniedError("token_budget_exhausted", "WebSocket error"),
			new WorkerTreeBudgetExceededError("maxTokens", "provider completion"),
		];
		for (const failure of failures) {
			const { run, warnings, released, calls } = harness([failure]);
			await expect(run).rejects.toBe(failure);
			expect(calls()).toBe(1);
			expect(released).toEqual([1]);
			expect(warnings).toHaveLength(0);
		}
	});

	it("gives up after the attempt ceiling and rethrows the final failure, wrapped with the original error preserved as cause", async () => {
		vi.useFakeTimers();
		const failures = [new Error("fetch failed"), new Error("fetch failed"), new Error("socket hang up")];
		const { run, warnings, calls } = harness(failures);
		const settled = run.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(60_000);
		const caught = await settled;
		expect(caught).toBeInstanceOf(BoundedCompletionFailureError);
		const wrapped = caught as BoundedCompletionFailureError;
		expect(wrapped.name).toBe("BoundedCompletionFailureError");
		expect(wrapped.status).toBe("failed");
		expect(wrapped.reasonCode).toBe("completion_error");
		expect(wrapped.message).toBe(failures[2].message);
		expect(wrapped.cause).toBe(failures[2]);
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
