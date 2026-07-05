import { type AssistantMessage, type FauxResponseFactory, fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { setStreamIdleOptionsForTests } from "../../src/core/agent-session.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Compaction-path counterpart of stream-stall-retry.test.ts: a summarization request that
 * stalls must be retried per the reliability classification (stream_stall is retryable)
 * instead of failing the whole compaction on the first transient.
 */
describe("compaction stall retry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		setStreamIdleOptionsForTests(undefined);
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	// A provider stream that connects, emits no events, and stays silent until the watchdog
	// aborts it (same shape as stream-stall-retry.test.ts).
	const hangUntilAborted: FauxResponseFactory = (_context, options) =>
		new Promise<AssistantMessage>((resolve) => {
			const finish = () =>
				resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" }));
			if (options?.signal?.aborted) {
				finish();
				return;
			}
			options?.signal?.addEventListener("abort", finish, { once: true });
		});

	it("a stalled summarization is retried and the compaction completes", async () => {
		setStreamIdleOptionsForTests({ connectMs: 300, activeIdleMs: 300, quietIdleMs: 300 });
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		// Queue for the compaction's summarization calls: first stalls, second recovers.
		harness.setResponses([hangUntilAborted, fauxAssistantMessage("recovered summary")]);

		const result = await harness.session.compact();
		expect(result.summary).toBe("recovered summary");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	}, 5000);

	it("exhausted retries still surface the stall error", async () => {
		setStreamIdleOptionsForTests({ connectMs: 200, activeIdleMs: 200, quietIdleMs: 200 });
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		harness.setResponses([hangUntilAborted, hangUntilAborted]);

		await expect(harness.session.compact()).rejects.toThrow(/stream stalled/);
	}, 5000);
});
