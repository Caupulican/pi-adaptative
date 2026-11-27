import { describe, expect, it, vi } from "vitest";
import { requirementKey } from "../src/core/goals/goal-acceptance.ts";
import { goalEvidenceHasRoom, MAX_GOAL_EVIDENCE } from "../src/core/goals/goal-evidence-ledger.ts";
import { buildGoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { GoalSessionController } from "../src/core/goals/goal-session-controller.ts";
import { clearSessionGoal, saveSessionGoal } from "../src/core/goals/goal-snapshot-admission.ts";
import { applyGoalEvent, createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../src/core/goals/goal-tool-core.ts";
import { proveRequirementChecks, recordHostRequirementCheckProof } from "../src/core/goals/prove-requirement-checks.ts";
import {
	appendGoalClearedSnapshot,
	appendGoalStateSnapshot,
	GOAL_STATE_CUSTOM_TYPE,
	getLatestGoalStateSnapshot,
	goalIdentityConflict,
	hasRecordedGoalEvidence,
} from "../src/core/goals/session-goal-state.ts";
import { acceptedWorkerEvidenceId } from "../src/core/goals/worker-requirement-evidence.ts";
import { GoalExecutionCustody } from "../src/core/objective-execution/current-objective-execution.ts";
import { SYSTEM_TIMER_SOURCE } from "../src/core/util/timer-port.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

const now = "2026-11-26T12:00:00.000Z";
const passed = { passed: true, exitCode: 0, output: "ready", reason: "The service responded." };
const failed = { passed: false, exitCode: 1, output: "unavailable", reason: "The service did not respond." };

function checkedGoal(requirements = 1): GoalState {
	let state = createGoalState({ goalId: "retention", userGoal: "Observe readiness", now });
	for (let index = 0; index < requirements; index++) {
		state = applyGoalEvent(state, {
			type: "add_requirement",
			id: `ready-${index}`,
			text: `Observe service ${index} readiness`,
			check: { command: `read-service-${index}` },
			now,
		});
	}
	return state;
}

function withFullOrdinaryEvidence(state: GoalState): GoalState {
	return {
		...state,
		evidence: [
			...state.evidence,
			...Array.from({ length: MAX_GOAL_EVIDENCE }, (_, index) => ({
				id: `ordinary-${index}`,
				kind: "file" as const,
				summary: `Artifact ${index}`,
				uri: `artifact-${index}.json`,
				verified: true,
				createdAt: now,
			})),
		],
	};
}

describe("goal check evidence retention", () => {
	it.each([
		"different creation time",
		"same clock after clear",
		"same clock after completion",
		"higher revision after completion",
	])("recognizes historical ID reuse on restore (%s)", (variant) => {
		const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
		const state = checkedGoal();
		const original = manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 1, state });
		const terminal = variant.endsWith("after completion")
			? appendGoalStateSnapshot(manager, applyGoalEvent(state, { type: "complete_goal_manually", now }), state)
			: appendGoalClearedSnapshot(manager, state, now);
		manager.branch(original);
		manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 2, kind: "checkpoint", state });
		expect(goalIdentityConflict(manager, state)).toBeUndefined();
		manager.branch(terminal);
		let next = createGoalState({
			goalId: state.goalId,
			userGoal: "Different work",
			now: variant === "different creation time" ? "2026-11-27T12:00:00.000Z" : now,
		});
		if (variant === "higher revision after completion")
			for (const id of ["one", "two", "three"])
				next = applyGoalEvent(next, { type: "add_requirement", id, text: id, now });
		manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 2, kind: "checkpoint", state: next });
		expect(goalIdentityConflict(manager, next)).toMatch(/multiple durable lifetimes/);
		const runtime = buildGoalRuntimeSnapshot({ sessionManager: manager, settings: { maxStallTurns: 3 } });
		expect(runtime.continuation).toMatchObject({ action: "waiting", reasonCode: "goal_identity_conflict" });
		const synchronizeGoalState = vi.fn();
		const controller = new GoalSessionController({
			getSessionManager: () => manager,
			timers: SYSTEM_TIMER_SOURCE,
			getModel: () => undefined,
			runtimeFacts: () => ({}),
			getOwnerEvidence: () => {
				throw new Error("Unexpected owner evidence access");
			},
			synchronizeGoalState,
			scheduleGoalAutoContinueFromIdle: vi.fn(),
			prompt: vi.fn(async () => {}),
			getForegroundSubmissionEpoch: () => 1,
			emitWarning: vi.fn(),
		});
		expect(() => controller.beginExecution(next.goalId)).toThrow(/multiple durable lifetimes/);
		controller.clearState(controller.getState()!, now);
		expect(synchronizeGoalState).not.toHaveBeenCalled();
		expect(controller.getState()).toBeUndefined();
		const fresh = createGoalState({ goalId: "fresh", userGoal: next.userGoal, now });
		expect(() => appendGoalStateSnapshot(manager, fresh)).not.toThrow();
		expect(goalIdentityConflict(manager, fresh)).toBeUndefined();
	});

	it("recognizes an explicit same-lifetime reopen in the journal before a later checkpoint", () => {
		const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
		const state = applyGoalEvent(checkedGoal(), { type: "satisfy_requirement", id: "ready-0", evidenceIds: [], now });
		appendGoalStateSnapshot(manager, state);
		const completed = applyGoalEvent(state, { type: "complete_goal", now });
		expect(completed.status).toBe("completed");
		appendGoalStateSnapshot(manager, completed, state);
		const reopened = applyGoalEvent(completed, {
			type: "reopen_unproven_completion",
			reason: "Measurement expired",
			now,
		});
		appendGoalStateSnapshot(manager, reopened, completed);
		manager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, { version: 2, kind: "checkpoint", state: reopened });
		expect(goalIdentityConflict(manager, reopened)).toBeUndefined();
	});

	it("keeps a used goal ID allocated through completion, clearing and a branch switch", () => {
		const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
		const root = manager.appendCustomEntry("root", {});
		const state = checkedGoal();
		appendGoalStateSnapshot(manager, state);
		const completed = applyGoalEvent(state, { type: "complete_goal_manually", now });
		appendGoalStateSnapshot(manager, completed, state);
		const start = { action: "start" as const, goalId: state.goalId, userGoal: "Second lifetime" };
		expect(applyGoalAction(completed, start, now)).toMatchObject({
			ok: false,
			error: expect.stringMatching(/new goal ID/),
		});
		appendGoalClearedSnapshot(manager, completed, now);
		const replacement = createGoalState({ ...start, now });
		expect(() => appendGoalStateSnapshot(manager, replacement, completed)).toThrow(/new goal ID/);
		manager.branch(root);
		expect(() => appendGoalStateSnapshot(manager, replacement)).toThrow(/new goal ID/);
		const fresh = createGoalState({ ...start, goalId: "fresh", now });

		expect(() =>
			appendGoalStateSnapshot(manager, fresh, undefined, {
				hasDurableObjective: () => true,
			}),
		).toThrow(/new goal ID/);
		expect(() => appendGoalStateSnapshot(manager, fresh)).not.toThrow();
	});

	it("records a contradictory measurement with all ordinary evidence slots occupied", async () => {
		let state = checkedGoal();
		const save = (next: GoalState) => {
			state = next;
		};
		await proveRequirementChecks({
			state,
			save,
			now: () => now,
			runCheck: async () => passed,
			requireVerifiedEvidenceForCompletion: true,
			isCheckCoverageEstablished: () => true,
		});
		state = withFullOrdinaryEvidence(state);
		const previousPass = state.evidence.find((evidence) => evidence.kind === "check")!;
		const proof = await proveRequirementChecks({
			state,
			save,
			now: () => now,
			runCheck: async () => failed,
			requireVerifiedEvidenceForCompletion: true,
		});
		expect(proof.failures).toHaveLength(1);
		expect(state.requirements[0]?.status).toBe("open");
		expect(state.evidence).toHaveLength(MAX_GOAL_EVIDENCE + 1);
		expect(state.evidence.filter((evidence) => evidence.kind === "file")).toHaveLength(MAX_GOAL_EVIDENCE);
		expect(state.evidence.some((evidence) => evidence.id === previousPass.id)).toBe(false);
		expect(state.evidence.find((evidence) => evidence.kind === "check")?.outcome).toBe("failed");
		expect(goalEvidenceHasRoom(state)).toBe(false);
		expect(
			applyGoalAction(
				state,
				{ action: "add_evidence", evidenceId: "overflow", kind: "file", summary: "Extra artifact" },
				now,
			).ok,
		).toBe(false);
	});

	it("bounds a full ordinary ledger plus the current measurement for every supported requirement", async () => {
		let state = withFullOrdinaryEvidence(checkedGoal(256));
		await proveRequirementChecks({
			state,
			save: (next) => {
				state = next;
			},
			now: () => now,
			runCheck: async () => failed,
			requireVerifiedEvidenceForCompletion: true,
		});
		expect(state.evidence).toHaveLength(MAX_GOAL_EVIDENCE + 256);
		expect(state.evidence.filter((evidence) => evidence.kind === "check")).toHaveLength(256);
		await proveRequirementChecks({
			state,
			save: (next) => {
				state = next;
			},
			now: () => now,
			runCheck: async () => failed,
			requireVerifiedEvidenceForCompletion: true,
		});
		expect(state.evidence).toHaveLength(MAX_GOAL_EVIDENCE + 256);
	});

	it("records distinct sequential checks when the command, output, and clock are identical", async () => {
		let state = checkedGoal();
		const measuredIds: string[] = [];
		for (let index = 0; index < 2; index++) {
			await proveRequirementChecks({
				state,
				save: (next) => {
					state = next;
				},
				now: () => now,
				runCheck: async () => passed,
				requireVerifiedEvidenceForCompletion: true,
				isCheckCoverageEstablished: () => true,
			});
			measuredIds.push(state.evidence.find((evidence) => evidence.kind === "check")!.id);
		}
		expect(new Set(measuredIds).size).toBe(2);
		expect(state.requirements[0]?.status).toBe("satisfied");
	});

	it("rejects a worker check replay after pruning and only reads the active branch's history", async () => {
		const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
		let state = checkedGoal();
		const initial = state;
		const initialEntry = appendGoalStateSnapshot(manager, state);
		const save = (next: GoalState) => {
			appendGoalStateSnapshot(manager, next, state);
			state = next;
		};
		const writer = {
			getGoalState: () => state,
			saveGoalState: save,
			warn: (message: string) => {
				throw new Error(message);
			},
			hasRecordedEvidence: (goal: GoalState, id: string) => hasRecordedGoalEvidence(manager, goal, id),
			isCheckCoverageEstablished: () => true,
		};
		const input = {
			attemptId: "attempt-one",
			goalId: state.goalId,
			requirementId: "ready-0",
			definition: requirementKey(state.requirements[0]!),
			result: passed,
			now: () => now,
		};
		expect(await recordHostRequirementCheckProof(writer, input)).toBe(true);
		const originalReceipt = state.evidence.find((evidence) => evidence.kind === "check")!.id;
		await proveRequirementChecks({
			state,
			save,
			now: () => now,
			runCheck: async () => failed,
			requireVerifiedEvidenceForCompletion: true,
		});
		expect(state.evidence.some((evidence) => evidence.id === originalReceipt)).toBe(false);
		expect(hasRecordedGoalEvidence(manager, state, originalReceipt)).toBe(true);
		const beforeReplay = state;
		expect(await recordHostRequirementCheckProof(writer, input)).toBe(false);
		expect(state).toBe(beforeReplay);
		manager.branch(initialEntry);
		expect(hasRecordedGoalEvidence(manager, initial, originalReceipt)).toBe(false);
	});

	it("keeps opt-out and blocked historical citations from retaining every superseded measurement", async () => {
		let state = withFullOrdinaryEvidence(checkedGoal());
		state = applyGoalEvent(state, {
			type: "add_requirement",
			id: "override",
			text: "Owner-specified bookkeeping override",
			now,
		});
		state = applyGoalEvent(state, { type: "add_requirement", id: "held", text: "Blocked bookkeeping", now });
		for (let index = 0; index < 4; index++) {
			await proveRequirementChecks({
				state,
				save: (next) => {
					state = next;
				},
				now: () => now,
				runCheck: async () => passed,
				requireVerifiedEvidenceForCompletion: true,
				isCheckCoverageEstablished: () => true,
			});
			const id = state.evidence.find((evidence) => evidence.kind === "check")!.id;
			for (const requirementId of ["override", "held"]) {
				const satisfied = applyGoalAction(
					state,
					{ action: "satisfy_requirement", requirementId, evidenceIds: [id] },
					now,
					{ requireVerifiedEvidenceForCompletion: false },
				);
				if (!satisfied.ok) throw new Error(satisfied.error);
				state = satisfied.state;
			}
			state = applyGoalEvent(state, {
				type: "block_requirement",
				id: "held",
				blockedReason: "Waiting for owner",
				now,
			});
		}
		await proveRequirementChecks({
			state,
			save: (next) => {
				state = next;
			},
			now: () => now,
			runCheck: async () => failed,
			requireVerifiedEvidenceForCompletion: true,
		});
		expect(state.evidence).toHaveLength(MAX_GOAL_EVIDENCE + 1);
		expect(state.requirements.find((requirement) => requirement.id === "override")).toMatchObject({
			status: "satisfied",
			evidenceIds: [],
		});
		expect(state.requirements.find((requirement) => requirement.id === "held")).toMatchObject({
			status: "blocked",
			evidenceIds: [],
		});
	});

	it("keeps worker generation and requirement identity unambiguous when IDs contain colons", () => {
		expect(acceptedWorkerEvidenceId("attempt:part", "requirement")).not.toBe(
			acceptedWorkerEvidenceId("attempt", "part:requirement"),
		);
		expect(acceptedWorkerEvidenceId("attempt:part", "requirement")).toBe(
			acceptedWorkerEvidenceId("attempt:part", "requirement"),
		);
	});
});

