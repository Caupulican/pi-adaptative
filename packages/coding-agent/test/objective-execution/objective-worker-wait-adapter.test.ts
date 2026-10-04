// @isolated: drives real AgentSession harnesses with an in-process worker on the faux provider.
import type { AssistantMessage } from "@caupulican/pi-ai";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../../src/core/autonomy/lane-tracker.ts";
import type { RunningAttemptWaitOutcome } from "../../src/core/background-lane-controller.ts";
import { applyGoalEvent, createGoalState } from "../../src/core/goals/goal-state.ts";
import {
	ObjectiveExecutionController,
	ObjectiveExecutionInterruptedError,
} from "../../src/core/objective-execution/objective-execution-controller.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type OrchestrationProfile } from "../../src/core/orchestration/contracts.ts";
import type { AttemptRuntimeState } from "../../src/core/orchestration/task-runtime-state.ts";
import { createTestManagedLaneDispatch } from "../managed-lane-fixture.ts";
import { setConcurrentResponses } from "../suite/concurrent-responses.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

/**
 * The objective loop's worker wait. A real AgentSession binds its waiter into a real
 * ObjectiveExecutionController; the waiter holds until a captured attempt leaves "running", whichever
 * kind of worker owns it, and releases on cancellation, its bound and session disposal without ever
 * reporting unfinished work as finished.
 */

function workerProfile(): OrchestrationProfile {
	const now = new Date().toISOString();
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "held-worker",
		description: "Worker whose provider turn the test releases",
		role: "implementer",
		modelPolicy: { mode: "fixed", candidates: [{ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }] },
		capabilityCeiling: ["filesystem.read"],
		toolNames: ["read"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxCostUsd: 1, maxTokens: 8_192, maxToolCalls: 4, maxWallClockMs: 60_000 },
		maxConcurrent: 1,
		leaseTtlMs: 90_000,
		requireIndependentVerification: false,
		createdAt: now,
		updatedAt: now,
	};
}

function delegationHarness(): Promise<Harness> {
	return createHarness({
		models: [{ id: "faux-1", contextWindow: 128_000 }],
		workerOrchestrationProfile: workerProfile(),
		settings: { workerDelegation: { enabled: true } },
	});
}

/** A session without delegation: managed lanes are its only workers. */
function managedOnlyHarness(): Promise<Harness> {
	return createHarness({ settings: { workerDelegation: { enabled: false } }, excludedToolNames: ["delegate"] });
}

/** Binds the session's production executors (its waiter among them) into an objective controller. */
function attachObjectiveLoop(harness: Harness): ObjectiveExecutionController {
	const controller = new ObjectiveExecutionController({
		mode: "objective_primary",
		runtime: {
			// Before any lane exists the session has no task runtime yet: an empty projection.
			reconcileObjective: async () =>
				harness.session.backgroundLanes.getTaskRuntimeSnapshot() ?? {
					lastOrdinal: 0,
					agents: {},
					objectives: {},
					tasks: {},
					attempts: {},
					checkpoints: {},
					approvals: {},
					notifications: {},
				},
		},
	});
	harness.session.attachAdaptiveRuntime({ objectiveController: controller });
	return controller;
}

function attempt(harness: Harness, attemptId: string): AttemptRuntimeState | undefined {
	return harness.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts[attemptId];
}

function objectiveOf(harness: Harness, running: AttemptRuntimeState): string {
	const task = harness.session.backgroundLanes.getTaskRuntimeSnapshot()?.tasks[running.taskId];
	if (!task) throw new Error(`Attempt '${running.attemptId}' has no task.`);
	return task.task.objectiveId;
}

/** Dispatches a managed lane and returns its running attempt (managed attempts carry no agent). */
function dispatchManaged(harness: Harness, laneId: string, sequence = 1): AttemptRuntimeState {
	harness.session.backgroundLanes.recordManagedLane({
		laneId,
		phase: "dispatch",
		goalId: "g1",
		dispatch: createTestManagedLaneDispatch({ sequence }),
	});
	const running = Object.values(harness.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
		(candidate) =>
			candidate.dispatch.logicalLaneId === laneId &&
			candidate.dispatch.dispatchSequence === sequence &&
			candidate.status === "running",
	);
	if (!running) throw new Error(`Managed lane '${laneId}' has no running attempt.`);
	expect(running.agentId).toBeUndefined();
	return running;
}

