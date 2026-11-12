import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerDelegationController } from "../src/core/delegation/worker-delegation-controller.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";

const ROOT_AGENT = "root-agent";
const now = "2026-11-12T00:00:00.000Z";

function executionContract(maxAttempts: number) {
	const profile = {
		schemaVersion: 1 as const,
		profileId: "root-budget-fixture",
		description: "Root profile for a durable worker tree budget test.",
		role: "explorer" as const,
		modelPolicy: {
			mode: "fixed" as const,
			candidates: [{ provider: "fixture", modelId: "model", thinkingLevel: "off" as const }],
		},
		capabilityCeiling: [],
		toolNames: [],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxAttempts },
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: now,
		updatedAt: now,
	};
	return createWorkerExecutionContract({
		worker: {
			profile,
			modelBinding: { provider: "fixture", modelId: "model", thinkingLevel: "off" },
			authority: {
				cwd: "/workspace",
				capabilities: [],
				toolNames: [],
				readPaths: ["/workspace"],
				writePaths: [],
				deniedPaths: [],
				budget: { maxAttempts },
			},
			resourcePointers: [],
		},
	});
}

function lifecycleFor(maxAttempts: number): { lifecycle: WorkerLifecycle; directory: string } {
	const directory = mkdtempSync(path.join(tmpdir(), "pi-worker-tree-admission-"));
	const sessionId = "tree-admission-session";
	const lifecycle = new WorkerLifecycle({ agentDir: directory, sessionId, now: () => Date.parse(now) });
	const resumeContext = {
		provider: "pi" as const,
		sessionId,
		cwd: "/workspace",
		resourceProfileNames: [],
		contextPointers: [],
	};
	lifecycle.ensureAgent({ agentId: ROOT_AGENT, role: "explorer", resumeContext });
	lifecycle.prepare(
		{
			instructions: "Root task",
			executionContract: executionContract(maxAttempts),
			requiredCapabilities: [],
		},
		ROOT_AGENT,
	);
	const attempt = lifecycle.getActiveAttempt(ROOT_AGENT)!;
	const objectiveId = lifecycle.getTaskRuntimeSnapshot().tasks[ROOT_AGENT]!.task.objectiveId;
	lifecycle.bindGrant(attempt.attemptId, {
		schemaVersion: 1,
		grantId: "root-grant",
		objectiveId,
		taskId: ROOT_AGENT,
		attemptId: attempt.attemptId,
		subjectId: ROOT_AGENT,
		role: "explorer",
		capabilities: [],
		allowedTools: [],
		resources: [],
		readPaths: [],
		writePaths: [],
		deniedPaths: [],
		budget: { maxAttempts },
		policyVersion: "fixture",
		decisionTrace: [],
		issuedAt: now,
	});
	lifecycle.startAgent(ROOT_AGENT, ROOT_AGENT, 60_000);
	return { lifecycle, directory };
}

function failCurrentTask(lifecycle: WorkerLifecycle, taskId: string): void {
	const attempt = lifecycle.getActiveAttempt(taskId)!;
	const task = lifecycle.getTaskRuntimeSnapshot().tasks[taskId]!.task;
	lifecycle.finish(
		{
			schemaVersion: 1,
			resultId: `failed-${attempt.attemptId}`,
			objectiveId: task.objectiveId,
			taskId,
			attemptId: attempt.attemptId,
			leaseId: attempt.lease!.leaseId,
			fencingToken: attempt.lease!.fencingToken,
			status: "failed",
			reasonCode: "fixture_failure",
			summary: "The fixture task failed.",
			artifacts: [],
			evidence: [],
			errors: [],
			usage: { wallClockMs: 1, toolCalls: 0 },
			createdAt: now,
		},
		{ notify: false },
	);
}

function startTask(lifecycle: WorkerLifecycle, taskId: string): void {
	const attempt = lifecycle.getActiveAttempt(taskId)!;
	const task = lifecycle.getTaskRuntimeSnapshot().tasks[taskId]!.task;
	lifecycle.bindGrant(attempt.attemptId, {
		schemaVersion: 1,
		grantId: `grant-${attempt.attemptId}`,
		objectiveId: task.objectiveId,
		taskId,
		attemptId: attempt.attemptId,
		subjectId: ROOT_AGENT,
		role: "explorer",
		capabilities: [],
		allowedTools: [],
		resources: [],
		readPaths: [],
		writePaths: [],
		deniedPaths: [],
		budget: { maxAttempts: 2 },
		policyVersion: "fixture",
		decisionTrace: [],
		issuedAt: now,
	});
	lifecycle.startAgent(taskId, ROOT_AGENT, 60_000);
}

function addFailedRerun(lifecycle: WorkerLifecycle, taskId: string): void {
	lifecycle.prepare(
		{
			instructions: "Retry the same failed task.",
			executionContract: executionContract(2),
			requiredCapabilities: [],
			attemptOfTaskId: taskId,
		},
		taskId,
	);
	startTask(lifecycle, taskId);
	failCurrentTask(lifecycle, taskId);
}

