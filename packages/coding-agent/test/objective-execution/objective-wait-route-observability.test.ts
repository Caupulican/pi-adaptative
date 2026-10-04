import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import { afterEach, describe, expect, it } from "vitest";
import { GoalSessionController } from "../../src/core/goals/goal-session-controller.ts";
import { applyGoalEvent, createGoalState } from "../../src/core/goals/goal-state.ts";
import { LedgerRouteCheckpoints } from "../../src/core/objective-execution/ledger-route-checkpoints.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import { DecisionLedgerStore } from "../../src/core/operator-projection/decision-ledger-store.ts";
import { ORCHESTRATION_SCHEMA_VERSION } from "../../src/core/orchestration/contracts.ts";
import { OrchestrationEventStore } from "../../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../../src/core/orchestration/task-runtime.ts";
import type { AttemptRuntimeState } from "../../src/core/orchestration/task-runtime-state.ts";
import { createWorkerExecutionContract } from "../../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "../orchestration-profile-fixture.ts";
import { tempDir } from "../temp-dir.ts";

/**
 * Every in-flight join of the objective loop is a decided route: it is composed, validated and
 * checkpointed as `wait_for_worker` and becomes the current route before the loop waits. The
 * continuation pass reads that route, so a bounded wait that returns with workers still running stops
 * the pass as a worker wait, never as an idle route and never as progress.
 */

const ledgers: DecisionLedgerStore[] = [];
afterEach(() => {
	for (const ledger of ledgers.splice(0)) ledger.close();
});

type Waiting = (attempts: readonly AttemptRuntimeState[]) => void;

function fixture() {
	const dir = tempDir("pi-wait-route-observability-");
	const runtime = new DurableTaskRuntime({
		store: new OrchestrationEventStore({ agentDir: dir, sessionId: randomUUID() }),
	});
	runtime.createObjective({ objectiveId: "goal:g1", title: "Goal g1", description: "Ship it" });
	const ledger = new DecisionLedgerStore({ databasePath: join(dir, "decision-ledger.sqlite") });
	ledgers.push(ledger);
	const routes = new LedgerRouteCheckpoints({
		getLedger: () => ledger,
		sessionId: "session-observability",
		cwd: dir,
		getSnapshot: () => runtime.getSnapshot(),
	});
	const waits: string[][] = [];
	// A watchdog pass by default: the bound elapses and the waiter returns with the attempts running.
	let onWait: Waiting = () => {};
	const controller = new ObjectiveExecutionController({
		mode: "objective_primary",
		repoRoot: tempDir("pi-wait-route-workspace-"),
		runtime: { reconcileObjective: async () => runtime.getSnapshot() },
		checkpoints: routes,
		stalls: routes,
		systemOne: { evaluateObjectiveRoute: async () => ({ workRemaining: true, missingWorkClass: "implement" }) },
		waiter: {
			wait: async (context, signal) => {
				const attempts = (context as { inFlightAttempts: readonly AttemptRuntimeState[] }).inFlightAttempts;
				waits.push(attempts.map((attempt) => attempt.taskId));
				onWait(attempts);
				signal?.throwIfAborted();
			},
		},
	});
	const sessionManager = SessionManager.inMemory();
	const prompts: string[] = [];
	const warnings: string[] = [];
	const goals = new GoalSessionController({
		getSessionManager: () => sessionManager,
		getModelProvider: () => undefined,
		getLaneRecords: () => [],
		getTaskRuntimeSnapshot: () => runtime.getSnapshot(),
		getBackgroundToolTasks: () => [],
		synchronizeGoalState: () => {},
		scheduleGoalAutoContinueFromIdle: () => {},
		prompt: async (text) => {
			prompts.push(text);
		},
		emitWarning: (message) => {
			warnings.push(message);
		},
		getExecutionLoopMode: () => "objective_primary",
		getObjectiveExecutionController: () => controller,
	});
	let goal = createGoalState({ goalId: "g1", userGoal: "Ship it", now: "2026-10-02T00:00:00.000Z" });
	goal = applyGoalEvent(goal, {
		type: "add_requirement",
		id: "r1",
		text: "tests pass",
		now: "2026-10-02T00:00:00.000Z",
	});
	goals.saveState(goal);

	/** A running attempt; with `readOnly` it carries admitted read-only authority, otherwise none. */
	const startRunning = (objectiveId: string, taskId: string, readOnly = false) => {
		if (!runtime.getSnapshot().objectives[objectiveId]) {
			runtime.createObjective({ objectiveId, title: objectiveId, description: `Work for ${objectiveId}` });
		}
		runtime.createTask({ taskId, objectiveId, title: taskId, description: `Work ${taskId}`, role: "implementer" });
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "read-only-worker",
			model: { provider: "faux", id: "faux-worker" },
		});
		const attempt = runtime.queueAttempt(
			taskId,
			{
				taskId,
				profileId: readOnly ? profile.profileId : "worker-default",
				instructions: `Work ${taskId}`,
				resourcePointerIds: [],
				...(readOnly
					? {
							executionContract: createWorkerExecutionContract({
								worker: {
									profile,
									modelBinding: profile.modelPolicy.candidates[0]!,
									authority: createTestWorkerExecutionAuthority(profile),
								},
							}),
						}
					: {}),
			},
			`grant-${taskId}`,
		);
		const lease = runtime.leaseAttempt(attempt.attemptId, `owner-${taskId}`, 60_000);
		runtime.startAttempt(attempt.attemptId, lease.leaseId, lease.fencingToken);
		return runtime.getSnapshot().attempts[attempt.attemptId]!;
	};
	const finish = (attempt: AttemptRuntimeState) => {
		const lease = runtime.getSnapshot().attempts[attempt.attemptId]?.lease;
		if (!lease) throw new Error(`Attempt '${attempt.attemptId}' has no lease.`);
		const task = runtime.getSnapshot().tasks[attempt.taskId]!;
		runtime.finishAttempt({
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			resultId: `result-${attempt.attemptId}`,
			objectiveId: task.task.objectiveId,
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
			leaseId: lease.leaseId,
			fencingToken: lease.fencingToken,
			status: "completed",
			reasonCode: "worker_completed",
			summary: "done",
			artifacts: [],
			evidence: [],
			errors: [],
			usage: { costUsd: 0, wallClockMs: 1, toolCalls: 0 },
			createdAt: new Date().toISOString(),
		});
	};
	const ledgerRoutes = async () =>
		(await routes.recentRoutes("goal:g1", 8)).map((entry) => `${entry.route}:${entry.executor ?? "-"}`);
	return {
		controller,
		goals,
		prompts,
		warnings,
		waits,
		startRunning,
		finish,
		ledgerRoutes,
		setOnWait: (next: Waiting) => {
			onWait = next;
		},
	};
}

