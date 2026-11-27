import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MechanicalDecisionEngine } from "../src/core/decision/engines/mechanical-decision-engine.ts";
import { createDecisionProgram } from "../src/core/decision/program.ts";
import {
	hasCurrentCorrectedOutcomeProof,
	reviewCorrectedGoalOutcome,
} from "../src/core/goals/goal-correction-proof.ts";
import { editPersistedGoal, getGoalStateRevision, matchesGoalStateRevision } from "../src/core/goals/goal-lifecycle.ts";
import { applyGoalEvent, createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../src/core/goals/goal-tool-core.ts";
import { RequirementCheckOutput } from "../src/core/goals/requirement-checks.ts";
import { requirementProofKey } from "../src/core/goals/requirement-proof.ts";
import { goalSourcePosition, recordGoalOwnerCorrection } from "../src/core/goals/session-goal-correction.ts";
import {
	appendGoalStateSnapshot,
	clearGoalStateJournal,
	getLatestGoalStateSnapshot,
} from "../src/core/goals/session-goal-state.ts";
import { projectBoundedCombinedState } from "../src/core/objective-execution/objective-route-projector.ts";
import {
	type EvidenceContract,
	MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE,
	ORCHESTRATION_SCHEMA_VERSION,
	toJsonObject,
} from "../src/core/orchestration/contracts.ts";
import { DelegationOrchestrationLedger } from "../src/core/orchestration/delegation-ledger.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { goalEvidenceMirrorId, goalEvidenceMirrorWithdrawals } from "../src/core/orchestration/goal-evidence-mirror.ts";
import { assertObjectiveSynchronization } from "../src/core/orchestration/objective-synchronization.ts";
import { projectionFromSnapshot } from "../src/core/orchestration/task-runtime-codecs.ts";
import { emptyProjection } from "../src/core/orchestration/task-runtime-projection.ts";
import {
	projectGoalAcceptanceEvidence,
	projectGoalObjective,
} from "../src/core/orchestration/work-state-projection.ts";
import { projectCanonicalTruth } from "../src/core/system-one/canonical-truth.ts";
import { terminalProofRef } from "../src/core/system-one/completion-proof.ts";
import { ExecutionStore } from "../src/core/system-one/execution-state.ts";
import { ownerOrchestrationHome, ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";
import { type GoalCommandHost, handleGoalCommand } from "../src/modes/interactive/session-flow-commands.ts";

const now = "2026-11-26T12:00:00.000Z";
const goal = createGoalState({ goalId: "g", userGoal: "Current objective", now });
const objective = {
	schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
	objectiveId: "goal:g",
	title: "g",
	description: "Old objective",
	riskBudget: {},
	constraints: [],
	status: "active" as const,
	acceptanceCriteria: [{ id: "r", description: "old criterion", required: true }],
	createdAt: now,
	updatedAt: now,
};
const receipt = (id: string): EvidenceContract => ({
	evidenceId: goalEvidenceMirrorId("g", "r", id),
	criterionId: "r",
	kind: "command",
	summary: "Ready",
	trusted: true,
	createdAt: now,
	artifactIds: [],
	metadata: { sourceGoalEvidenceId: id, sourceKind: "check" },
});

function sharedProofGoal(count: number, requirementText = "The recovery outcome holds.") {
	let state = goal;
	for (let index = 0; index < 12; index++) {
		state = applyGoalEvent(state, {
			type: "add_evidence",
			id: `receipt-${index}`,
			summary: `Host observation ${index}`,
			kind: "tool",
			uri: `tool:${index}`,
			verified: true,
			outcome: "succeeded",
			now,
		});
	}
	for (let index = 0; index < count; index++) {
		const id = `criterion-${index}`;
		state = applyGoalEvent(state, { type: "add_requirement", id, text: requirementText, now });
		state = applyGoalEvent(state, {
			type: "satisfy_requirement",
			id,
			evidenceIds: state.evidence.map((e) => e.id),
			proofKey: requirementProofKey(state.requirements.at(-1)!, state.evidence),
			now,
		});
	}
	return state;
}

describe("objective evidence synchronization", () => {
	it("keeps a delayed owner edit tied to the exact completion shown in the editor", async () => {
		const initial = applyGoalEvent(sharedProofGoal(1), { type: "complete_goal", now });
		const replacement = { ...initial, userGoal: "A different branch" };
		let current = initial;
		const saved: string[] = [];
		const host: GoalCommandHost = {
			session: {
				getGoalStateSnapshot: () => current,
				saveGoalStateSnapshot: (next, expected) => {
					if (expected && !matchesGoalStateRevision(current, expected))
						throw new Error("Goal state changed concurrently");
					current = next;
					saved.push(next.userGoal);
					return "saved";
				},
				restoreGoalRuntimeAfterResume: vi.fn(),
				continueGoalLoop: () => {
					throw new Error("Unexpected continuation");
				},
				getGoalRuntimeSnapshot: () => {
					throw new Error("Unexpected snapshot");
				},
			},
			refreshAutonomyFooterStatus: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			promptForGoalEdit: async () => {
				current = replacement;
				return "Correction to the first branch";
			},
		};
		await handleGoalCommand(host, "/goal edit").catch((error) =>
			expect(String(error)).toMatch(/changed|stale|concurrent/i),
		);
		expect(saved).toEqual([]);
		expect(current).toBe(replacement);
	});

	it("reopens an owner's correction once, withdraws prior acceptance, and keeps the completed worker result", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-owner-correction-"));
		try {
			const manager = SessionManager.inMemory(ownerSessionStorageRoots(dir), dir);
			const options = {
				goalSourcePosition: (goal: GoalState) => goalSourcePosition(manager, goal),
				orchestrationHome: ownerOrchestrationHome(dir),
				sessionId: "owner-correction",
				now: () => Date.parse(now),
			};
			const ledger = new DelegationOrchestrationLedger(options);
			const original = sharedProofGoal(1);
			appendGoalStateSnapshot(manager, original);
			ledger.synchronizeGoalState(original);
			const id = projectGoalObjective(original).objectiveId;
			const queued = ledger.runtime.prepareTaskAttempt(
				{
					taskId: "first-task",
					objectiveId: id,
					title: "Review",
					description: "Record the first review",
					role: "implementer",
				},
				{ taskId: "first-task", profileId: "reader", instructions: "Review the evidence", resourcePointerIds: [] },
			);
			const lease = ledger.start(queued.attempt.attemptId, 60_000);
			ledger.runtime.finishAttempt({
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				resultId: "original-result",
				objectiveId: id,
				taskId: queued.attempt.taskId,
				attemptId: queued.attempt.attemptId,
				leaseId: lease.leaseId,
				fencingToken: lease.fencingToken,
				status: "completed",
				reasonCode: "done",
				summary: "Original work completed",
				artifacts: [],
				evidence: [],
				errors: [],
				usage: { wallClockMs: 1, toolCalls: 0 },
				createdAt: now,
			});
			const independent = { ...receipt("operator-observation"), criterionId: "criterion-0", metadata: {} };
			ledger.runtime.recordObjectiveEvidence(id, independent);
			const completed = applyGoalEvent(original, { type: "complete_goal", now });
			const completionEntry = appendGoalStateSnapshot(manager, completed, original);
			expect(() =>
				clearGoalStateJournal(manager, completed, now, (pending) => {
					expect(pending.status).toBe("completed");
					throw new Error("completion write pending");
				}),
			).toThrow("completion write pending");
			expect(goalSourcePosition(manager, completed)?.goalEntryId).toBe(completionEntry);
			ledger.synchronizeGoalState(completed);
			const closed = ledger.runtime.getSnapshot();
			expect(closed.objectives[id]?.objective.status).toBe("completed");
			const edit = editPersistedGoal(
				{
					getGoalStateSnapshot: () => getLatestGoalStateSnapshot(manager),
					saveGoalStateSnapshot: (state) => appendGoalStateSnapshot(manager, state),
					recordGoalOwnerCorrection: (state, objective, at, entry) =>
						recordGoalOwnerCorrection(manager, state, objective, at, entry),
				},
				{
					userGoal: "Confirm recovery and verify sustained movement",
					expected: getGoalStateRevision(completed),
					expectedEntryId: completionEntry,
				},
				now,
			);
			if (!edit.ok) throw new Error(edit.error);
			const amended = edit.state;
			expect(amended.goalId).toBe(completed.goalId);
			expect(amended.createdAt).toBe(completed.createdAt);
			expect(applyGoalAction(amended, { action: "complete" }, now).ok).toBe(false);
			const restored = new DelegationOrchestrationLedger(options);
			restored.synchronizeGoalState(amended);
			const reopened = restored.runtime.getSnapshot();
			expect(reopened.lastOrdinal).toBe(closed.lastOrdinal + 1);
			expect(reopened.objectives[id]?.objective.status).toBe("active");
			expect(reopened.objectives[id]?.evidence).toEqual([independent]);
			expect(projectBoundedCombinedState(id, reopened).integrity.fresh_evidence).toEqual([]);
			expect(() => restored.runtime.completeObjectiveFromOwner(id, false)).toThrow();
			expect(reopened.tasks[queued.attempt.taskId]).toEqual(closed.tasks[queued.attempt.taskId]);
			expect(reopened.attempts[queued.attempt.attemptId]).toEqual(closed.attempts[queued.attempt.attemptId]);
			restored.synchronizeGoalState(amended);
			expect(restored.runtime.getSnapshot().lastOrdinal).toBe(reopened.lastOrdinal);
			restored.runtime.createTask({
				taskId: "amended-work",
				objectiveId: id,
				title: "Recheck",
				description: "Observe sustained movement",
				role: "implementer",
			});
			const store = new ExecutionStore({
				run_id: "correction",
				objective: { request: original.userGoal, normalized_goal: original.userGoal, acceptance_criteria: [] },
				repo: { root: dir, baseline_revision: "same-commit" },
			});
			const priorRef = terminalProofRef({ objectiveId: id, candidateDigest: "same-tree" });
			expect(store.noteTerminalProof(priorRef).outcome).toBe("applied");
			const hydration = projectCanonicalTruth({ goal: amended, runtime: reopened, currentRevision: "same-commit" });
			expect(store.hydrateFromCanonical(hydration)).toBe(true);
			expect(store.snapshot().completion.final_summary_ref).toBeNull();
			const nextRef = terminalProofRef({
				objectiveId: id,
				candidateDigest: "same-tree",
				ownerCorrectionEntryId: amended.ownerCorrection!.ownerEntryId,
			});
			expect(nextRef).not.toBe(priorRef);
			expect(store.noteTerminalProof(nextRef).outcome).toBe("applied");
			expect(store.hydrateFromCanonical(hydration)).toBe(false);
			expect(store.classifyTerminalProof(nextRef).outcome).toBe("duplicate");
			const correctedCompletion = applyGoalEvent(amended, { type: "complete_goal_manually", now });
			const correctedEntry = appendGoalStateSnapshot(manager, correctedCompletion, amended);
			restored.synchronizeGoalState(correctedCompletion);
			const settled = restored.runtime.getSnapshot();
			expect(settled.objectives[id]?.objective.status).toBe("completed");
			const retry = new DelegationOrchestrationLedger(options);
			expect(() => retry.synchronizeGoalState(amended)).toThrow();
			manager.branch(completionEntry);
			let divergent = completed;
			for (let index = 0; index < 4; index++)
				divergent = applyGoalEvent(divergent, {
					type: "add_evidence",
					id: `other-${index}`,
					summary: "Another branch",
					kind: "finding",
					now,
				});
			appendGoalStateSnapshot(manager, divergent, completed);
			expect(() => retry.synchronizeGoalState(divergent)).toThrow();
			expect(retry.runtime.getSnapshot()).toEqual(settled);
			manager.branch(correctedEntry);
			const last = getLatestGoalStateSnapshot(manager)!;
			const correction = recordGoalOwnerCorrection(
				manager,
				last,
				"Verify the restored session",
				now,
				correctedEntry,
			);
			const second = applyGoalEvent(last, { type: "correct_completed_goal", correction, now });
			appendGoalStateSnapshot(manager, second, last);
			// The prior reopen never reached the objective journal. Clear must still deliver cancellation.
			expect(() =>
				clearGoalStateJournal(manager, second, now, () => {
					throw new Error("storage busy");
				}),
			).toThrow("storage busy");
			const cancellation = getLatestGoalStateSnapshot(manager)!;
			expect(cancellation.status).toBe("cancelled");
			clearGoalStateJournal(manager, cancellation, now, (state) => retry.synchronizeGoalState(state));
			expect(getLatestGoalStateSnapshot(manager)).toBeUndefined();
			expect(retry.runtime.getSnapshot().objectives[id]?.objective.status).toBe("cancelled");
			expect(retry.runtime.getSnapshot().attempts[queued.attempt.attemptId]).toEqual(
				closed.attempts[queued.attempt.attemptId],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([0, 1, 256])("requires the added outcome when the amended goal has %i existing criteria", async (count) => {
		const original = sharedProofGoal(count, "The recovery package is staged.");
		const completed = applyGoalEvent(original, { type: "complete_goal_manually", now });
		const target = completed.revision ?? 0;
		const corrected = applyGoalEvent(completed, {
			type: "correct_completed_goal",
			correction: {
				ownerEntryId: "owner",
				targetCompletionEntryId: "completion",
				targetCompletionRevision: target,
				revision: target + 1,
				objective: "Stage the package and verify live recovery.",
			},
			now,
		});
		let current = corrected;
		for (const requirement of corrected.requirements) {
			current = applyGoalEvent(current, {
				type: "satisfy_requirement",
				id: requirement.id,
				evidenceIds: current.evidence.map((item) => item.id),
				proofKey: requirementProofKey(requirement, current.evidence),
				now,
			});
		}
		const port = {
			engine: () => ({
				evaluate: async (_program: unknown, input?: Record<string, unknown>) => ({
					answers: {
						covered: {
							type: "noul" as const,
							noul: JSON.stringify(input?.observations).includes("recovered on the live host") ? 0.99 : 0.01,
						},
					},
				}),
			}),
			observe: (item: GoalState["evidence"][number]) => (item.id.startsWith("missing-") ? undefined : item.summary),
		};
		const denied = await reviewCorrectedGoalOutcome(current, now, port);
		expect(hasCurrentCorrectedOutcomeProof(denied)).toBe(false);
		expect(
			applyGoalAction(denied, { action: "complete" }, now, { requireVerifiedEvidenceForCompletion: false }).ok,
		).toBe(false);
		const measured = applyGoalEvent(denied, {
			type: "add_evidence",
			kind: "tool",
			id: "live",
			uri: "tool:live",
			summary: "The staged package recovered on the live host.",
			verified: true,
			outcome: "succeeded",
			now,
		});
		expect(await reviewCorrectedGoalOutcome(measured, now, { ...port, engine: () => undefined })).toBe(measured);
		let withMissing = measured;
		for (let i = 0; i < 12; i++) {
			withMissing = applyGoalEvent(withMissing, {
				type: "add_evidence",
				kind: "tool",
				id: `missing-${i}`,
				uri: `tool:missing-${i}`,
				summary: "Receipt unavailable",
				verified: true,
				outcome: "succeeded",
				now,
			});
		}
		const accepted = await reviewCorrectedGoalOutcome(withMissing, now, port);
		expect(accepted.ownerCorrectionEvidenceIds).toContain("live");
		expect(accepted.ownerCorrectionEvidenceIds?.some((id) => id.startsWith("missing-"))).toBe(false);
		expect(hasCurrentCorrectedOutcomeProof(accepted)).toBe(true);
		expect(applyGoalAction(accepted, { action: "complete" }, now).ok).toBe(true);
	});

	it("projects 516 accepted citation links into 43 records and keeps each full proof on the goal", () => {
		const state = sharedProofGoal(43);
		const rows = projectGoalAcceptanceEvidence(state);
		expect(rows).toHaveLength(43);
		expect(new Set(rows.map((row) => row.evidenceId)).size).toBe(43);
		expect(rows.map((row) => row.criterionId)).toEqual(state.requirements.map((req) => req.id));
		for (const [index, row] of rows.entries()) {
			expect(row.metadata?.citationCount).toBe(12);
			expect(row.metadata?.sourceProofKey).toBe(state.requirements[index]!.proofKey);
			expect(row.metadata?.sourceRequirementId).toBe(state.requirements[index]!.id);
		}
		expect(state.requirements.every((req) => req.evidenceIds.length === 12)).toBe(true);
		expect(JSON.stringify(rows)).not.toContain("Host observation 0");
		const independent = Array.from({ length: 512 }, (_, i) => ({
			...receipt(String(i)),
			criterionId: "criterion-0",
			metadata: {},
		}));
		const projected = projectGoalObjective(state);
		const before = {
			...emptyProjection(),
			objectives: { "goal:g": { objective: { ...objective, ...projected }, taskIds: [], evidence: independent } },
		};
		expect(() => assertObjectiveSynchronization(before, projected, rows, [], now, () => undefined)).not.toThrow();
		const saved = {
			...before,
			objectives: { "goal:g": { ...before.objectives["goal:g"], evidence: [...independent, ...rows] } },
		};
		expect(projectionFromSnapshot(toJsonObject(saved), 0).objectives["goal:g"]?.evidence).toHaveLength(555);
	});

	it("bounds criterion text in the durable objective while the reviewer reads every clause of the full definition", () => {
		const text = `${"界".repeat(3_900)} final acceptance clause`;
		const state = sharedProofGoal(256, text);
		const projected = projectGoalObjective(state);
		const rows = projectGoalAcceptanceEvidence(state);
		expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThan(1024 * 1024);
		expect(projected.acceptanceCriteria.every((criterion) => criterion.description.length > 0)).toBe(true);
		expect(() =>
			assertObjectiveSynchronization(emptyProjection(), projected, rows, [], now, () => undefined),
		).not.toThrow();
		expect(projectCanonicalTruth({ goal: state, currentRevision: "current" }).acceptance_criteria[255]?.text).toBe(
			text,
		);
	});

	it("migrates old goal mirrors through the ledger, preserves foreign evidence, and withdraws expired coverage after restore", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-goal-mirror-"));
		try {
			const options = {
				orchestrationHome: ownerOrchestrationHome(dir),
				sessionId: "coverage",
				now: () => Date.parse(now),
			};
			const ledger = new DelegationOrchestrationLedger(options);
			const state = sharedProofGoal(2);
			const projected = projectGoalObjective(state);
			ledger.runtime.ensureObjective(projected);
			const legacy = {
				...receipt("receipt-0"),
				criterionId: "criterion-0",
				evidenceId: goalEvidenceMirrorId("g", "criterion-0", "receipt-0"),
			};
			const primary = projectGoalAcceptanceEvidence(state)[0]!;
			expect(() => ledger.runtime.recordObjectiveEvidence(projected.objectiveId, primary)).toThrow();
			expect(() => ledger.runtime.recordObjectiveEvidence(projected.objectiveId, legacy)).toThrow();
			const foreign = { ...legacy, evidenceId: primary.evidenceId, metadata: {} };
			const store = new OrchestrationEventStore({
				orchestrationHome: options.orchestrationHome,
				sessionId: options.sessionId,
			});
			store.append({
				type: "objective.evidence_recorded",
				aggregateId: projected.objectiveId,
				actor: "kernel",
				payload: toJsonObject({ evidence: legacy }),
			});
			ledger.runtime.recordObjectiveEvidence(projected.objectiveId, foreign);
			const beforeMigration = ledger.runtime.getSnapshot().lastOrdinal;
			expect(() => ledger.runtime.ensureObjective({ ...projected, acceptanceCriteria: [] })).toThrow(
				/unknown acceptance criterion/,
			);
			expect(ledger.runtime.getSnapshot().lastOrdinal).toBe(beforeMigration);
			ledger.synchronizeGoalState(state);
			const first = ledger.runtime.getSnapshot();
			expect(first.lastOrdinal).toBe(beforeMigration + 1);
			const records = first.objectives[projected.objectiveId]!.evidence;
			expect(records).toContainEqual(foreign);
			expect(records).not.toContainEqual(legacy);
			expect(records).toHaveLength(3);
			ledger.synchronizeGoalState(state);
			expect(ledger.runtime.getSnapshot().lastOrdinal).toBe(first.lastOrdinal);
			const restored = new DelegationOrchestrationLedger(options);
			restored.synchronizeGoalState(applyGoalEvent(state, { type: "reopen_requirement", id: "criterion-0", now }));
			expect(restored.runtime.getSnapshot().lastOrdinal).toBe(first.lastOrdinal + 1);
			const remaining = restored.runtime.getSnapshot().objectives[projected.objectiveId]!.evidence;
			expect(remaining).toContainEqual(foreign);
			expect(remaining.filter((item) => item.criterionId === "criterion-1")).toHaveLength(1);
			expect(remaining).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([65, 256, 257])("preflights the same criterion cardinality the goal can persist (%i)", (count) => {
		const acceptanceCriteria = Array.from({ length: count }, (_, index) => ({
			id: String(index),
			description: "criterion",
			required: true,
		}));
		const admit = () =>
			assertObjectiveSynchronization(
				emptyProjection(),
				{ ...objective, acceptanceCriteria },
				[],
				[],
				now,
				() => undefined,
			);
		if (count <= 256) expect(admit).not.toThrow();
		else expect(admit).toThrow();
	});

	it("keeps the durable objective and all receipts when the journal refuses a replacement", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-goal-atomic-"));
		try {
			const options = { orchestrationHome: ownerOrchestrationHome(dir), sessionId: "atomic" };
			let storeNow = now;
			const store = new OrchestrationEventStore({ ...options, maxTailBytes: 16 * 1024, now: () => storeNow });
			const ledger = new DelegationOrchestrationLedger({ ...options, store, now: () => Date.parse(now) });
			ledger.synchronizeGoalState(sharedProofGoal(1));
			const before = ledger.runtime.getSnapshot();
			expect(() => ledger.synchronizeGoalState(sharedProofGoal(43))).toThrow(/byte limit/);
			expect(ledger.runtime.getSnapshot()).toEqual(before);
			const paused = applyGoalEvent(sharedProofGoal(1), { type: "pause_goal", now });
			storeNow = "2026-11-25T12:00:00.000Z";
			expect(() => ledger.synchronizeGoalState(paused)).toThrow(/clock/);
			expect(new DelegationOrchestrationLedger(options).runtime.getSnapshot()).toEqual(before);
			storeNow = now;
			ledger.synchronizeGoalState(paused);
			const after = ledger.runtime.getSnapshot();
			expect(after.objectives["goal:g"]?.objective.status).toBe("paused");
			expect(after.lastOrdinal).toBe(before.lastOrdinal + 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves ordinary identifiers and distinguishes ambiguous component boundaries", () => {
		expect(goalEvidenceMirrorId("g", "r", "i")).toBe("goal-evidence:g:r:i");
		expect(goalEvidenceMirrorId("g", "r:x", "i")).not.toBe(goalEvidenceMirrorId("g", "r", "x:i"));
	});

	it("retains an independent receipt with a mirror-like name and reads the current goal's empty criteria", () => {
		const mirrored = receipt("old");
		const independent = { ...receipt("independent"), metadata: {} };
		const annotated = receipt("runbook");
		annotated.metadata = { ...annotated.metadata, recordedBy: "operator" };
		const evidence = [mirrored, independent, annotated];
		expect(goalEvidenceMirrorWithdrawals(evidence, [], "g")).toEqual([mirrored.evidenceId]);
		const runtime = { ...emptyProjection(), objectives: { "goal:g": { objective, taskIds: [], evidence } } };
		const truth = projectCanonicalTruth({ goal, runtime, currentRevision: "next" });
		expect(truth.normalized_goal).toBe(goal.userGoal);
		expect(truth.acceptance_criteria).toEqual([]);
		expect(truth.observations.map((item) => item.id)).toEqual([
			`OBS-${independent.evidenceId}`,
			`OBS-${annotated.evidenceId}`,
		]);
	});

	it("validates a full objective against the net replacement before withdrawal", () => {
		const evidence = Array.from({ length: MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE }, (_, i) => receipt(String(i)));
		const retained = { ...emptyProjection(), objectives: { "goal:g": { objective, taskIds: [], evidence } } };
		const replacement = receipt("new");
		const withdrawn = [evidence[0]!.evidenceId];
		const check = (item: EvidenceContract, remove: string[]) =>
			assertObjectiveSynchronization(retained, objective, [item], remove, now, (required) => {
				expect(required.evidence).toBe(0);
			});
		expect(() => check(replacement, withdrawn)).not.toThrow();
		expect(() => check(replacement, [])).toThrow();
		expect(() => check({ ...replacement, createdAt: "invalid" }, withdrawn)).toThrow();
		expect(retained.objectives["goal:g"].evidence[0]!.evidenceId).toBe(withdrawn[0]);
	});
});

it.each(["outputContains", "outputExcludes"] as const)(
	"judges %s across chunk boundaries and beyond the retained output tail",
	(predicate) => {
		const output = new RequirementCheckOutput({ command: "read-status", [predicate]: "READY" });
		output.append("start RE");
		output.append("ADY");
		output.append(".".repeat(8000));
		expect(output.tail).not.toContain("READY");
		expect(output.judge(0).passed).toBe(predicate === "outputContains");
	},
);

it("routes only on this objective's ready work and explicitly linked trusted evidence", async () => {
	const runtime = emptyProjection();
	const accepted = { ...receipt("accepted"), criterionId: "ready-proof" };
	const unrelated = { ...receipt("orphan"), criterionId: undefined, evidenceId: "unproven" };
	const untrusted = { ...receipt("untrusted"), criterionId: "unproven", trusted: false };
	runtime.objectives = {
		"goal:g": {
			objective: {
				...objective,
				acceptanceCriteria: [
					{ id: "unproven", description: "Needs proof", required: true },
					{ id: "ready-proof", description: "Verified", required: true },
					{ id: "optional", description: "Supplemental", required: false },
				],
			},
			taskIds: ["ready", "pending"],
			evidence: [unrelated, untrusted, accepted],
		},
	};
	function addTask(id: string, objectiveId: string, status: "ready" | "pending") {
		runtime.tasks = {
			...runtime.tasks,
			[id]: {
				attemptIds: [],
				task: {
					schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
					taskId: id,
					objectiveId,
					title: id,
					description: id,
					role: "implementer",
					status,
					requiredCapabilities: [],
					dependsOn: [],
					acceptanceCriterionIds: [],
					riskBudget: {},
					createdAt: now,
					updatedAt: now,
				},
			},
		};
	}
	addTask("ready", "goal:g", "ready");
	addTask("pending", "goal:g", "pending");
	addTask("foreign", "goal:other", "ready");
	runtime.attempts = {
		outside: {
			attemptId: "outside",
			taskId: "foreign",
			status: "running",
			createdAt: now,
			updatedAt: now,
			checkpointIds: [],
			dispatch: { taskId: "foreign", profileId: "p", instructions: "Other objective", resourcePointerIds: [] },
		},
	};
	const routed = projectBoundedCombinedState("goal:g", runtime);
	expect(routed.objective.required_criteria).toEqual(["unproven", "ready-proof"]);
	expect(routed.runtime.ready_tasks).toEqual(["ready"]);
	expect(routed.runtime.incomplete_task_count).toBe(2);
	expect(routed.runtime.running_attempts).toEqual([]);
	expect(routed.integrity.fresh_evidence).toEqual(["ready-proof"]);

	const engine = new MechanicalDecisionEngine();
	const program = createDecisionProgram({
		id: "objective-readiness",
		decisions: [{ id: "work_remaining", kind: "boolean", instruction: "Does work remain?" }],
	});
	runtime.objectives["goal:g"]!.objective.acceptanceCriteria = [];
	runtime.tasks = { pending: runtime.tasks.pending!, foreign: runtime.tasks.foreign! };
	const pendingOnly = await engine.evaluate(program, projectBoundedCombinedState("goal:g", runtime));
	expect(pendingOnly.results.work_remaining).toMatchObject({ probabilityTrue: 1 });
	runtime.tasks = { foreign: runtime.tasks.foreign! };
	const settled = await engine.evaluate(program, projectBoundedCombinedState("goal:g", runtime));
	expect(settled.results.work_remaining).toMatchObject({ probabilityTrue: 0 });
});