function controllerAtMaterializationBoundary(
	lifecycle: WorkerLifecycle,
	nextStep: () => never,
): WorkerDelegationController {
	const controller = Object.create(WorkerDelegationController.prototype) as WorkerDelegationController;
	Object.assign(controller, {
		workerAbort: new AbortController(),
		deps: { isDisposed: () => false },
		lifecycle,
		newWorkerFleetSkipReason: () => undefined,
		requiredAgentSlotsForAdmission: () => 1,
		contendsWithLocalForeground: nextStep,
	});
	return controller;
}

const startInternal = Reflect.get(WorkerDelegationController.prototype, "startInternal") as (
	this: WorkerDelegationController,
	request: { parentAgentId?: string; attemptOf?: { taskId: string }; instructions: string },
	pinnedContract: undefined,
	preparedAdmission: unknown,
) => unknown;

describe("worker tree attempt admission at materialization", () => {
	it.each([
		{ sourceAttempts: 2, otherAttempts: 1, denied: true },
		{ sourceAttempts: 1, otherAttempts: 2, denied: false },
	])(
		"binds an older root rerun to its source tree: $sourceAttempts source / $otherAttempts newer",
		({ sourceAttempts, otherAttempts, denied }) => {
			const { lifecycle, directory } = lifecycleFor(2);
			try {
				failCurrentTask(lifecycle, ROOT_AGENT);
				if (sourceAttempts === 2) addFailedRerun(lifecycle, ROOT_AGENT);
				const other = lifecycle.prepareAgentTurn({
					agentId: ROOT_AGENT,
					instructions: "A later unrelated task for the same specialist.",
					controlMessageId: "other-task",
				});
				startTask(lifecycle, other.attempt.taskId);
				failCurrentTask(lifecycle, other.attempt.taskId);
				if (otherAttempts === 2) addFailedRerun(lifecycle, other.attempt.taskId);
				expect(lifecycle.getAgentTurnDispatch(ROOT_AGENT)!.taskId).toBe(other.attempt.taskId);
				expect(other.attempt.taskId).not.toBe(ROOT_AGENT);
				const before = lifecycle.getTaskRuntimeSnapshot();
				const sentinel = new Error("source tree has room");
				const run = () =>
					startInternal.call(
						controllerAtMaterializationBoundary(lifecycle, () => {
							throw sentinel;
						}),
						{ attemptOf: { taskId: ROOT_AGENT }, instructions: "Rerun the older source task." },
						undefined,
						{ ok: true, shipment: { model: {} } },
					);
				if (denied) expect(run()).toEqual({ started: false, skipReason: "worker_tree_attempt_budget_exhausted" });
				else expect(run).toThrow(sentinel);
				expect(lifecycle.getTaskRuntimeSnapshot()).toEqual(before);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("rechecks a stale prepared admission against durable state before persisting another attempt", () => {
		const capped = lifecycleFor(1);
		const permitted = lifecycleFor(2);
		const request = { parentAgentId: ROOT_AGENT, instructions: "Child task" };
		const rootRerun = { attemptOf: { taskId: ROOT_AGENT }, instructions: "Rerun root task" };
		const preparedAdmission = { ok: true, shipment: { model: {} } };
		const sentinel = new Error("materialization passed tree headroom");
		try {
			const cappedBefore = capped.lifecycle.getTaskRuntimeSnapshot();
			const denied = startInternal.call(
				controllerAtMaterializationBoundary(capped.lifecycle, () => {
					throw sentinel;
				}),
				request,
				undefined,
				preparedAdmission,
			);
			expect(denied).toEqual({ started: false, skipReason: "worker_tree_attempt_budget_exhausted" });
			expect(
				startInternal.call(
					controllerAtMaterializationBoundary(capped.lifecycle, () => {
						throw sentinel;
					}),
					rootRerun,
					undefined,
					preparedAdmission,
				),
			).toEqual({ started: false, skipReason: "worker_tree_attempt_budget_exhausted" });
			expect(capped.lifecycle.getTaskRuntimeSnapshot()).toEqual(cappedBefore);

			const permittedBefore = permitted.lifecycle.getTaskRuntimeSnapshot();
			expect(() =>
				startInternal.call(
					controllerAtMaterializationBoundary(permitted.lifecycle, () => {
						throw sentinel;
					}),
					request,
					undefined,
					preparedAdmission,
				),
			).toThrow(sentinel);
			expect(() =>
				startInternal.call(
					controllerAtMaterializationBoundary(permitted.lifecycle, () => {
						throw sentinel;
					}),
					rootRerun,
					undefined,
					preparedAdmission,
				),
			).toThrow(sentinel);
			expect(permitted.lifecycle.getTaskRuntimeSnapshot()).toEqual(permittedBefore);
		} finally {
			rmSync(capped.directory, { recursive: true, force: true });
			rmSync(permitted.directory, { recursive: true, force: true });
		}
	});
});
