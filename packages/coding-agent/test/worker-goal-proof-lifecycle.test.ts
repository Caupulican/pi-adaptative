import { expect, it } from "vitest";
import type { WorkerClaim } from "../src/core/autonomy/contracts.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../src/core/goals/goal-tool-core.ts";
import { recordHostRequirementCheckProof } from "../src/core/goals/prove-requirement-checks.ts";
import {
	attachCurrentWorkerEvidence,
	currentGoalRequirements,
	requirementKey,
} from "../src/core/goals/requirement-proof.ts";
import {
	acceptedWorkerEvidenceId,
	currentWorkerEvidenceIds,
	currentWorkerRequirementAttempt,
	recordAcceptedWorkerRequirementEvidence,
} from "../src/core/goals/worker-requirement-evidence.ts";
import { sameGoalExecution } from "../src/core/objective-execution/current-objective-execution.ts";
import { SessionObjectiveRuntime } from "../src/core/objective-execution/session-objective-runtime.ts";
import { ORCHESTRATION_SCHEMA_VERSION } from "../src/core/orchestration/contracts.ts";
import { emptyProjection } from "../src/core/orchestration/task-runtime-projection.ts";

const now = "2026-11-26T12:00:00.000Z";
function fixture(checked = false) {
	let goal = applyGoalEvent(createGoalState({ goalId: "g", userGoal: "Verify recovery", now }), {
		type: "add_requirement",
		id: "r",
		text: "Recovery",
		now,
		...(checked ? { check: { command: "read-status" } } : {}),
	});
	const definition = requirementKey(goal.requirements[0]!);
	const runtime = emptyProjection();
	const claims: WorkerClaim[] = [];
	function add(lane: string, sequence: number, attemptId: string) {
		const taskId = `${lane}:turn:${sequence}`;
		const task = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			objectiveId: "goal:g",
			taskId,
			title: "Read status",
			description: "Read status",
			role: "implementer" as const,
			status: "completed" as const,
			dependsOn: [],
			requiredCapabilities: [],
			acceptanceCriterionIds: ["r"],
			riskBudget: {},
			createdAt: now,
			updatedAt: now,
		};
		runtime.tasks = {
			...runtime.tasks,
			[taskId]: { task, attemptIds: [...(runtime.tasks[taskId]?.attemptIds ?? []), attemptId] },
		};
		runtime.attempts = {
			...runtime.attempts,
			[attemptId]: {
				attemptId,
				taskId,
				status: "completed",
				createdAt: now,
				updatedAt: now,
				checkpointIds: [],
				dispatch: {
					logicalLaneId: lane,
					dispatchSequence: sequence,
					executionKind: "managed-process",
					goalRequirementKeys: [definition],
					requirementIds: ["r"],
					taskId,
					profileId: "reader",
					instructions: "Read status",
					resourcePointerIds: [],
				},
			},
		};
	}
	function accept(lane: string, attempt: string) {
		claims.push({
			requestId: lane,
			terminalAttemptId: attempt,
			status: "completed",
			summary: "Ready",
			changedFiles: [],
			parentReviewRequired: false,
			hostVerdict: {
				verdict: "accepted",
				coveredRequirementIds: ["r"],
				missing: [],
				reasonCodes: [],
				at: now,
				judgedBy: "code",
			},
		});
	}
	function read() {
		return attachCurrentWorkerEvidence(goal, currentWorkerEvidenceIds(goal, runtime, claims));
	}
	const writer = {
		getGoalState: read,
		saveGoalState: (next: typeof goal) => {
			goal = next;
			return "saved";
		},
		getTaskRuntimeSnapshot: () => runtime,
		getWorkerClaimSnapshots: () => claims,
		now: () => now,
		warn: () => {},
		isCheckCoverageEstablished: () => true,
	};
	function satisfy(id: string) {
		const result = applyGoalAction(
			read(),
			{ action: "satisfy_requirement", requirementId: "r", evidenceIds: [id] },
			now,
		);
		if (!result.ok) throw new Error(result.error);
		goal = result.state;
	}
	return { runtime, writer, definition, read, accept, add, satisfy };
}

