import { type AssistantMessage, createEmptyUsage } from "@caupulican/pi-ai";
import { expect, it, vi } from "vitest";
import {
	DEFAULT_RETRY_POLICY,
	type RetryBackoffEnd,
	RetryController,
	type RetryControllerPolicy,
} from "../src/kernel/reliability/index.ts";

const stall: AssistantMessage = {
	role: "assistant",
	api: "openai-responses",
	provider: "xai",
	model: "grok",
	content: [{ type: "thinking", thinking: " " }],
	usage: createEmptyUsage(),
	stopReason: "error",
	errorMessage: "Stream stalled",
	timestamp: 1,
};

function fixture(policy: Partial<RetryControllerPolicy> = {}) {
	const agent = { state: { messages: [stall] } };
	const events = { onRetryStart: vi.fn(), onRetryEnd: vi.fn() };
	const backoff = vi.fn(async (): Promise<RetryBackoffEnd> => "elapsed");
	const retry = new RetryController(
		agent,
		() => ({ ...DEFAULT_RETRY_POLICY, enabled: true, ...policy }),
		events,
		() => 100_000,
		backoff,
	);
	return { agent, events, backoff, retry };
}

it("releases the retry window when its start callback throws", async () => {
	const { agent, events, backoff, retry } = fixture();
	const failure = new Error("Retry start receipt failed");
	events.onRetryStart.mockImplementationOnce(() => {
		expect(retry.isRetrying).toBe(true);
		throw failure;
	});

	await expect(retry.prepareRetry(stall)).rejects.toBe(failure);
	expect(retry.isRetrying).toBe(false);
	expect(retry.attempt).toBe(1);
	expect(agent.state.messages).toEqual([stall]);
	expect(backoff).not.toHaveBeenCalled();
	expect(events.onRetryEnd).not.toHaveBeenCalled();

	retry.reset();
	await expect(retry.prepareRetry(stall)).resolves.toBe(true);
	expect(backoff).toHaveBeenCalledOnce();
});

it("shares the xAI stall cap between preview and execution without sampling jitter on preview", async () => {
	const { events, backoff, retry } = fixture({ jitterRatio: 0.5 });
	const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
	try {
		expect(retry.canRetry(stall)).toBe(true);
		expect(retry.attempt).toBe(0);
		expect(events.onRetryStart).not.toHaveBeenCalled();
		expect(random).not.toHaveBeenCalled();

		await expect(retry.prepareRetry(stall)).resolves.toBe(true);
		expect(events.onRetryStart).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 1, delayMs: 2500 }));
		expect(retry.canRetry(stall)).toBe(false);
		await expect(retry.prepareRetry(stall)).resolves.toBe(false);
		expect(backoff).toHaveBeenCalledOnce();
		expect(random).toHaveBeenCalledOnce();

		const progressed: AssistantMessage = { ...stall, content: [{ type: "text", text: "Partial response" }] };
		expect(retry.canRetry(progressed)).toBe(true);
	} finally {
		random.mockRestore();
	}
});

it("honors the provider retry-after cap in preview and execution", async () => {
	const { backoff, retry } = fixture({ maxRetryAfterMs: 1_000 });
	const rateLimited = { ...stall, errorMessage: "Rate limit: retry after 2 seconds" };
	expect(retry.canRetry(rateLimited)).toBe(false);
	await expect(retry.prepareRetry(rateLimited)).resolves.toBe(false);
	expect(backoff).not.toHaveBeenCalled();
	expect(retry.attempt).toBe(0);

	const withinCap = { ...rateLimited, errorMessage: "Rate limit: retry after 1 second" };
	expect(retry.canRetry(withinCap)).toBe(true);
	await expect(retry.prepareRetry(withinCap)).resolves.toBe(true);
	expect(backoff).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
});
