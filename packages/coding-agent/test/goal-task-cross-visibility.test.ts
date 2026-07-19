import { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { buildGoalContinuationPrompt } from "../src/core/goals/goal-continuation-prompt.ts";
import { buildGoalRuntimeSnapshot, type GoalRuntimeSnapshot } from "../src/core/goals/goal-runtime-snapshot.ts";
import { applyGoalEvent, createGoalState, type GoalState } from "../src/core/goals/goal-state.ts";
import {
	applyGoalAction,
	buildGoalTaskCrossVisibilityNudges,
	findRequirementCrossReferenceNudges,
	type OpenTaskStepRef,
	summarizeGoalState,
} from "../src/core/goals/goal-tool-core.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { appendTaskStepsStateSnapshot } from "../src/core/tasks/session-task-state.ts";
import { addTaskStep, createTaskStepsState, updateTaskStep } from "../src/core/tasks/task-state.ts";

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function expectOk(result: ReturnType<typeof applyGoalAction>): GoalState {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result.state;
}

/**
 * Bounded, read-only goal<->task cross-visibility.
 *  (a) buildGoalRuntimeSnapshot includes an open task-steps summary (branch-scoped).
 *  (b) satisfying/completing a requirement emits a cheap-text-match nudge when an open task
 *      step's content references it.
 *  (c) goal-continuation-prompt renders the open task-steps summary.
 * No shared state machine: goal code only ever READS an already-resolved task-steps summary; it
 * never mutates task state.
 */
describe("goal<->task cross-visibility", () => {
	describe("buildGoalRuntimeSnapshot: open task-steps summary", () => {
		it("includes open task steps and excludes completed/cancelled ones, preferring activeForm", () => {
			const sessionManager = SessionManager.inMemory();
			appendGoalStateSnapshot(sessionManager, createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" }));

			let taskState = createTaskStepsState("T0");
			taskState = addTaskStep(taskState, { content: "Write tests" }, "T1");
			taskState = addTaskStep(taskState, { content: "Ship the release", activeForm: "Shipping the release" }, "T2");
			taskState = addTaskStep(taskState, { content: "Old finished work" }, "T3");
			taskState = updateTaskStep(taskState, "step-3", { status: "completed" }, "T4");
			taskState = addTaskStep(taskState, { content: "Abandoned idea" }, "T5");
			taskState = updateTaskStep(taskState, "step-4", { status: "cancelled" }, "T6");
			appendTaskStepsStateSnapshot(sessionManager, taskState);

			const snapshot = buildGoalRuntimeSnapshot({ sessionManager, settings: { maxStallTurns: 3 } });

			expect(snapshot.openTaskSteps?.map((step) => step.id)).toEqual(["step-1", "step-2"]);
			expect(snapshot.openTaskSteps?.find((step) => step.id === "step-2")?.content).toBe("Shipping the release");
			expect(snapshot.openTaskSteps?.find((step) => step.id === "step-1")?.status).toBe("pending");
		});

		it("returns an empty array when no task_steps_state snapshot has been recorded", () => {
			const sessionManager = SessionManager.inMemory();
			appendGoalStateSnapshot(sessionManager, createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" }));

			const snapshot = buildGoalRuntimeSnapshot({ sessionManager, settings: { maxStallTurns: 3 } });
			expect(snapshot.openTaskSteps).toEqual([]);
		});

		it("is branch-scoped: a fork never leaks the other branch's open task steps", () => {
			const session = SessionManager.inMemory();
			const branchPoint = session.appendMessage(userMsg("start"));

			appendGoalStateSnapshot(session, createGoalState({ goalId: "goal-a", userGoal: "A", now: "T0" }));
			appendTaskStepsStateSnapshot(
				session,
				addTaskStep(createTaskStepsState("T0"), { content: "Branch A step" }, "T1"),
			);
			const branchALeaf = session.getLeafId();
			if (!branchALeaf) throw new Error("Expected branch A leaf id");

			session.branch(branchPoint);
			appendGoalStateSnapshot(session, createGoalState({ goalId: "goal-b", userGoal: "B", now: "T2" }));
			appendTaskStepsStateSnapshot(
				session,
				addTaskStep(createTaskStepsState("T2"), { content: "Branch B step" }, "T3"),
			);

			const snapshotB = buildGoalRuntimeSnapshot({ sessionManager: session, settings: { maxStallTurns: 3 } });
			expect(snapshotB.openTaskSteps?.map((step) => step.content)).toEqual(["Branch B step"]);

			session.branch(branchALeaf);
			const snapshotA = buildGoalRuntimeSnapshot({ sessionManager: session, settings: { maxStallTurns: 3 } });
			expect(snapshotA.openTaskSteps?.map((step) => step.content)).toEqual(["Branch A step"]);
		});
	});

	describe("buildGoalContinuationPrompt: open task-steps summary rendering", () => {
		function baseSnapshot(overrides: Partial<GoalRuntimeSnapshot> = {}): GoalRuntimeSnapshot {
			return {
				workerResults: [],
				learningDecisions: [],
				continuation: {
					action: "continue",
					reasonCode: "goal_active",
					message: "Active",
					openRequirementIds: [],
					blockedRequirementIds: [],
					satisfiedRequirementIds: [],
				},
				...overrides,
			};
		}

		it("renders nothing extra when openTaskSteps is absent (backward compatible)", () => {
			const prompt = buildGoalContinuationPrompt({ snapshot: baseSnapshot() });
			expect(prompt.text).not.toContain("Open Task Steps");
		});

		it("renders the open task-steps summary with status and content", () => {
			const snapshot = baseSnapshot({
				openTaskSteps: [
					{ id: "step-1", status: "in_progress", content: "Wire the nudge" },
					{ id: "step-2", status: "blocked", content: "Waiting on review" },
				],
			});
			const prompt = buildGoalContinuationPrompt({ snapshot });
			expect(prompt.text).toContain("Open Task Steps");
			// The structural prefix (status/id) stays outside the untrusted-content boundary; the
			// step content is fenced inside it (goal-continuation-prompt.ts wraps open-task-step
			// content as untrusted free text) -- assert both separately rather than as one
			// contiguous string.
			expect(prompt.text).toContain("[in_progress] step-1:");
			expect(prompt.text).toContain("Wire the nudge");
			expect(prompt.text).toContain("[blocked] step-2:");
			expect(prompt.text).toContain("Waiting on review");
			expect(prompt.truncated).toBe(false);
		});

		it("truncates open task steps beyond the configured limit", () => {
			const openTaskSteps = Array.from({ length: 5 }, (_, index) => ({
				id: `step-${index + 1}`,
				status: "pending" as const,
				content: `Step ${index + 1}`,
			}));
			const snapshot = baseSnapshot({ openTaskSteps });
			const prompt = buildGoalContinuationPrompt({ snapshot, limits: { maxOpenTaskSteps: 2 } });
			expect(prompt.text).toContain("step-1");
			expect(prompt.text).toContain("step-2");
			expect(prompt.text).not.toContain("step-3");
			expect(prompt.text).toContain("3 more open task step(s) omitted");
			expect(prompt.truncated).toBe(true);
		});
	});

	describe("goal-tool-core: requirement-complete cross-reference nudge", () => {
		it("nudges when an open task step references the just-satisfied requirement by id token", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
			state = expectOk(
				applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Add rate limiting" }, "T1"),
			);
			state = expectOk(
				applyGoalAction(state, { action: "add_evidence", evidenceId: "e1", kind: "user", summary: "done" }, "T2"),
			);
			const satisfyAction = {
				action: "satisfy_requirement",
				requirementId: "r1",
				evidenceIds: ["e1"],
			} as const;
			state = expectOk(applyGoalAction(state, satisfyAction, "T3"));

			const openTaskSteps: OpenTaskStepRef[] = [{ id: "step-1", content: "Verify r1 is covered by tests" }];
			const nudges = buildGoalTaskCrossVisibilityNudges(satisfyAction, state, openTaskSteps);
			expect(nudges).toHaveLength(1);
			expect(nudges[0]).toContain("step-1");
			expect(nudges[0]).toContain("r1");
		});

		it("nudges when an open task step repeats the requirement text verbatim", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
			state = expectOk(
				applyGoalAction(
					state,
					{ action: "add_requirement", requirementId: "req-2", text: "Add rate limiting to the API" },
					"T1",
				),
			);
			const satisfyAction = { action: "satisfy_requirement", requirementId: "req-2" } as const;
			state = expectOk(applyGoalAction(state, satisfyAction, "T2"));

			const openTaskSteps: OpenTaskStepRef[] = [
				{ id: "step-9", content: "Task: Add rate limiting to the API before release" },
			];
			const nudges = buildGoalTaskCrossVisibilityNudges(satisfyAction, state, openTaskSteps);
			expect(nudges).toHaveLength(1);
			expect(nudges[0]).toContain("step-9");
		});

		it("stays conservative: does not nudge on unrelated content or a near-miss id token", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
			state = expectOk(
				applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1"),
			);
			const satisfyAction = { action: "satisfy_requirement", requirementId: "r1" } as const;
			state = expectOk(applyGoalAction(state, satisfyAction, "T2"));

			const unrelated: OpenTaskStepRef[] = [{ id: "step-1", content: "Write the changelog entry" }];
			expect(buildGoalTaskCrossVisibilityNudges(satisfyAction, state, unrelated)).toEqual([]);

			// "r10" contains "r1" as a substring but not as a whole token -- must not match.
			const nearMiss: OpenTaskStepRef[] = [{ id: "step-2", content: "Check r10 configuration" }];
			expect(buildGoalTaskCrossVisibilityNudges(satisfyAction, state, nearMiss)).toEqual([]);
		});

		it("returns no nudges when openTaskSteps is omitted or empty (backward compatible)", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
			state = expectOk(
				applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Add rate limiting" }, "T1"),
			);
			const satisfyAction = { action: "satisfy_requirement", requirementId: "r1" } as const;
			state = expectOk(applyGoalAction(state, satisfyAction, "T2"));

			expect(buildGoalTaskCrossVisibilityNudges(satisfyAction, state, undefined)).toEqual([]);
			expect(buildGoalTaskCrossVisibilityNudges(satisfyAction, state, [])).toEqual([]);
		});

		it("does not nudge for actions other than satisfy_requirement/complete", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
			state = expectOk(
				applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Add rate limiting" }, "T1"),
			);
			const openTaskSteps: OpenTaskStepRef[] = [{ id: "step-1", content: "Verify r1 is covered by tests" }];

			expect(buildGoalTaskCrossVisibilityNudges({ action: "progress" }, state, openTaskSteps)).toEqual([]);
			expect(
				buildGoalTaskCrossVisibilityNudges(
					{ action: "add_evidence", evidenceId: "e1", kind: "user", summary: "done" },
					state,
					openTaskSteps,
				),
			).toEqual([]);
		});

		it("on complete, nudges once per satisfied requirement that an open step references", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
			state = expectOk(
				applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Add rate limiting" }, "T1"),
			);
			state = expectOk(
				applyGoalAction(state, { action: "add_requirement", requirementId: "r2", text: "Add pagination" }, "T2"),
			);
			state = expectOk(
				applyGoalAction(
					state,
					{ action: "add_evidence", evidenceId: "e1", kind: "user", summary: "confirmed" },
					"T3",
				),
			);
			state = expectOk(
				applyGoalAction(state, { action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] }, "T4"),
			);
			state = expectOk(
				applyGoalAction(state, { action: "satisfy_requirement", requirementId: "r2", evidenceIds: ["e1"] }, "T5"),
			);

			const openTaskSteps: OpenTaskStepRef[] = [
				{ id: "step-1", content: "Verify r1 is covered by tests" },
				{ id: "step-2", content: "Verify r2 is covered by tests" },
				{ id: "step-3", content: "Unrelated cleanup" },
			];
			const completeAction = { action: "complete" } as const;
			const nudges = buildGoalTaskCrossVisibilityNudges(completeAction, state, openTaskSteps);
			expect(nudges).toHaveLength(2);
			expect(nudges.join("\n")).toContain("step-1");
			expect(nudges.join("\n")).toContain("step-2");
			expect(nudges.join("\n")).not.toContain("step-3");
		});

		it("findRequirementCrossReferenceNudges ignores unknown requirement ids without throwing", () => {
			const state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
			const openTaskSteps: OpenTaskStepRef[] = [{ id: "step-1", content: "Anything" }];
			expect(findRequirementCrossReferenceNudges(state, ["does-not-exist"], openTaskSteps)).toEqual([]);
		});

		it("never mutates the caller-supplied open task steps (read-only coupling)", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
			state = expectOk(
				applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Add rate limiting" }, "T1"),
			);
			const satisfyAction = { action: "satisfy_requirement", requirementId: "r1" } as const;
			state = expectOk(applyGoalAction(state, satisfyAction, "T2"));

			const step = Object.freeze({ id: "step-1", content: "Verify r1 is covered by tests" });
			const openTaskSteps = Object.freeze([step]);
			expect(() => buildGoalTaskCrossVisibilityNudges(satisfyAction, state, openTaskSteps)).not.toThrow();
			expect(openTaskSteps[0]).toBe(step);
			expect(step.content).toBe("Verify r1 is covered by tests");
		});

		it("summarizeGoalState without options is unchanged (no options = no nudge computation)", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
			state = expectOk(
				applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Add rate limiting" }, "T1"),
			);
			const summary = summarizeGoalState(state);
			expect(summary).not.toContain("Note: open task step");
		});

		it("summarizeGoalState with action + openTaskSteps appends the nudge line", () => {
			let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
			state = expectOk(
				applyGoalAction(state, { action: "add_requirement", requirementId: "r1", text: "Add rate limiting" }, "T1"),
			);
			const satisfyAction = { action: "satisfy_requirement", requirementId: "r1" } as const;
			state = expectOk(applyGoalAction(state, satisfyAction, "T2"));

			const openTaskSteps: OpenTaskStepRef[] = [{ id: "step-1", content: "Verify r1 is covered by tests" }];
			const summary = summarizeGoalState(state, { action: satisfyAction, openTaskSteps });
			expect(summary).toContain("Note: open task step(s) step-1");
		});
	});

	describe("goal and task stores remain fully independent", () => {
		it("applyGoalEvent (the goal event applier) has no dependency on task state at all", () => {
			// Type-level + smoke check: goal-state transitions never take a task-steps argument.
			let state = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
			state = applyGoalEvent(state, { type: "add_requirement", id: "r1", text: "Do X", now: "T1" });
			expect(state.requirements).toHaveLength(1);
		});
	});
});
