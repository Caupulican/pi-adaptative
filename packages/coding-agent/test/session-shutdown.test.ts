import { expect, it, vi } from "vitest";
import { CLOSING_RUN_SETTLE_MS, settleClosingSessionMemory } from "../src/core/session-shutdown.ts";

it("shares the quit grace across stalled producers and still closes the consumers", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	try {
		const stalled = new Promise<void>(() => {});
		const holdLateWork = vi.fn();
		const holdWarning = vi.fn();
		const shutdownMemory = vi.fn(async () => {});
		const disposeSemanticUsage = vi.fn();
		const closing = settleClosingSessionMemory({
			waitForAgentIdle: () => stalled,
			settleReflectionTurn: () => stalled,
			settleCompaction: async () => {},
			settleOwnerGoalIntent: () => stalled,
			settleRoutineIntake: async () => {},
			releaseAgentConsumer: () => {},
			holdLateWork,
			holdWarning,
			shutdownMemory,
			disposeSemanticUsage,
		});
		// Allow the immediate timers reached once the shared grace expires.
		await vi.advanceTimersByTimeAsync(CLOSING_RUN_SETTLE_MS + 5);
		expect(shutdownMemory).toHaveBeenCalledOnce();
		await closing;
		expect(holdLateWork).toHaveBeenCalledTimes(3);
		expect(holdWarning).toHaveBeenCalledTimes(3);
		expect(disposeSemanticUsage).toHaveBeenCalledOnce();
	} finally {
		vi.useRealTimers();
	}
});