it("revokes an older turn across task IDs, keeps an independent lane and mints the accepted replacement", () => {
	const f = fixture();
	f.add("primary", 1, "old");
	f.accept("primary", "old");
	recordAcceptedWorkerRequirementEvidence(f.writer);
	const old = acceptedWorkerEvidenceId("old", "r");
	f.add("other", 1, "independent");
	f.accept("other", "independent");
	recordAcceptedWorkerRequirementEvidence(f.writer);
	const independent = acceptedWorkerEvidenceId("independent", "r");
	f.satisfy(old);
	f.add("primary", 2, "new");
	f.add("primary", 1, "late-retry");
	expect(currentGoalRequirements(f.read())[0]?.status).toBe("open");
	expect(currentWorkerRequirementAttempt(f.runtime, f.read(), "r", "late-retry")).toBe(false);
	expect(currentWorkerRequirementAttempt(f.runtime, f.read(), "r", "independent")).toBe(true);
	f.accept("primary", "new");
	const replacement = acceptedWorkerEvidenceId("new", "r");
	recordAcceptedWorkerRequirementEvidence(f.writer);
	expect(f.read().evidence.map((item) => item.id)).toContain(replacement);
	f.satisfy(replacement);
	expect(currentGoalRequirements(f.read())[0]?.status).toBe("satisfied");
	f.satisfy(independent);
	expect(currentGoalRequirements(f.read())[0]?.status).toBe("satisfied");
});

it("charges an executor refusal to the requirement whose worker proof expired", () => {
	const f = fixture();
	f.add("primary", 1, "old");
	f.accept("primary", "old");
	recordAcceptedWorkerRequirementEvidence(f.writer);
	f.satisfy(acceptedWorkerEvidenceId("old", "r"));
	f.add("primary", 2, "new");
	const owner = new SessionObjectiveRuntime({
		get runtime(): never {
			throw new Error("Unexpected durable runtime access");
		},
		cwd: process.cwd(),
		getGoalState: f.read,
		saveGoalState: f.writer.saveGoalState,
		emitWarning: () => {},
		synchronizeGoalState: () => {},
	});
	owner.recordExecutorRefusal(
		"goal:g",
		{
			schema_version: "1.0",
			cycle_id: "cycle",
			objective_id: "goal:g",
			route: "verify",
			reason_codes: [],
			target_requirement_ids: ["r"],
		},
		["no_verifier"],
	);
	expect(f.read().requirements[0]).toMatchObject({ status: "open", executorRefusal: { attempts: 1 } });
	expect(f.read().executorRefusal).toBeUndefined();
});

it.each(["stable", "accounting", "pause_resume", "new_turn"] as const)(
	"guards worker measurement and satisfaction writes (%s)",
	async (transition) => {
		const f = fixture(true);
		f.add("lane", 1, "first");
		const captured = f.read();
		if (transition === "pause_resume")
			f.writer.saveGoalState(
				applyGoalEvent(applyGoalEvent(captured, { type: "pause_goal", now }), { type: "resume_goal", now }),
			);
		if (transition === "accounting")
			f.writer.saveGoalState(
				applyGoalEvent(captured, {
					type: "record_continuation_budget",
					turns: 0,
					tokens: 1,
					spendUsd: 0,
					wallClockMs: 1,
					now,
				}),
			);
		if (transition === "new_turn") f.add("lane", 2, "next");
		const fresh = await recordHostRequirementCheckProof(f.writer, {
			attemptId: "first",
			goalId: "g",
			requirementId: "r",
			definition: f.definition,
			result: { passed: true, reason: "ready", output: "ready", exitCode: 0 },
			now: () => now,
			expectedLatestCheck: { evidenceId: undefined },
			isCurrentAttempt: () =>
				sameGoalExecution(captured, f.read()) && currentWorkerRequirementAttempt(f.runtime, f.read(), "r", "first"),
		});
		const expected = transition === "stable" || transition === "accounting";
		expect(fresh).toBe(expected);
		expect(f.read().evidence.length).toBe(expected ? 1 : 0);
		expect(currentGoalRequirements(f.read())[0]?.status).toBe(expected ? "satisfied" : "open");
	},
);

it("keeps the observation in history and refuses satisfaction if a new worker turn starts during review", async () => {
	const f = fixture(true);
	f.add("lane", 1, "first");
	const captured = f.read();
	await recordHostRequirementCheckProof(
		{
			...f.writer,
			isCheckCoverageEstablished: () => false,
			coverageEngine: () => ({
				evaluate: async () => {
					f.add("lane", 2, "new");
					return { answers: { covered_0: { type: "noul", noul: 0.99 } } };
				},
			}),
		},
		{
			attemptId: "first",
			goalId: "g",
			requirementId: "r",
			definition: f.definition,
			result: { passed: true, reason: "ready", output: "ready", exitCode: 0 },
			now: () => now,
			expectedLatestCheck: { evidenceId: undefined },
			isCurrentAttempt: () =>
				sameGoalExecution(captured, f.read()) && currentWorkerRequirementAttempt(f.runtime, f.read(), "r", "first"),
		},
	);
	const live = f.read();
	expect(live.evidence[0]?.sourceAttemptId).toBe("first");
	expect(live.requirements[0]?.status).toBe("open");
});
