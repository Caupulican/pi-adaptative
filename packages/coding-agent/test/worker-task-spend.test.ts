import { describe, expect, it } from "vitest";
import { retainedWorkerTaskSpend } from "../src/core/cost/worker-task-spend.ts";
import type { Outcome, OutcomeStatus } from "../src/core/delegation/worker-outcome-contract.ts";
import { EMPTY_ATTEMPT_USAGE, recordedAttemptCostUsd } from "../src/core/orchestration/attempt-usage.ts";
import { emptyProjection } from "../src/core/orchestration/task-runtime-projection.ts";
import type { AttemptRuntimeState, TaskRuntimeState } from "../src/core/orchestration/task-runtime-state.ts";

const at = "2026-11-17T00:00:00Z";

function attempt(
	taskId: string,
	attemptId: string,
	status: AttemptRuntimeState["status"],
	costUsd?: number,
): AttemptRuntimeState {
	const total = { ...EMPTY_ATTEMPT_USAGE, costUsd: costUsd ?? 0 };
	return {
		taskId,
		attemptId,
		status,
		createdAt: at,
		updatedAt: at,
		checkpointIds: [],
		dispatch: { taskId, profileId: "worker", instructions: "Work", resourcePointerIds: [] },
		...(costUsd !== undefined ? { usageAccounting: { total, generations: {} } } : {}),
	};
}

function task(attempts: AttemptRuntimeState[], status?: OutcomeStatus): TaskRuntimeState {
	const latest = attempts.at(-1)!;
	const taskId = latest.taskId;
	const outcome: Outcome | undefined = status && {
		v: 1,
		outcomeId: `outcome-${taskId}`,
		scope: "lane",
		taskId,
		nodeId: taskId,
		objectiveId: "o",
		generation: 1,
		status,
		blocker: status === "succeeded" ? "none" : "unclassified",
		attribution: "none",
		sourceCodes: [],
		coverage: { required: [], covered: [], uncovered: [] },
		assurance: "unverified",
		artifacts: [],
		changedFiles: [],
		cost: { usd: 99, metered: true, inputTokens: 0, outputTokens: 0 },
		durationMs: 0,
		attempts: [
			{
				attemptId: latest.attemptId,
				modelRef: "fixture",
				thinking: "off",
				rung: 0,
				laneStatus: latest.status,
				startedAt: at,
			},
		],
		nextAction: status === "succeeded" ? { kind: "accept" } : { kind: "ask_root", question: "Continue?" },
		ladder: { rung: 0, exit: "fixture" },
		recordedAt: at,
	};
	return {
		task: {
			schemaVersion: 1,
			taskId,
			objectiveId: "o",
			title: taskId,
			description: taskId,
			role: "implementer",
			status: "completed",
			dependsOn: [],
			requiredCapabilities: [],
			acceptanceCriterionIds: [],
			riskBudget: {},
			createdAt: at,
			updatedAt: at,
		},
		attemptIds: attempts.map((a) => a.attemptId),
		...(outcome ? { outcome } : {}),
	};
}

