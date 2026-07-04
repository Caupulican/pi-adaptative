import { type AssistantMessage, type FauxResponseFactory, fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { setStreamIdleOptionsForTests } from "../../src/core/agent-session.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

/**
 * Wiring test for the stream-idle watchdog (Plan 2, Task 4). The watchdog's own phase behaviour
 * is unit-tested in packages/agent/test/reliability/stream-idle.test.ts; here we prove only that
 * AgentSession installs it around the provider stream and that a stall routes into the existing
 * auto-retry path instead of wedging the turn forever.
 */
describe("stream-idle watchdog wiring", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		setStreamIdleOptionsForTests(undefined);
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	// A provider stream that connects, emits no events, and stays silent until the watchdog aborts
	// it. Resolving on the abort signal (as real providers do) keeps the faux run from leaking; with
	// the wiring absent nothing ever aborts it, so the turn hangs and the test times out.
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

	it("a stalled provider stream aborts into an auto-retry instead of hanging", async () => {
		// Tight bounds so the wired watchdog fires within the test. Set BEFORE the session is
		// constructed — the wiring reads the override once, in the constructor.
		setStreamIdleOptionsForTests({ idleMs: 300, connectMs: 300 });

		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([hangUntilAborted, fauxAssistantMessage("recovered after stall")]);

		await harness.session.prompt("test");

		// The stall surfaced as a retryable "stream stalled" error and the session auto-retried
		// onto the healthy second call rather than hanging on the dead stream.
		const retries = harness.eventsOfType("auto_retry_start");
		expect(retries.length).toBeGreaterThanOrEqual(1);
		expect(retries[0].errorMessage).toMatch(/stream stalled/);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toContain(true);
		expect(harness.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(harness)).toContain("recovered after stall");
	}, 5000);
});
