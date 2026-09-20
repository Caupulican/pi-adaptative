import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { repairTaskId, SessionObjectiveRuntime } from "../src/core/objective-execution/session-objective-runtime.ts";
import { DelegationOrchestrationLedger } from "../src/core/orchestration/delegation-ledger.ts";
import { goalObjectiveId } from "../src/core/orchestration/work-state-projection.ts";

describe("SessionObjectiveRuntime", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("reconciles the live goal into its durable objective, records repairs once, and reads budget and limitations from the session", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-objective-runtime-"));
		dirs.push(agentDir);
		const ledger = new DelegationOrchestrationLedger({ agentDir, sessionId: "session-1" });
		const now = "2026-09-21T00:00:00.000Z";
		let goal = createGoalState({ goalId: "g1", userGoal: "Ship the parser", now });
		goal = applyGoalEvent(goal, { type: "add_requirement", id: "r1", text: "parser handles quotes", now });
		const notes: string[] = [];
		const runtime = new SessionObjectiveRuntime({
			runtime: ledger.runtime,
			cwd: process.cwd(),
			getGoalState: () => goal,
			synchronizeGoalState: (state) => ledger.synchronizeGoalState(state),
			getVerificationObligations: () => [{ id: "v1", command: "npm test" }],
			noteDecision: (kind, detail) => notes.push(`${kind}: ${detail}`),
		});
		const objectiveId = goalObjectiveId("g1");
		const snapshot = await runtime.reconcileObjective(objectiveId);
		expect(snapshot.objectives[objectiveId]?.objective.title).toBeDefined();
		expect(snapshot.objectives[objectiveId]?.objective.status).toBe("active");
		expect(runtime.isCancelled(objectiveId)).toBe(false);
		expect(runtime.isBudgetExhausted(objectiveId)).toBe(false);
		expect(runtime.getLimitations(objectiveId)).toEqual(["unresolved verification: npm test"]);
		expect(runtime.getSourceRevision()).toMatch(/^[0-9a-f]{40}$|^unversioned$/);

		const repair = {
			schema_version: "1.0" as const,
			repair_id: "rep-1",
			objective_id: objectiveId,
			failed_gate_id: "completion_not_plausible",
			reason: "criterion 3 has no evidence",
			required_next_proof: "a passing test for criterion 3",
			recommended_work_class: "implement" as const,
		};
		await runtime.ensureRepairTasks(objectiveId, [repair]);
		await runtime.ensureRepairTasks(objectiveId, [repair]);
		const tasks = ledger.runtime.getSnapshot().tasks;
		expect(Object.keys(tasks).filter((id) => id === repairTaskId(repair))).toHaveLength(1);
		expect(tasks[repairTaskId(repair)]?.task.description).toContain("a passing test for criterion 3");
		expect(notes).toEqual(["repair: completion_not_plausible: criterion 3 has no evidence"]);

		await runtime.requestReplan(objectiveId, {
			stalled: true,
			stallTurns: 3,
			repeatedWithoutNewEvidence: true,
			fingerprint: "f",
		});
		expect(notes.at(-1)).toContain("replan:");

		goal = applyGoalEvent(goal, { type: "system_stop_goal", status: "budget_limited", reason: "ceiling", now });
		expect(runtime.isBudgetExhausted(objectiveId)).toBe(true);
		goal = applyGoalEvent(goal, { type: "cancel_goal", now });
		expect(runtime.isCancelled(objectiveId)).toBe(true);
	});
});