describe("the objective loop's in-flight join is a recorded wait route", () => {
	it("a fresh controller records the wait before waiting and the pass stops as a worker wait", async () => {
		const f = fixture();
		let seenBeforeWait: string | undefined;
		f.setOnWait(() => {
			seenBeforeWait = f.controller.getLastRoute()?.route;
		});
		f.startRunning("goal:g1", "own-task");

		const pass = await f.goals.continueLoop({ maxTurns: 0, maxStallTurns: 3 });

		expect(seenBeforeWait).toBe("wait_for_worker");
		expect(f.controller.getLastRoute()).toMatchObject({
			route: "wait_for_worker",
			objective_id: "goal:g1",
			reason_codes: ["active_worker_in_flight"],
		});
		expect(await f.ledgerRoutes()).toEqual(["wait_for_worker:wait_for_worker"]);
		expect(pass).toMatchObject({ turnsSubmitted: 0, stopReason: "worker_in_flight" });
		expect(f.warnings).toEqual([]);
		expect(f.prompts).toEqual([]);
		expect(f.goals.getState()?.status).toBe("active");
	});

	it("after an earlier executable route, a watchdog return replaces the stale route and is not repetition", async () => {
		const f = fixture();
		expect(await f.goals.continueLoop({ maxTurns: 1, maxStallTurns: 3 })).toMatchObject({
			turnsSubmitted: 1,
			stopReason: "max_turns_reached",
		});
		const own = f.startRunning("goal:g1", "own-task");

		const first = await f.goals.continueLoop({ maxTurns: 0, maxStallTurns: 3 });
		const second = await f.goals.continueLoop({ maxTurns: 0, maxStallTurns: 3 });
		expect([first.stopReason, second.stopReason]).toEqual(["worker_in_flight", "worker_in_flight"]);
		expect(f.warnings).toEqual([]);

		// The worker finishes during the next wait; that pass still ends on its wait route, and the
		// following pass takes the next legitimate route instead of a repetition replan.
		f.setOnWait(() => f.finish(own));
		expect((await f.goals.continueLoop({ maxTurns: 1, maxStallTurns: 3 })).stopReason).toBe("worker_in_flight");
		expect(await f.goals.continueLoop({ maxTurns: 1, maxStallTurns: 3 })).toMatchObject({
			turnsSubmitted: 1,
			stopReason: "max_turns_reached",
		});

		expect(await f.ledgerRoutes()).toEqual([
			"implement:root",
			"wait_for_worker:wait_for_worker",
			"wait_for_worker:wait_for_worker",
			"wait_for_worker:wait_for_worker",
			"implement:root",
		]);
		expect(f.prompts).toHaveLength(2);
		expect(f.warnings).toEqual([]);
	});

	it("an overlapping unrelated join is recorded the same way; an unrelated read-only worker is not joined", async () => {
		const overlapping = fixture();
		overlapping.startRunning("session:other", "other-task");
		const pass = await overlapping.goals.continueLoop({ maxTurns: 0, maxStallTurns: 3 });
		expect(overlapping.waits).toEqual([["other-task"]]);
		expect(pass.stopReason).toBe("worker_in_flight");
		expect(await overlapping.ledgerRoutes()).toEqual(["wait_for_worker:wait_for_worker"]);

		const readOnly = fixture();
		readOnly.startRunning("session:other", "other-task", true);
		await readOnly.goals.continueLoop({ maxTurns: 1, maxStallTurns: 3 });
		expect(readOnly.waits).toEqual([]);
		expect(await readOnly.ledgerRoutes()).toEqual(["implement:root"]);
	});

	it("cancelling during the wait rejects with the cause after the wait route was recorded", async () => {
		const f = fixture();
		f.startRunning("goal:g1", "own-task");
		const abort = new AbortController();
		const cause = new Error("objective cancelled by its owner");
		f.setOnWait(() => abort.abort(cause));

		await expect(f.controller.runCycles("goal:g1", 1, abort.signal)).rejects.toBe(cause);

		expect(f.controller.getLastRoute()?.route).toBe("wait_for_worker");
		expect(await f.ledgerRoutes()).toEqual(["wait_for_worker:wait_for_worker"]);
		expect(f.prompts).toEqual([]);
	});
});