describe("goal journal publication and execution", () => {
	it("leaves neither a declared work unit nor a goal when the starting append is refused", () => {
		const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
		const before = manager.getLeafId();
		const append = vi.spyOn(manager, "appendCustomEntry").mockImplementationOnce(() => {
			throw new Error("unwritable");
		});
		expect(() =>
			saveSessionGoal(manager, checkedGoal(), undefined, new GoalExecutionCustody(), { runtimeFacts: () => ({}) }),
		).toThrow("unwritable");
		expect(append).toHaveBeenCalledTimes(1);
		expect(append).toHaveBeenCalledWith(
			GOAL_STATE_CUSTOM_TYPE,
			expect.objectContaining({ opensWorkUnit: true, kind: "checkpoint" }),
		);
		expect(manager.getLeafId()).toBe(before);
		expect(getLatestGoalStateSnapshot(manager)).toBeUndefined();
	});

	it.each([true, false])(
		"matches the execution signal to the durable record when an append throws (published %s)",
		(published) => {
			const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
			const state = checkedGoal();
			appendGoalStateSnapshot(manager, state);
			const custody = new GoalExecutionCustody();
			const signal = custody.signalFor("goal:retention", state, true)!;
			const append = manager.appendCustomEntry.bind(manager);
			vi.spyOn(manager, "appendCustomEntry").mockImplementationOnce((kind, data) => {
				if (published) append(kind, data);
				throw new Error("failed append");
			});
			const paused = applyGoalEvent(state, { type: "pause_goal", now });
			expect(() => saveSessionGoal(manager, paused, state, custody, { runtimeFacts: () => ({}) })).toThrow(
				"failed append",
			);
			expect(signal.aborted).toBe(published);
			expect(getLatestGoalStateSnapshot(manager)?.status).toBe(published ? "paused" : "active");
		},
	);

	it("revokes execution as soon as cancellation is durable, even if worker synchronization fails", () => {
		const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
		const state = checkedGoal();
		appendGoalStateSnapshot(manager, state);
		const custody = new GoalExecutionCustody();
		const signal = custody.signalFor("goal:retention", state, true)!;
		expect(() =>
			clearSessionGoal(manager, custody, state, now, () => {
				expect(signal.aborted).toBe(true);
				throw new Error("worker journal unavailable");
			}),
		).toThrow("worker journal unavailable");
		expect(getLatestGoalStateSnapshot(manager)?.status).toBe("cancelled");
	});

	it("keeps a goal selected during worker synchronization", () => {
		const manager = SessionManager.inMemory(ownerSessionStorageRoots(process.cwd()), process.cwd());
		const root = manager.appendCustomEntry("root", {});
		const state = checkedGoal();
		appendGoalStateSnapshot(manager, state);
		const next = createGoalState({ goalId: "other", userGoal: "Another goal", now });
		expect(() =>
			clearSessionGoal(manager, new GoalExecutionCustody(), state, now, () => {
				manager.branch(root);
				appendGoalStateSnapshot(manager, next);
			}),
		).toThrow(/changed during synchronization/);
		expect(getLatestGoalStateSnapshot(manager)?.goalId).toBe("other");
	});

	it("releases only bindings whose requirement definition changed", () => {
		const state = applyGoalEvent(checkedGoal(), {
			type: "dispatch_worker",
			id: "ready-0",
			instructions: "Measure",
			laneId: "lane",
			now,
		});
		const check = state.requirements[0]!.check!;
		const same = applyGoalEvent(state, { type: "set_requirement_check", id: "ready-0", check, now });
		expect(same.requirements[0]?.boundLaneId).toBe("lane");
		const amended = applyGoalEvent(state, {
			type: "set_requirement_check",
			id: "ready-0",
			check: { command: "read-new-service" },
			now,
		});
		expect(amended.requirements[0]?.boundLaneId).toBeUndefined();
		expect(amended.requirements[0]?.boundAt).toBeUndefined();
		expect(state.requirements[0]?.boundLaneId).toBe("lane");
	});

	it.each(["missing", "same revision sibling"])(
		"records the worker measurement without reviewing a changed branch (%s)",
		async (variant) => {
			const state = checkedGoal();
			let current: GoalState | undefined = state;
			const coverage = vi.fn(() => true);
			const writer = {
				getGoalState: () => current,
				saveGoalState: vi.fn((next: GoalState) => {
					current = variant === "missing" ? undefined : { ...next, evidence: [] };
				}),
				warn: vi.fn(),
				isCheckCoverageEstablished: coverage,
			};
			expect(
				await recordHostRequirementCheckProof(writer, {
					attemptId: "worker",
					goalId: state.goalId,
					requirementId: "ready-0",
					definition: requirementKey(state.requirements[0]!),
					result: passed,
					now: () => now,
				}),
			).toBe(true);
			expect(writer.saveGoalState).toHaveBeenCalledTimes(1);
			expect(coverage).not.toHaveBeenCalled();
			expect(writer.warn).not.toHaveBeenCalled();
		},
	);
});
