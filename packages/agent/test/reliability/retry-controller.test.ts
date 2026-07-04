import { type AssistantMessage, fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { computeRetryDelayMs, DEFAULT_RETRY_POLICY, type RetryPolicy } from "../../src/reliability/retry.ts";
import { RetryController, type RetryEndInfo, type RetryStartInfo } from "../../src/reliability/retry-controller.ts";
import type { AgentMessage } from "../../src/types.ts";

const errorMessage = (text: string): AssistantMessage =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: text });

function setup(opts?: {
	messages?: AgentMessage[];
	policy?: Partial<RetryPolicy & { enabled: boolean }>;
	contextWindow?: number;
}) {
	const agent = { state: { messages: opts?.messages ?? [] } };
	const startInfos: RetryStartInfo[] = [];
	const endInfos: RetryEndInfo[] = [];
	const policy: RetryPolicy & { enabled: boolean } = {
		enabled: true,
		maxAttempts: 3,
		baseDelayMs: 4,
		maxDelayMs: 120_000,
		jitterRatio: 0,
		...opts?.policy,
	};
	const controller = new RetryController(
		agent,
		() => policy,
		{ onRetryStart: (info) => startInfos.push(info), onRetryEnd: (info) => endInfos.push(info) },
		() => opts?.contextWindow ?? 200_000,
	);
	return { agent, controller, startInfos, endInfos, policy };
}

describe("RetryController", () => {
	it("retryable error: emits start, pops the trailing assistant error, resolves true", async () => {
		const prior: AgentMessage = { role: "user", content: "do it", timestamp: Date.now() };
		const failure = errorMessage("overloaded_error");
		const { agent, controller, startInfos, endInfos } = setup({ messages: [prior, failure] });

		const ok = await controller.prepareRetry(failure);

		expect(ok).toBe(true);
		expect(controller.attempt).toBe(1);
		expect(startInfos).toEqual([{ attempt: 1, maxAttempts: 3, delayMs: 4, errorMessage: "overloaded_error" }]);
		expect(endInfos).toEqual([]);
		// Only the trailing assistant error is removed from live agent state.
		expect(agent.state.messages).toEqual([prior]);
		// The retry window is closed again once the backoff resolves.
		expect(controller.isRetrying).toBe(false);
	});

	it("marks isRetrying true from inside onRetryStart until the backoff resolves", async () => {
		const failure = errorMessage("overloaded_error");
		const agent = { state: { messages: [failure] as AgentMessage[] } };
		let retryingInStart: boolean | undefined;
		let controller!: RetryController;
		controller = new RetryController(
			agent,
			() => ({ enabled: true, maxAttempts: 3, baseDelayMs: 4, maxDelayMs: 120_000, jitterRatio: 0 }),
			{
				onRetryStart: () => {
					retryingInStart = controller.isRetrying;
				},
				onRetryEnd: () => {},
			},
			() => 200_000,
		);

		const ok = await controller.prepareRetry(failure);

		expect(retryingInStart).toBe(true);
		expect(ok).toBe(true);
		expect(controller.isRetrying).toBe(false);
	});

	it("non-retryable error: resolves false without emitting, mutating state, or consuming an attempt", async () => {
		const failure = errorMessage("the model declined to answer");
		const { agent, controller, startInfos, endInfos } = setup({ messages: [failure] });

		const ok = await controller.prepareRetry(failure);

		expect(ok).toBe(false);
		expect(controller.attempt).toBe(0);
		expect(startInfos).toEqual([]);
		expect(endInfos).toEqual([]);
		expect(agent.state.messages).toEqual([failure]);
	});

	it("does not retry billing/quota failures", async () => {
		const failure = errorMessage("insufficient_quota");
		const { controller } = setup({ messages: [failure] });
		expect(await controller.prepareRetry(failure)).toBe(false);
	});

	it("does not retry context-overflow failures (routed to compaction, not retry)", async () => {
		const failure = errorMessage("prompt is too long: 213462 tokens > 200000 maximum");
		const { controller } = setup({ messages: [failure] });
		expect(await controller.prepareRetry(failure)).toBe(false);
	});

	it("feeds the attempt number into the policy backoff: successive delays double", async () => {
		const failure = errorMessage("overloaded_error");
		const { controller, startInfos } = setup({ messages: [failure], policy: { maxAttempts: 3, baseDelayMs: 4 } });

		await controller.prepareRetry(failure);
		await controller.prepareRetry(failure);
		await controller.prepareRetry(failure);

		expect(startInfos.map((info) => info.delayMs)).toEqual([4, 8, 16]);
		// Same shape the default policy produces at production scale.
		expect([1, 2, 3].map((attempt) => computeRetryDelayMs(DEFAULT_RETRY_POLICY, attempt))).toEqual([
			2000, 4000, 8000,
		]);
	});

	it("exhaustion: resolves false and preserves the attempt count for the final failure emit", async () => {
		const failure = errorMessage("overloaded_error");
		const { controller, startInfos } = setup({ messages: [failure], policy: { maxAttempts: 2, baseDelayMs: 2 } });

		expect(await controller.prepareRetry(failure)).toBe(true); // attempt 1
		expect(await controller.prepareRetry(failure)).toBe(true); // attempt 2
		const ok = await controller.prepareRetry(failure); // would be attempt 3 > max 2

		expect(ok).toBe(false);
		expect(controller.attempt).toBe(2); // preserved, not reset
		expect(startInfos.map((info) => info.attempt)).toEqual([1, 2]); // no third start
	});

	it("abort during backoff: emits onRetryEnd(cancelled), resets the counter, resolves false", async () => {
		const failure = errorMessage("overloaded_error");
		const { controller, startInfos, endInfos } = setup({ messages: [failure], policy: { baseDelayMs: 10_000 } });

		const pending = controller.prepareRetry(failure);
		// onRetryStart and the abort-controller wiring run synchronously before the first await,
		// so the sleep is already in flight here.
		controller.abort();
		const ok = await pending;

		expect(ok).toBe(false);
		expect(startInfos).toHaveLength(1);
		expect(endInfos).toEqual([{ success: false, attempt: 1, finalError: "Retry cancelled" }]);
		expect(controller.attempt).toBe(0);
		expect(controller.isRetrying).toBe(false);
	});

	it("returns false without side effects when retry is disabled", async () => {
		const failure = errorMessage("overloaded_error");
		const { agent, controller, startInfos } = setup({ messages: [failure], policy: { enabled: false } });

		const ok = await controller.prepareRetry(failure);

		expect(ok).toBe(false);
		expect(controller.attempt).toBe(0);
		expect(startInfos).toEqual([]);
		expect(agent.state.messages).toEqual([failure]);
	});

	it("reset() returns the attempt counter to zero", async () => {
		const failure = errorMessage("overloaded_error");
		const { controller } = setup({ messages: [failure] });

		await controller.prepareRetry(failure);
		expect(controller.attempt).toBe(1);
		controller.reset();
		expect(controller.attempt).toBe(0);
	});
});