function finishManaged(harness: Harness, laneId: string): void {
	harness.session.backgroundLanes.recordManagedLane({ laneId, phase: "terminal", status: "succeeded" });
}

/** Tracks a promise's settlement without awaiting it. */
function track<T>(promise: Promise<T>) {
	const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
	const done = promise.then(
		(value) => {
			state.settled = true;
			state.value = value;
		},
		(error: unknown) => {
			state.settled = true;
			state.error = error;
		},
	);
	return { state, done };
}

/** Lets every already-scheduled callback run; a wait that does not depend on a transition settles here. */
async function drainScheduledWork(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A real in-process worker whose first provider turn is held until the test releases it. Setup waits
 * on the turn's own arrival; the held turn honours the request's abort signal so disposal ends it.
 */
async function startHeldWorker(harness: Harness) {
	let entered!: () => void;
	const inTurn = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	setConcurrentResponses(harness, [
		async (_context, options): Promise<AssistantMessage> => {
			entered();
			await new Promise<void>((resolve, reject) => {
				const signal = options?.signal;
				if (signal?.aborted) {
					reject(signal.reason);
					return;
				}
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				void released.then(resolve);
			});
			return fauxAssistantMessage('{"summary":"released","status":"completed"}');
		},
	]);
	const run = track(harness.session.runWorkerDelegationOnce({ instructions: "Wait for the release signal." }));
	await inTurn;
	const running = Object.values(harness.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
		(candidate) => candidate.agentId !== undefined && candidate.status === "running",
	);
	if (!running) throw new Error("The held worker has no running attempt.");
	return { attempt: running, run, release };
}

function waitFor(
	harness: Harness,
	attemptIds: readonly string[],
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
	return track<RunningAttemptWaitOutcome>(
		harness.session.backgroundLanes.waitForRunningAttempts(attemptIds, {
			timeoutMs: options.timeoutMs ?? 60_000,
			...(options.signal ? { signal: options.signal } : {}),
		}),
	);
}

/** Subscribers on the lifecycle's orchestration store, for subscription-cleanup checks. */
function storeListenerCount(harness: Harness): number {
	const lanes = harness.session.backgroundLanes as unknown as {
		_orchestrationStore?: { listeners: Set<unknown> };
	};
	return lanes._orchestrationStore?.listeners.size ?? 0;
}

describe("objective worker wait through the production session adapter", () => {
	it("holds the loop on a managed attempt in a session without delegation until it terminates", async () => {
		const harness = await managedOnlyHarness();
		try {
			const controller = attachObjectiveLoop(harness);
			const managed = dispatchManaged(harness, "managed-lane");
			expect(objectiveOf(harness, managed)).toBe("goal:g1");

			const cycle = track(controller.runCycles("goal:g1", 1));
			await drainScheduledWork();
			expect(cycle.state.settled).toBe(false);

			finishManaged(harness, "managed-lane");
			await cycle.done;
			expect(cycle.state.error).toBeUndefined();
			expect(attempt(harness, managed.attemptId)?.status).toBe("completed");
		} finally {
			await harness.cleanup();
		}
	});

	it("holds the loop on an in-process worker until it terminates", async () => {
		const harness = await delegationHarness();
		try {
			const controller = attachObjectiveLoop(harness);
			const worker = await startHeldWorker(harness);

			const cycle = track(controller.runCycles(objectiveOf(harness, worker.attempt), 1));
			await drainScheduledWork();
			expect(cycle.state.settled).toBe(false);

			worker.release();
			await cycle.done;
			await worker.run.done;
			expect(cycle.state.error).toBeUndefined();
			expect(worker.run.state.error).toBeUndefined();
			expect(attempt(harness, worker.attempt.attemptId)?.status).not.toBe("running");
		} finally {
			await harness.cleanup();
		}
	});

	it("cancelling the loop rejects its wait with the exact cause while the worker stays active", async () => {
		const harness = await delegationHarness();
		try {
			const controller = attachObjectiveLoop(harness);
			const worker = await startHeldWorker(harness);
			const abort = new AbortController();
			const cause = new Error("objective cancelled by its owner");

			const cycle = track(controller.runCycles(objectiveOf(harness, worker.attempt), 1, abort.signal));
			await drainScheduledWork();
			expect(cycle.state.settled).toBe(false);
			abort.abort(cause);
			await cycle.done;

			expect(cycle.state.error).toBe(cause);
			expect(attempt(harness, worker.attempt.attemptId)?.status).toBe("running");
			expect(worker.run.state.settled).toBe(false);
			worker.release();
			await worker.run.done;
			expect(worker.run.state.error).toBeUndefined();
			expect(attempt(harness, worker.attempt.attemptId)?.status).not.toBe("running");
		} finally {
			await harness.cleanup();
		}
	});

	it("session shutdown settles the loop's wait on an in-process worker", async () => {
		const harness = await delegationHarness();
		let cleaned = false;
		try {
			const controller = attachObjectiveLoop(harness);
			const worker = await startHeldWorker(harness);
			const cycle = track(controller.runCycles(objectiveOf(harness, worker.attempt), 1));
			await drainScheduledWork();
			expect(cycle.state.settled).toBe(false);

			await harness.cleanup();
			cleaned = true;
			await cycle.done;
			await worker.run.done;
			expect(cycle.state.settled).toBe(true);
		} finally {
			if (!cleaned) await harness.cleanup();
		}
	});
});

describe("running-attempt wait", () => {
	it("a mixed managed and in-process set wakes on whichever captured attempt leaves running", async () => {
		const harness = await delegationHarness();
		try {
			const worker = await startHeldWorker(harness);
			const managed = dispatchManaged(harness, "managed-lane");
			const wait = waitFor(harness, [worker.attempt.attemptId, managed.attemptId]);
			await drainScheduledWork();
			expect(wait.state.settled).toBe(false);

			finishManaged(harness, "managed-lane");
			await wait.done;
			expect(wait.state.value).toEqual({ kind: "changed", attemptIds: [managed.attemptId] });
			expect(attempt(harness, worker.attempt.attemptId)?.status).toBe("running");
			worker.release();
			await worker.run.done;
		} finally {
			await harness.cleanup();
		}
	});

	it("unrelated store events do not wake a wait", async () => {
		const harness = await managedOnlyHarness();
		try {
			const managed = dispatchManaged(harness, "managed-lane");
			const wait = waitFor(harness, [managed.attemptId]);
			dispatchManaged(harness, "unrelated-lane");
			finishManaged(harness, "unrelated-lane");
			await drainScheduledWork();
			expect(wait.state.settled).toBe(false);

			finishManaged(harness, "managed-lane");
			await wait.done;
			expect(wait.state.value).toEqual({ kind: "changed", attemptIds: [managed.attemptId] });
		} finally {
			await harness.cleanup();
		}
	});

	it("a terminal committed while the wait registers settles it, and an already-terminal target settles at once", async () => {
		const harness = await managedOnlyHarness();
		try {
			const racing = dispatchManaged(harness, "racing-lane");
			const wait = waitFor(harness, [racing.attemptId]);
			finishManaged(harness, "racing-lane");
			await wait.done;
			expect(wait.state.value).toEqual({ kind: "changed", attemptIds: [racing.attemptId] });

			const done = waitFor(harness, [racing.attemptId]);
			await done.done;
			expect(done.state.value).toEqual({ kind: "changed", attemptIds: [racing.attemptId] });
		} finally {
			await harness.cleanup();
		}
	});

	it("an unknown target attempt is an error, never completion", async () => {
		const harness = await managedOnlyHarness();
		try {
			dispatchManaged(harness, "managed-lane");
			const wait = waitFor(harness, ["no-such-attempt"]);
			await wait.done;
			expect(wait.state.value).toBeUndefined();
			expect(String(wait.state.error)).toContain("no-such-attempt");
		} finally {
			await harness.cleanup();
		}
	});

	it("a pre-aborted and a later-aborted signal reject with their exact reasons and leave no subscription", async () => {
		const harness = await managedOnlyHarness();
		try {
			const managed = dispatchManaged(harness, "managed-lane");
			const baseline = storeListenerCount(harness);
			const preCause = new Error("aborted before the wait");
			const pre = new AbortController();
			pre.abort(preCause);
			const before = waitFor(harness, [managed.attemptId], { signal: pre.signal });
			await before.done;
			expect(before.state.error).toBe(preCause);
			expect(storeListenerCount(harness)).toBe(baseline);

			const later = new AbortController();
			const laterCause = new Error("aborted during the wait");
			const during = waitFor(harness, [managed.attemptId], { signal: later.signal });
			expect(storeListenerCount(harness)).toBe(baseline + 1);
			later.abort(laterCause);
			await during.done;
			expect(during.state.error).toBe(laterCause);
			expect(storeListenerCount(harness)).toBe(baseline);
			expect(attempt(harness, managed.attemptId)?.status).toBe("running");
		} finally {
			await harness.cleanup();
		}
	});

	it("its bound expires as timed_out without observing the still-running attempt", async () => {
		const harness = await managedOnlyHarness();
		try {
			const managed = dispatchManaged(harness, "managed-lane");
			const observe = vi.spyOn(harness.session.backgroundLanes, "observeWorkerTerminalRecords");
			const baseline = storeListenerCount(harness);
			const wait = waitFor(harness, [managed.attemptId], { timeoutMs: 1 });
			await wait.done;

			expect(wait.state.value).toEqual({ kind: "timed_out" });
			expect(observe).not.toHaveBeenCalled();
			expect(attempt(harness, managed.attemptId)?.status).toBe("running");
			expect(storeListenerCount(harness)).toBe(baseline);
		} finally {
			await harness.cleanup();
		}
	});

	it("session disposal settles an unresolved managed wait as disposed, observing nothing", async () => {
		const harness = await managedOnlyHarness();
		let cleaned = false;
		try {
			const managed = dispatchManaged(harness, "managed-lane");
			const observe = vi.spyOn(harness.session.backgroundLanes, "observeWorkerTerminalRecords");
			const wait = waitFor(harness, [managed.attemptId]);
			await drainScheduledWork();
			expect(wait.state.settled).toBe(false);

			await harness.cleanup();
			cleaned = true;
			await wait.done;
			expect(wait.state.value).toEqual({ kind: "disposed" });
			expect(observe).not.toHaveBeenCalled();
		} finally {
			if (!cleaned) await harness.cleanup();
		}
	});

	it("a terminal immediately followed by a redispatch of the same lane observes only the captured generation", async () => {
		const harness = await managedOnlyHarness();
		try {
			const first = dispatchManaged(harness, "managed-lane", 1);
			const observe = vi.spyOn(harness.session.backgroundLanes, "observeWorkerTerminalRecords");
			const wait = waitFor(harness, [first.attemptId]);
			finishManaged(harness, "managed-lane");
			const second = dispatchManaged(harness, "managed-lane", 2);
			await wait.done;

			expect(wait.state.value).toEqual({ kind: "changed", attemptIds: [first.attemptId] });
			const observed = observe.mock.calls.flatMap(([records]) => records as readonly LaneRecord[]);
			expect(observed).toHaveLength(1);
			expect(observed[0]).toMatchObject({ laneId: "managed-lane", status: "succeeded" });
			expect(observed[0]?.completedAt).toBe(attempt(harness, first.attemptId)?.updatedAt);
			expect(attempt(harness, second.attemptId)?.status).toBe("running");
		} finally {
			await harness.cleanup();
		}
	});
});

describe("the objective loop across session disposal", () => {
	/** Counts the session's attempt waits and root prompts from here on. */
	function count(harness: Harness) {
		const counted = { waits: 0, prompts: 0 };
		const wait = harness.session.backgroundLanes.waitForRunningAttempts.bind(harness.session.backgroundLanes);
		vi.spyOn(harness.session.backgroundLanes, "waitForRunningAttempts").mockImplementation((ids, options) => {
			counted.waits++;
			return wait(ids, options);
		});
		const prompt = harness.session.prompt.bind(harness.session);
		vi.spyOn(harness.session, "prompt").mockImplementation((text, options) => {
			counted.prompts++;
			return prompt(text, options);
		});
		return counted;
	}

	/** A real executable root route first, then the objective's own managed lane running. */
	async function afterExecutableRoute(harness: Harness): Promise<ObjectiveExecutionController> {
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("implemented")));
		const controller = attachObjectiveLoop(harness);
		await controller.runCycles("goal:g1", 1);
		expect(controller.getLastRoute()?.route).toBe("implement");
		dispatchManaged(harness, "own-lane");
		return controller;
	}

	it.each([
		["a finite multi-cycle run", (controller: ObjectiveExecutionController) => controller.runCycles("goal:g1", 6)],
		["an unbounded run", (controller: ObjectiveExecutionController) => controller.run("goal:g1")],
	] as const)("disposal interrupts %s promptly, with no further waits or root turns", async (_label, start) => {
		const harness = await managedOnlyHarness();
		let cleaned = false;
		try {
			const controller = await afterExecutableRoute(harness);
			const counted = count(harness);
			const run = track(start(controller));
			await drainScheduledWork();
			expect(run.state.settled).toBe(false);
			expect(counted.waits).toBe(1);

			await harness.cleanup();
			cleaned = true;
			await run.done;

			expect(run.state.error).toBeInstanceOf(ObjectiveExecutionInterruptedError);
			expect(counted).toEqual({ waits: 1, prompts: 0 });
		} finally {
			if (!cleaned) await harness.cleanup();
		}
	});

	it("disposal interrupts a wait on an in-process worker", async () => {
		const harness = await delegationHarness();
		let cleaned = false;
		try {
			const controller = attachObjectiveLoop(harness);
			const worker = await startHeldWorker(harness);
			const run = track(controller.runCycles(objectiveOf(harness, worker.attempt), 6));
			await drainScheduledWork();
			expect(run.state.settled).toBe(false);

			await harness.cleanup();
			cleaned = true;
			await run.done;
			await worker.run.done;
			expect(run.state.error).toBeInstanceOf(ObjectiveExecutionInterruptedError);
		} finally {
			if (!cleaned) await harness.cleanup();
		}
	});

	it("a terminal committed together with shutdown still ends as an interruption, never as progress", async () => {
		const harness = await managedOnlyHarness();
		let cleaned = false;
		try {
			const controller = await afterExecutableRoute(harness);
			const counted = count(harness);
			const run = track(controller.runCycles("goal:g1", 6));
			await drainScheduledWork();

			finishManaged(harness, "own-lane");
			const disposal = harness.cleanup();
			cleaned = true;
			await disposal;
			await run.done;

			expect(run.state.error).toBeInstanceOf(ObjectiveExecutionInterruptedError);
			expect(counted.prompts).toBe(0);
		} finally {
			if (!cleaned) await harness.cleanup();
		}
	});

	it("control: a bounded wait that times out returns normally and the loop goes on", async () => {
		const harness = await managedOnlyHarness();
		try {
			const controller = attachObjectiveLoop(harness);
			const managed = dispatchManaged(harness, "own-lane");
			const wait = harness.session.backgroundLanes.waitForRunningAttempts.bind(harness.session.backgroundLanes);
			vi.spyOn(harness.session.backgroundLanes, "waitForRunningAttempts").mockImplementation((ids, options) =>
				wait(ids, { ...options, timeoutMs: 1 }),
			);

			await expect(controller.runCycles("goal:g1", 1)).resolves.toBeUndefined();
			expect(controller.getLastRoute()?.route).toBe("wait_for_worker");
			expect(attempt(harness, managed.attemptId)?.status).toBe("running");
		} finally {
			await harness.cleanup();
		}
	});

	it("the session's primary continuation stops as session_disposed and leaves the goal untouched", async () => {
		const harness = await managedOnlyHarness();
		let cleaned = false;
		try {
			attachObjectiveLoop(harness);
			let goal = createGoalState({ goalId: "g1", userGoal: "Ship it", now: "2026-10-02T00:00:00.000Z" });
			goal = applyGoalEvent(goal, {
				type: "add_requirement",
				id: "r1",
				text: "tests pass",
				now: "2026-10-02T00:00:00.000Z",
			});
			harness.session.saveGoalStateSnapshot(goal);
			dispatchManaged(harness, "own-lane");
			const counted = count(harness);

			const pass = track(harness.session.continueGoalLoop({ maxTurns: 0, maxStallTurns: 3 }));
			await drainScheduledWork();
			expect(pass.state.settled).toBe(false);
			const goalBefore = harness.session.getGoalStateSnapshot();

			await harness.cleanup();
			cleaned = true;
			await pass.done;

			expect(pass.state.error).toBeUndefined();
			expect(pass.state.value).toMatchObject({ turnsSubmitted: 0, stopReason: "session_disposed" });
			expect(harness.session.getGoalStateSnapshot()).toEqual(goalBefore);
			expect(counted).toEqual({ waits: 1, prompts: 0 });
		} finally {
			if (!cleaned) await harness.cleanup();
		}
	});
});
