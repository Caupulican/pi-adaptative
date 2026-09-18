import { createAssistantMessageEventStream, fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./suite/harness.ts";

describe("tree-summary charges before a raw transport failure", () => {
	it.each(["throws", "succeeds"] as const)("retains each charge once when a retry %s", async (outcome) => {
		const harness = await createHarness();
		vi.useFakeTimers();
		try {
			const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
			harness.sessionManager.appendMessage({ role: "user", content: "Second", timestamp: 2 });
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			const messages = harness.session.agent.state.messages;
			const failure = new Error("Retry transport failed");
			let calls = 0;
			harness.session.agent.streamFn = () => {
				calls++;
				if (calls === 2 && outcome === "throws") throw failure;
				const reason = calls === 1 ? "error" : "stop";
				const message = fauxAssistantMessage("Summary", {
					stopReason: reason,
					errorMessage: "429 rate limited. Please try again in 1.5s.",
				});
				message.usage = {
					input: 10,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11,
					cost: { input: 0.01, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.011 },
				};
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() =>
					stream.push(
						reason === "error" ? { type: "error", reason, error: message } : { type: "done", reason, message },
					),
				);
				return stream;
			};
			const pending = harness.session.navigateTree(target, { summarize: true });
			const observed = pending.then(
				(result) => ({ result }),
				(error: unknown) => ({ error }),
			);
			await vi.advanceTimersByTimeAsync(2_000);
			const settled = await observed;
			expect(calls).toBe(2);
			if (outcome === "throws") {
				expect("error" in settled).toBe(true);
				if (!("error" in settled)) throw new Error("Expected the original transport rejection");
				expect(settled.error).toBe(failure);
				expect(harness.session.agent.state.messages).toBe(messages);
				expect(harness.sessionManager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(false);
			} else {
				expect(settled).toMatchObject({
					result: { cancelled: false, summaryEntry: { summary: expect.any(String) } },
				});
			}
			const factor = outcome === "throws" ? 1 : 2;
			expect(harness.session.getCumulativeUsage().totalTokens).toBe(11 * factor);
			expect(harness.session.getCumulativeUsage().cost.total).toBeCloseTo(0.011 * factor, 10);
			expect(harness.session.getSpawnedUsage().reports).toBe(outcome === "throws" ? 1 : 0);
			expect(harness.session.isCompacting).toBe(false);
		} finally {
			vi.useRealTimers();
			await harness.cleanup();
		}
	});
});
