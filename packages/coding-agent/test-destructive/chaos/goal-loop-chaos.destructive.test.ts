/**
 * H2 scenario a (blueprint §4): a budgeted goal loop with tool calls, driven against ChaosProvider.
 *
 * ChaosProvider is not a new provider — it is a seeded generator of `FauxResponseFactory` values
 * (test-destructive/harness/chaos-provider.ts) consumed through the existing faux-provider harness
 * (`test/suite/harness.ts` -> `@caupulican/pi-ai/faux`), the same mechanism
 * test/goal-execution-budget.test.ts and test/agent-session-natural-goal.test.ts already use to
 * drive a real budgeted goal loop end to end. This pilot reuses that exact, precedented pattern —
 * `vi.useFakeTimers()` + `createHarness()` + `harness.setResponses([...])` + `session.prompt(...)`.
 *
 * The prompt text deliberately avoids "keep working until this is complete" style phrasing:
 * AgentSession treats that phrasing as natural-language chat-goal admission (see
 * test/agent-session-natural-goal.test.ts), which would additionally admit a SECOND goal on top of
 * the explicit "goal" tool call this scenario's own response sequence issues — a self-inflicted
 * double-admission, not a chaos fault, and the harness must not manufacture that kind of confound.
 *
 * Driver: for seeds 1..10, start a small explicit-budget goal, chaosify its healthy
 * prepare/work/complete response sequence, and drive it to completion under a bounded virtual-time
 * deadline (`vi.advanceTimersByTimeAsync`). Assert INV-L1: the run settles within the deadline, ends
 * with a defined goal status, and does not leave the session's continuation mutex ("lease" for this
 * scenario — see the Phase 1 report's INV-L1 scoping note) stuck busy.
 */

import type { FauxResponseStep } from "@caupulican/pi-ai/faux";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { setStreamIdleOptionsForTests } from "../../src/core/agent-session.ts";
import { createHarness, type Harness } from "../../test/suite/harness.ts";
import { chaosifySequence } from "../harness/chaos-provider.ts";
import { assertInvL1, type LoopRunWorld } from "../harness/invariants.ts";
import { reproError } from "../harness/repro.ts";

const SCENARIO = "H2a-goal-loop-chaos";
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
/** Generous relative to the ~3-turn goal below even with the product's default 3-attempt retry
 * policy (packages/agent/src/reliability/retry.ts DEFAULT_RETRY_POLICY) backing off between chaos
 * faults and healthy retries; all delays are virtual (fake timers), so this bound is cheap to keep
 * wide. */
const DEADLINE_MS = 2 * 60 * 60 * 1000;
const TOKEN_BUDGET = 40_000;

function healthyGoalSequence(): FauxResponseStep[] {
	return [
		fauxAssistantMessage(
			fauxToolCall("goal", {
				action: "start",
				goalId: "chaos-goal",
				userGoal: "Investigate and summarize the failing check",
				tokenBudget: TOKEN_BUDGET,
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall("bash", { command: "echo inspecting" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("goal", { action: "complete" }), { stopReason: "toolUse" }),
	];
}

const harnesses: Harness[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	// The stream-idle watchdog is what resolves a "hang" chaos fault (it aborts the dead stream);
	// its production defaults are minutes long (packages/agent/src/reliability/watchdogs.ts), so
	// shrink them here — same override used by test/suite/stream-stall-retry.test.ts — to keep them
	// comfortably inside DEADLINE_MS while still exercising the real abort path under fake timers.
	setStreamIdleOptionsForTests({ connectMs: 5_000, activeIdleMs: 5_000, quietIdleMs: 5_000 });
});

afterEach(async () => {
	setStreamIdleOptionsForTests(undefined);
	vi.useRealTimers();
	while (harnesses.length > 0) {
		await harnesses.pop()?.cleanup();
	}
});

describe("destructive/chaos: budgeted goal loop against ChaosProvider (INV-L1)", () => {
	for (const seed of SEEDS) {
		it(`seed ${seed}: terminates with a defined stop reason, no hang, no leaked continuation lease`, async () => {
			const repro = { seed, scenario: SCENARIO };
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 5 } },
			});
			harnesses.push(harness);

			const sequence = chaosifySequence(healthyGoalSequence(), { seed, maxFaultsPerStep: 2, faultProbability: 0.6 });
			harness.setResponses(sequence);

			let settled = false;
			let runError: unknown;
			const run = harness.session
				.prompt("destructive chaos scenario: investigate and summarize the failing check")
				.catch((error: unknown) => {
					runError = error;
				})
				.finally(() => {
					settled = true;
				});

			await vi.advanceTimersByTimeAsync(DEADLINE_MS);
			if (!settled) {
				throw reproError("The chaos goal loop did not settle within its virtual-time deadline.", repro);
			}
			await run;
			if (runError !== undefined) {
				throw reproError(
					`session.prompt() rejected instead of settling into a defined status: ${runError instanceof Error ? runError.message : String(runError)}`,
					repro,
				);
			}

			const goalSnapshot = harness.session.getGoalStateSnapshot();
			// A run that never engaged the goal (e.g. its very first response was replaced by a
			// succeeding-but-weird chaos fault, so the "goal start" tool call was never delivered) is
			// still a defined, valid outcome: the prompt completed one ordinary turn and stopped.
			const stopReason = goalSnapshot?.status ?? "completed_no_goal";

			// A leaked continuation lease shows up as the session refusing (or hanging on) a fresh
			// prompt right after the chaos run "finished". Probe it directly with an ordinary healthy
			// turn on the same session, still under the same virtual-time deadline.
			harness.appendResponses([fauxAssistantMessage("post-chaos probe settled")]);
			let probeSettled = false;
			const probe = harness.session
				.prompt("probe: are you free?")
				.catch(() => undefined)
				.finally(() => {
					probeSettled = true;
				});
			await vi.advanceTimersByTimeAsync(DEADLINE_MS);
			if (!probeSettled) {
				throw reproError("Post-run probe prompt did not settle: the continuation lease looks leaked.", repro);
			}
			await probe;

			const world: LoopRunWorld = {
				settledWithinDeadline: settled,
				stopReason,
				leaseLeaked: !probeSettled,
			};

			// The chaos loop is virtual-time-owned, but physical child termination is an OS event. Return
			// to real timers before cleanup so advancing the fake clock cannot fire the strict release
			// watchdog before Linux has a chance to deliver the child's close event.
			vi.useRealTimers();
			await harness.cleanup();

			assertInvL1({ loopRun: world }, repro);
		}, 30_000);
	}
});
