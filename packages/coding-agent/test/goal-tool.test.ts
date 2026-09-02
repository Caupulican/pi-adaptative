import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { cancelPersistedGoal } from "../src/core/goals/goal-lifecycle.ts";
import type { GoalState } from "../src/core/goals/goal-state.ts";
import {
	createGoalLifecycleToolDefinitions,
	createGoalToolDefinition,
	type GoalToolDetails,
	type GoalToolInput,
} from "../src/core/tools/goal.ts";

const ctx = undefined as unknown as ExtensionContext;

function createHarness(options: { getActiveVerificationIds?: () => readonly string[] } = {}) {
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
		getActiveVerificationIds: options.getActiveVerificationIds,
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
			{ action: "start", goalId: "g1", userGoal: "Ship feature", tokenBudget: 5_000 },
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

	it("normalizes model-supplied budgets through host authority without blocking autonomous goals", async () => {
		let state: GoalState | undefined;
		const unbounded = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
			},
			authorizeStart: () => null,
			now: () => "T0",
		});
		const started = await unbounded.execute(
			"call-unbounded",
			{ action: "start", goalId: "g1", userGoal: "Ship", tokenBudget: 80_000 },
			undefined,
			undefined,
			ctx,
		);
		expect(started.isError).not.toBe(true);
		expect((state as GoalState | undefined)?.tokenBudget).toBeUndefined();

		state = undefined;
		const bounded = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
			},
			authorizeStart: () => 12_000,
			now: () => "T0",
		});
		await bounded.execute(
			"call-bounded",
			{ action: "start", goalId: "g2", userGoal: "Ship" },
			undefined,
			undefined,
			ctx,
		);
		expect((state as GoalState | undefined)?.tokenBudget).toBe(12_000);
	});

	it("host-generates stable requirement and evidence ids when callers omit them", async () => {
		const { run, getState } = createHarness();
		await run({ action: "start", goalId: "g1", userGoal: "Ship" });
		const requirement = await run({ action: "add_requirement", text: "Implement the durable owner" });
		expect(requirement.isError).not.toBe(true);
		const requirementId = getState()?.requirements[0]?.id;
		expect(requirementId).toMatch(/^req-[a-f0-9]{16}$/);

		const replay = await run({ action: "add_requirement", text: "Implement the durable owner" });
		expect(replay.isError).toBe(true);
		expect(getState()?.requirements).toHaveLength(1);

		const evidence = await run({ action: "add_evidence", kind: "finding", summary: "Owner verified" });
		expect(evidence.isError).not.toBe(true);
		const evidenceId = getState()?.evidence[0]?.id;
		expect(evidenceId).toMatch(/^ev-[a-f0-9]{16}$/);
		const first = evidence.content[0];
		expect(first?.type).toBe("text");
		if (first?.type !== "text") return;
		expect(first.text).toContain(`Evidence '${evidenceId}' recorded (unverified)`);
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
		await run({ action: "add_evidence", evidenceId: "e1", kind: "user", summary: "owner confirmed X" });
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

	it("resolves active pipeline state only for goal completion", async () => {
		let state: GoalState | undefined;
		let pipelineReads = 0;
		const tool = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
			},
			getActivePipeline: () => {
				pipelineReads++;
				return undefined;
			},
			now: () => "T0",
		});

		await tool.execute("call-start", { action: "start", goalId: "g1", userGoal: "Ship" }, undefined, undefined, ctx);
		await tool.execute("call-progress", { action: "progress" }, undefined, undefined, ctx);
		expect(pipelineReads).toBe(0);

		await tool.execute("call-complete", { action: "increment" }, undefined, undefined, ctx);
		expect(pipelineReads).toBe(1);
	});

	it("returns a tool error when completion cannot verify durable pipeline state", async () => {
		let state: GoalState | undefined;
		const tool = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
			},
			getActivePipeline: () => {
				throw new Error("pipeline store is inconsistent");
			},
			now: () => "T0",
		});
		await tool.execute("call-start", { action: "start", goalId: "g1", userGoal: "Ship" }, undefined, undefined, ctx);

		const result = await tool.execute("call-complete", { action: "complete" }, undefined, undefined, ctx);

		expect(result).toMatchObject({
			isError: true,
			details: { applied: false, error: expect.stringContaining("pipeline store is inconsistent") },
		});
		expect(state?.status).toBe("active");
	});

	it("blocks complete and a completing increment while the same verification obligation remains active", async () => {
		const activeIds = () => ["unit-suite"];
		const complete = createHarness({ getActiveVerificationIds: activeIds });
		await complete.run({ action: "start", goalId: "complete-goal", userGoal: "Ship" });
		const completeSaves = complete.saves.length;

		const blockedComplete = await complete.run({ action: "complete" });
		expect(blockedComplete).toMatchObject({
			isError: true,
			details: { applied: false, error: expect.stringContaining("unit-suite") },
		});
		expect(complete.saves).toHaveLength(completeSaves);
		expect(complete.getState()?.status).toBe("active");

		const increment = createHarness({ getActiveVerificationIds: activeIds });
		await increment.run({ action: "start", goalId: "increment-goal", userGoal: "Ship" });
		const incrementSaves = increment.saves.length;
		const blockedIncrement = await increment.run({ action: "increment" });
		expect(blockedIncrement).toMatchObject({
			isError: true,
			details: { applied: false, error: expect.stringContaining("unit-suite") },
		});
		expect(increment.saves).toHaveLength(incrementSaves);
		expect(increment.getState()?.status).toBe("active");
	});

	it("leaves get, model blocking, and owner cancellation available while verification remains active", async () => {
		let verificationReads = 0;
		const harness = createHarness({
			getActiveVerificationIds: () => {
				verificationReads++;
				return ["unit-suite"];
			},
		});
		await harness.run({ action: "start", goalId: "g1", userGoal: "Ship" });
		await harness.run({ action: "no_progress" });
		await harness.run({ action: "no_progress" });
		await harness.run({ action: "no_progress" });

		const viewed = await harness.run({ action: "get" });
		const blocked = await harness.run({ action: "block_goal", reason: "waiting for owner access" });
		expect(viewed.isError).not.toBe(true);
		expect(blocked.isError).not.toBe(true);
		expect(harness.getState()?.status).toBe("blocked");
		expect(verificationReads).toBe(0);

		let ownerState = harness.getState();
		const cancelled = cancelPersistedGoal(
			{
				getGoalStateSnapshot: () => ownerState,
				saveGoalStateSnapshot: (next) => {
					ownerState = next;
					return "owner-cancel";
				},
			},
			"T-owner-cancel",
		);
		expect(cancelled).toMatchObject({ ok: true, state: { status: "cancelled" } });
		expect(ownerState?.status).toBe("cancelled");
	});

	it("fails closed without saving when the completion verification accessor throws", async () => {
		let state: GoalState | undefined;
		const saves: GoalState[] = [];
		const tool = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
				saves.push(next);
			},
			getActiveVerificationIds: () => {
				throw new Error("verification state unavailable");
			},
			now: () => "T0",
		});
		await tool.execute("start", { action: "start", goalId: "g1", userGoal: "Ship" }, undefined, undefined, ctx);
		const savesBeforeCompletion = saves.length;

		const result = await tool.execute("complete", { action: "complete" }, undefined, undefined, ctx);
		expect(result).toMatchObject({
			isError: true,
			details: { applied: false, error: expect.stringContaining("verification state unavailable") },
		});
		expect(saves).toHaveLength(savesBeforeCompletion);
		expect(state?.status).toBe("active");
	});

	it("refuses completion while a goal-owned worker lane is still active", async () => {
		let state: GoalState | undefined;
		let goalLaneStatus: "running" | "succeeded" = "running";
		const tool = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
			},
			getLaneRecords: () => [
				{ laneId: "worker-running", type: "tmux-worker", status: goalLaneStatus, goalId: "g1" },
				{ laneId: "other-goal-worker", type: "worker", status: "queued", goalId: "g2" },
			],
			now: () => "T0",
		});
		await tool.execute("call-start", { action: "start", goalId: "g1", userGoal: "Ship" }, undefined, undefined, ctx);

		const result = await tool.execute("call-complete", { action: "complete" }, undefined, undefined, ctx);

		expect(result).toMatchObject({
			isError: true,
			details: { applied: false, error: expect.stringContaining("worker-running") },
		});
		expect(state?.status).toBe("active");

		goalLaneStatus = "succeeded";
		const completed = await tool.execute(
			"call-complete-after-terminal",
			{ action: "complete" },
			undefined,
			undefined,
			ctx,
		);
		expect(completed.isError).not.toBe(true);
		expect(state?.status).toBe("completed");
	});

	it("reads a blocked ledger without exposing owner resume authority", async () => {
		const { run, getState } = createHarness();
		await run({ action: "start", goalId: "g1", userGoal: "Ship" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Get access" });
		await run({ action: "block_requirement", requirementId: "r1", reason: "waiting for user" });
		await run({ action: "no_progress" });
		await run({ action: "no_progress" });
		await run({ action: "no_progress" });
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

	it("lets compact lifecycle callers report concrete progress without terminalizing the goal", async () => {
		const { tool, run, getState } = createHarness();
		await run({ action: "start", goalId: "g1", userGoal: "Ship model-neutral goals" });
		await run({ action: "no_progress" });
		await run({ action: "no_progress" });
		const beforeRevision = getState()?.progressRevision;
		const update = createGoalLifecycleToolDefinitions(tool)[2];

		const progressed = await update.execute("call-progress", { status: "active" }, undefined, undefined, ctx);

		expect(progressed.isError).not.toBe(true);
		expect(getState()).toMatchObject({ status: "active", stallTurns: 0 });
		expect(getState()?.progressRevision).toBe((beforeRevision ?? 0) + 1);
	});

	it("rejects compact blocked updates before three stalled turns and preserves the supplied reason", async () => {
		const premature = createHarness();
		await premature.run({ action: "start", goalId: "g1", userGoal: "Ship" });
		const prematureUpdate = createGoalLifecycleToolDefinitions(premature.tool)[2];
		const rejected = await prematureUpdate.execute(
			"call-blocked-early",
			{ status: "blocked", reason: "waiting for owner access" },
			undefined,
			undefined,
			ctx,
		);
		expect(rejected.isError).toBe(true);
		expect(premature.getState()?.status).toBe("active");

		const eligible = createHarness();
		await eligible.run({ action: "start", goalId: "g2", userGoal: "Ship" });
		await eligible.run({ action: "no_progress" });
		await eligible.run({ action: "no_progress" });
		await eligible.run({ action: "no_progress" });
		const eligibleUpdate = createGoalLifecycleToolDefinitions(eligible.tool)[2];
		const missingReason = await eligibleUpdate.execute(
			"call-blocked-without-reason",
			{ status: "blocked" },
			undefined,
			undefined,
			ctx,
		);
		expect(missingReason.isError).toBe(true);
		expect(missingReason.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("reason") });
		const blocked = await eligibleUpdate.execute(
			"call-blocked",
			{ status: "blocked", reason: "waiting for owner access" },
			undefined,
			undefined,
			ctx,
		);
		expect(blocked.isError).not.toBe(true);
		expect(eligible.getState()).toMatchObject({
			status: "blocked",
			blockedReason: "waiting for owner access",
		});
	});
});

describe("goal setup in one call", () => {
	it("create_goal records every requirement with the same executor, in order, in one call", async () => {
		const harness = createHarness();
		const [createGoal] = createGoalLifecycleToolDefinitions(harness.tool);
		const result = await createGoal!.execute(
			"call-1",
			{ objective: "Ship the ledger", requirements: ["Strict TypeScript", "node:test coverage", "DESIGN.md"] },
			undefined,
			undefined,
			ctx,
		);
		expect(result.isError).toBeFalsy();
		expect(harness.getState()?.requirements.map((requirement) => requirement.text)).toEqual([
			"Strict TypeScript",
			"node:test coverage",
			"DESIGN.md",
		]);
		expect(JSON.stringify(result.details)).toContain("DESIGN.md");
	});

	it("reports the first requirement the executor rejects and keeps the goal it already started", async () => {
		const harness = createHarness();
		const [createGoal] = createGoalLifecycleToolDefinitions(harness.tool);
		const result = await createGoal!.execute(
			"call-1",
			{ objective: "Ship the ledger", requirements: ["Strict TypeScript", "Strict TypeScript"] },
			undefined,
			undefined,
			ctx,
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("already exists");
		expect(harness.getState()?.requirements).toHaveLength(1);
	});
});
