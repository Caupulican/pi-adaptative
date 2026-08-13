import { describe, expect, it, vi } from "vitest";
import { DurableCustomMessageTurnController } from "../src/core/durable-custom-message-turn-controller.ts";
import type {
	ForegroundRecoveryController,
	ForegroundSubmissionLease,
} from "../src/core/foreground-recovery-controller.ts";
import type { GoalExecutionLease } from "../src/core/goals/goal-session-controller.ts";

const submissionLease = {} as ForegroundSubmissionLease;

describe("DurableCustomMessageTurnController", () => {
	it("releases the goal execution lease once the run completes normally", async () => {
		const lease = { goalId: "goal-1" } as GoalExecutionLease;
		const beginExecution = vi.fn(() => lease);
		const endExecution = vi.fn();
		const foreground = { runAgentPrompt: vi.fn(async () => undefined) } as unknown as ForegroundRecoveryController;
		const controller = new DurableCustomMessageTurnController({
			foreground,
			goals: { beginExecution, endExecution },
		});

		// start()'s synchronous prefix (through `this.pending.set(...)`) runs before its first
		// await, so the pending appMessage is already registered the instant this call returns.
		const startPromise = controller.start(
			{ customType: "test", content: "hi", display: true },
			submissionLease,
			"goal-1",
		);
		const [appMessage] = (controller as unknown as { pending: Map<object, unknown> }).pending.keys();
		controller.notePersisted(appMessage as never);

		const { completion } = await startPromise;
		await completion;

		expect(endExecution).toHaveBeenCalledExactlyOnceWith(lease);
	});

	it("releases the goal execution lease when runAgentPrompt rejects", async () => {
		const lease = { goalId: "goal-2" } as GoalExecutionLease;
		const beginExecution = vi.fn(() => lease);
		const endExecution = vi.fn();
		const failure = new Error("provider unavailable");
		const foreground = {
			runAgentPrompt: vi.fn(async () => {
				throw failure;
			}),
		} as unknown as ForegroundRecoveryController;
		const controller = new DurableCustomMessageTurnController({
			foreground,
			goals: { beginExecution, endExecution },
		});

		// Nothing calls notePersisted before runAgentPrompt's rejection propagates, so start()
		// itself rejects with the same failure (via acceptedPromise) -- .finally() still runs.
		await expect(
			controller.start({ customType: "test", content: "hi", display: true }, submissionLease, "goal-2"),
		).rejects.toThrow(failure);
		expect(endExecution).toHaveBeenCalledExactlyOnceWith(lease);
	});

	it("releases the goal execution lease even when runAgentPrompt throws synchronously instead of returning a rejected promise", async () => {
		// Root-cause regression: `runAgentPrompt(...).finally(...)` never attaches its .finally()
		// handler if runAgentPrompt throws BEFORE returning a promise at all -- the goal execution
		// lease acquired just above leaked forever on that exit path. Every exit path must release.
		const lease = { goalId: "goal-3" } as GoalExecutionLease;
		const beginExecution = vi.fn(() => lease);
		const endExecution = vi.fn();
		const failure = new Error("synchronous validation failure");
		const foreground = {
			runAgentPrompt: vi.fn(() => {
				throw failure;
			}),
		} as unknown as ForegroundRecoveryController;
		const controller = new DurableCustomMessageTurnController({
			foreground,
			goals: { beginExecution, endExecution },
		});

		await expect(
			controller.start({ customType: "test", content: "hi", display: true }, submissionLease, "goal-3"),
		).rejects.toThrow(failure);

		expect(endExecution).toHaveBeenCalledExactlyOnceWith(lease);
	});

	it("never calls endExecution when beginExecution itself throws (no lease was ever acquired)", async () => {
		const failure = new Error("goal already executing");
		const beginExecution = vi.fn(() => {
			throw failure;
		});
		const endExecution = vi.fn();
		const foreground = { runAgentPrompt: vi.fn(async () => undefined) } as unknown as ForegroundRecoveryController;
		const controller = new DurableCustomMessageTurnController({
			foreground,
			goals: { beginExecution, endExecution },
		});

		await expect(
			controller.start({ customType: "test", content: "hi", display: true }, submissionLease, "goal-4"),
		).rejects.toThrow(failure);

		expect(foreground.runAgentPrompt).not.toHaveBeenCalled();
		expect(endExecution).not.toHaveBeenCalled();
	});
});