describe("retained worker cost per accepted task", () => {
	it("counts each terminal task's attempts once and excludes running tasks", () => {
		const previous = attempt("done", "previous", "failed", 2);
		const done = attempt("done", "retried", "completed", 3);
		const partial = attempt("partial", "part", "completed", 1);
		const cancelled = attempt("cancelled", "cancel", "cancelled", 4);
		const open = attempt("open", "open", "running", 7);
		const snapshot = {
			...emptyProjection(),
			attempts: { previous, retried: done, part: partial, cancel: cancelled, open },
			tasks: {
				done: task([previous, done], "succeeded"),
				partial: task([partial], "partial"),
				cancelled: task([cancelled], "cancelled"),
				open: task([open]),
			},
		};
		expect(retainedWorkerTaskSpend(snapshot)).toEqual({
			recordedUsd: 10,
			settledTasks: 3,
			acceptedTasks: 1,
			attempts: 4,
			missingCosts: 0,
			missingOutcomes: 0,
			perAcceptedUsd: 10,
		});
	});

	it("uses overlapping legacy evidence once and prefers generation accounting after a late charge", () => {
		const worker = attempt("a", "managed", "completed");
		worker.checkpointIds = ["c"];
		worker.result = {
			schemaVersion: 1,
			resultId: "r",
			objectiveId: "o",
			taskId: "a",
			attemptId: "managed",
			leaseId: "l",
			fencingToken: 1,
			status: "completed",
			reasonCode: "completed",
			summary: "done",
			artifacts: [],
			evidence: [],
			errors: [],
			usage: { costUsd: 5, wallClockMs: 10, toolCalls: 1 },
			createdAt: at,
		};
		const checkpoints = {
			c: {
				checkpointId: "c",
				attemptId: "managed",
				fencingToken: 1,
				summary: "so far",
				artifactIds: [],
				evidenceIds: [],
				usage: { ...EMPTY_ATTEMPT_USAGE, costUsd: 2 },
				createdAt: at,
			},
		};
		expect(recordedAttemptCostUsd(worker, checkpoints)).toBe(5);
		expect(recordedAttemptCostUsd({ ...worker, result: undefined }, checkpoints)).toBe(2);
		expect(
			recordedAttemptCostUsd(
				{ ...worker, usageAccounting: { generations: {}, total: { ...EMPTY_ATTEMPT_USAGE, costUsd: 6 } } },
				checkpoints,
			),
		).toBe(6);
	});

	it("withholds the unit cost for unpriced tokens or an empty registration alongside priced work", () => {
		const priced = attempt("a", "paid", "completed", 2);
		const empty = attempt("b", "empty", "cancelled", 0);
		for (const tokens of [0, 30]) {
			const partial = {
				...empty,
				usageAccounting: { total: { ...EMPTY_ATTEMPT_USAGE, totalTokens: tokens }, generations: {} },
			};
			expect(
				retainedWorkerTaskSpend({
					...emptyProjection(),
					attempts: { paid: priced, empty: partial },
					tasks: { a: task([priced], "succeeded"), b: task([partial], "cancelled") },
				}),
			).toMatchObject({ recordedUsd: 2, acceptedTasks: 1, missingCosts: 1, perAcceptedUsd: undefined });
		}

		const paid = { ...EMPTY_ATTEMPT_USAGE, costUsd: 2, inputTokens: 15 };
		const mixed = {
			...priced,
			usageAccounting: {
				total: { ...paid, cacheReadTokens: 30 },
				generations: {
					lease1: { fencingToken: 1, baseline: EMPTY_ATTEMPT_USAGE, reported: paid },
					lease2: { fencingToken: 2, baseline: paid, reported: { ...paid, cacheReadTokens: 30 } },
				},
			},
		};
		expect(
			retainedWorkerTaskSpend({
				...emptyProjection(),
				attempts: { paid: mixed },
				tasks: { a: task([mixed], "succeeded") },
			}),
		).toMatchObject({ recordedUsd: 2, acceptedTasks: 1, missingCosts: 1, perAcceptedUsd: undefined });
	});

	it("withholds the rate with missing costs, stale outcomes, or zero accepted tasks", () => {
		const good = attempt("b", "good", "completed", 2);
		const old = attempt("a", "old", "completed", 1);
		const fresh = attempt("a", "fresh", "cancelled");
		const snapshot = {
			...emptyProjection(),
			attempts: { good, old, fresh },
			tasks: { b: task([good], "succeeded"), a: task([old, fresh], "cancelled") },
		};
		expect(retainedWorkerTaskSpend(snapshot)).toMatchObject({
			recordedUsd: 3,
			acceptedTasks: 1,
			attempts: 3,
			missingCosts: 1,
			missingOutcomes: 0,
			perAcceptedUsd: undefined,
		});
		expect(
			retainedWorkerTaskSpend({
				...snapshot,
				attempts: { ...snapshot.attempts, fresh: attempt("a", "fresh", "cancelled", 1) },
				tasks: { ...snapshot.tasks, a: { ...task([old], "succeeded"), attemptIds: ["old", "fresh"] } },
			}),
		).toMatchObject({
			acceptedTasks: 1,
			missingCosts: 0,
			missingOutcomes: 1,
			perAcceptedUsd: undefined,
		});
		const blocked = attempt("b", "blocked", "blocked", 1);
		expect(
			retainedWorkerTaskSpend({
				...emptyProjection(),
				attempts: { blocked },
				tasks: { b: task([blocked], "blocked") },
			}),
		).toMatchObject({
			recordedUsd: 1,
			acceptedTasks: 0,
			missingCosts: 0,
			missingOutcomes: 0,
			perAcceptedUsd: undefined,
		});
	});
});
