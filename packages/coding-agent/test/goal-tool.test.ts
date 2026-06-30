import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { GoalState } from "../src/core/goals/goal-state.ts";
import { createGoalToolDefinition, type GoalToolDetails, type GoalToolInput } from "../src/core/tools/goal.ts";

const ctx = undefined as unknown as ExtensionContext;

function createHarness() {
	let state: GoalState | undefined;
	let counter = 0;
	const saves: GoalState[] = [];
	const tool = createGoalToolDefinition({
		getGoalState: () => state,
		saveGoalState: (next) => {
			state = next;
			saves.push(next);
		},
		now: () => `T${counter++}`,
	});
	const run = async (input: GoalToolInput) => {
		const result = await tool.execute("call-1", input, undefined, undefined, ctx);
		return { content: result.content, details: result.details as GoalToolDetails };
	};
	return { tool, run, saves, getState: () => state };
}

describe("goal tool", () => {
	it("is named 'goal'", () => {
		const { tool } = createHarness();
		expect(tool.name).toBe("goal");
	});

	it("starts a goal and persists state", async () => {
		const { run, saves } = createHarness();
		const result = await run({ action: "start", goalId: "g1", userGoal: "Ship feature" });
		expect(result.details.applied).toBe(true);
		expect(saves).toHaveLength(1);
		expect(saves[0].goalId).toBe("g1");
		const first = result.content[0];
		expect(first?.type).toBe("text");
		if (first?.type !== "text") throw new Error("expected text content");
		expect(first.text).toContain("goal start recorded");
	});

	it("does not persist when an action fails validation", async () => {
		const { run, saves } = createHarness();
		const result = await run({ action: "progress" });
		expect(result.details.applied).toBe(false);
		expect(result.details.error).toContain("No active goal");
		expect(saves).toHaveLength(0);
	});

	it("requires kind for add_evidence", async () => {
		const { run } = createHarness();
		await run({ action: "start", goalId: "g1", userGoal: "Ship" });
		const result = await run({ action: "add_evidence", evidenceId: "e1", summary: "edited foo" });
		expect(result.details.applied).toBe(false);
		expect(result.details.error).toContain("kind");
	});

	it("runs a full producer flow that ends with an active continuable goal", async () => {
		const { run, getState } = createHarness();
		await run({ action: "start", goalId: "g1", userGoal: "Ship feature" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Implement X" });
		await run({ action: "add_evidence", evidenceId: "e1", kind: "file", summary: "wrote X" });
		const satisfied = await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });
		expect(satisfied.details.applied).toBe(true);

		const open = await run({ action: "add_requirement", requirementId: "r2", text: "Test X" });
		expect(open.details.applied).toBe(true);

		const state = getState();
		expect(state?.status).toBe("active");
		expect(state?.requirements).toHaveLength(2);
		expect(state?.requirements.filter((r) => r.status === "open")).toHaveLength(1);
	});

	it("persists the latest state across actions so updates compound", async () => {
		const { run, getState } = createHarness();
		await run({ action: "start", goalId: "g1", userGoal: "Ship" });
		await run({ action: "no_progress" });
		await run({ action: "no_progress" });
		expect(getState()?.stallTurns).toBe(2);
		await run({ action: "progress" });
		expect(getState()?.stallTurns).toBe(0);
	});
});
