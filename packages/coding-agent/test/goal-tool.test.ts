import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { GoalState } from "../src/core/goals/goal-state.ts";
import {
	createGoalLifecycleToolDefinitions,
	createGoalToolDefinition,
	type GoalToolDetails,
	type GoalToolInput,
} from "../src/core/tools/goal.ts";

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
		return { content: result.content, details: result.details as GoalToolDetails, isError: result.isError };
	};
	return { tool, run, saves, getState: () => state };
}

describe("goal tool", () => {
	it("is named 'goal'", () => {
		const { tool } = createHarness();
		expect(tool.name).toBe("goal");
	});

	it("reports start authorization failure as a tool error", async () => {
		const tool = createGoalToolDefinition({
			getGoalState: () => undefined,
			saveGoalState: () => {
				throw new Error("must not persist");
			},
			authorizeStart: () => "goal start requires explicit owner authorization in the current prompt.",
		});
		const result = await tool.execute(
			"call-1",
			{ action: "start", goalId: "g1", userGoal: "Ship feature" },
			undefined,
			undefined,
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			action: "start",
			applied: false,
			error: "goal start requires explicit owner authorization in the current prompt.",
		});
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
		expect(result.isError).toBe(true);
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

	it("reads a blocked ledger without exposing owner resume authority", async () => {
		const { run, getState } = createHarness();
		await run({ action: "start", goalId: "g1", userGoal: "Ship" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Get access" });
		await run({ action: "block_requirement", requirementId: "r1", reason: "waiting for user" });
		await run({ action: "block_goal", reason: "waiting for user" });

		const viewed = await run({ action: "get" });
		expect(viewed.details.applied).toBe(false);
		expect(viewed.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("blocked") });
		expect(getState()?.status).toBe("blocked");
	});

	it("persists an explicitly supplied positive token budget", async () => {
		const { run, getState } = createHarness();
		await run({ action: "start", goalId: "g1", userGoal: "Ship", tokenBudget: 12_000 });
		expect(getState()?.tokenBudget).toBe(12_000);
		expect(getState()?.tokensUsed).toBe(0);
	});

	it("exposes compact Codex-compatible lifecycle tools through the same authoritative executor", async () => {
		const { tool, getState } = createHarness();
		const lifecycleTools = createGoalLifecycleToolDefinitions(tool);
		expect(lifecycleTools.map((definition) => definition.name)).toEqual(["create_goal", "get_goal", "update_goal"]);

		const create = lifecycleTools[0];
		const created = await create.execute(
			"call-create",
			{ objective: "Ship model-neutral goals", token_budget: 12_000 },
			undefined,
			undefined,
			ctx,
		);
		expect(created.isError).not.toBe(true);
		expect(getState()).toMatchObject({
			status: "active",
			userGoal: "Ship model-neutral goals",
			tokenBudget: 12_000,
		});

		const get = lifecycleTools[1];
		const viewed = await get.execute("call-get", {}, undefined, undefined, ctx);
		expect(viewed.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("model-neutral") });

		const update = lifecycleTools[2];
		const completed = await update.execute("call-update", { status: "complete" }, undefined, undefined, ctx);
		expect(completed.isError).not.toBe(true);
		expect(getState()?.status).toBe("completed");
	});
});
