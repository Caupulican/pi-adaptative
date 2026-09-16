/**
 * The model-facing `delegate` seam under automatic specialist reuse.
 *
 * The tool under test is the one the session actually registered: `AgentSession.getToolDefinition`
 * returns the definition built by `runtime-builder.ts` (the production factory call site), with its
 * real host dependencies -- replay scope, task-directory context, worker agent control, grant
 * description. Nothing is re-wired by hand, so a missing host port shows up as a failing assertion
 * about durable state rather than as a fixture that quietly supplies what production does not.
 *
 * Only the provider is deterministic. Worker execution is scripted faux replies, and every provider
 * request is captured.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import type { GoalState } from "../src/core/goals/goal-state.ts";
import { MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH } from "../src/core/orchestration/contracts.ts";
import type { DelegateDispatchToolDetails, DelegateToolInput } from "../src/core/tools/delegate.ts";
import { createReuseHarness, type ReuseHarness } from "./fixtures/specialist-reuse-harness.ts";

const GOAL_A = "goal-retry-ladder";
const REQUIREMENT_A = "req-retry-ladder";
const GOAL_B = "goal-lease-fences";
const REQUIREMENT_B = "req-lease-fences";

/** One active goal with a single open requirement, in the durable goal-state shape. */
function goalWithRequirement(goalId: string, requirementId: string): GoalState {
	const now = new Date().toISOString();
	return {
		goalId,
		userGoal: `Goal ${goalId}`,
		status: "active",
		requirements: [
			{
				id: requirementId,
				text: `Requirement ${requirementId}`,
				status: "open",
				evidenceIds: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		evidence: [],
		events: [],
		createdAt: now,
		updatedAt: now,
		lastProgressAt: now,
		stallTurns: 0,
	};
}

/** The session's own registered delegate tool, as production built it. */
function delegateTool(context: ReuseHarness): ToolDefinition {
	const definition = context.harness.session.getToolDefinition("delegate");
	if (!definition) throw new Error("this session registered no delegate tool");
	return definition;
}

function toolContext(context: ReuseHarness): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => context.harness.sessionManager.getSessionId(),
			getLeafId: () => context.harness.sessionManager.getLeafId(),
		},
	} as unknown as ExtensionContext;
}

async function runDelegate(
	context: ReuseHarness,
	toolCallId: string,
	input: DelegateToolInput,
): Promise<DelegateDispatchToolDetails> {
	const result = await delegateTool(context).execute(toolCallId, input, undefined, undefined, toolContext(context));
	const details = result.details;
	if (!details || typeof details !== "object" || Array.isArray(details) || !("started" in details)) {
		throw new TypeError("delegate returned no dispatch details");
	}
	await context.settleLanes();
	return details as DelegateDispatchToolDetails;
}

/** Durable turns this specialist owns, excluding its own birth task. */
function turnAttempts(context: ReuseHarness, agentId: string) {
	return context
		.attempts()
		.filter((attempt) => attempt.dispatch.logicalLaneId === agentId && attempt.taskId !== agentId);
}

describe("delegate specialist reuse surface", () => {
	it("reports the authoritative stable agentId, not the task lane, across two tasks", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("first tool task done");
		context.appendWorkerReply("second tool task done");

		const first = await runDelegate(context, "call-1", { action: "start", instructions: "First tool brief" });
		const second = await runDelegate(context, "call-2", { action: "start", instructions: "Second tool brief" });

		expect(first.started).toBe(true);
		expect(second.started).toBe(true);
		// The second task runs on the same specialist, so its lane is a turn lane and the reported
		// agentId must be the durable identity rather than that lane id.
		expect(second.agentId).toBe(first.agentId);
		expect(second.laneId).not.toBe(second.agentId);
		expect(Object.keys(context.agents())).toHaveLength(1);
		expect(context.workerRequests()).toHaveLength(2);
		expect(context.workerRequests()[1]?.text).toContain("First tool brief");
	});

	it("correlates an explicit reuse start to the goal that is current when it is dispatched", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("goal A task done");
		context.appendWorkerReply("goal B task done");
		context.harness.session.saveGoalStateSnapshot(goalWithRequirement(GOAL_A, REQUIREMENT_A));

		const first = await runDelegate(context, "call-1", {
			action: "start",
			instructions: "Work the retry ladder",
			requirementIds: [REQUIREMENT_A],
		});
		const agentId = first.agentId ?? "";
		expect(agentId).not.toBe("");
		// The parent moves on to a different goal before the specialist's next task.
		context.harness.session.saveGoalStateSnapshot(goalWithRequirement(GOAL_B, REQUIREMENT_B));

		const second = await runDelegate(context, "call-2", {
			action: "start",
			agentId,
			instructions: "Work the lease fences",
			requirementIds: [REQUIREMENT_B],
		});

		expect(second.started).toBe(true);
		const turn = turnAttempts(context, agentId).at(-1);
		expect(turn).toBeDefined();
		// The new task belongs to the CURRENT goal and to the requirements the caller named; the goal
		// the specialist happened to run first must not follow it.
		expect(turn?.dispatch.requirementIds).toEqual([REQUIREMENT_B]);
		expect(context.taskObjectiveId(turn?.taskId ?? "")).toBe(`goal:${GOAL_B}`);
		expect(context.taskObjectiveId(turn?.taskId ?? "")).not.toBe(`goal:${GOAL_A}`);
		expect(turn?.dispatch.requirementIds).not.toContain(REQUIREMENT_A);
	});

	it("correlates an anonymous reused start to the goal that is current when it is dispatched", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("goal A task done");
		context.appendWorkerReply("goal B task done");
		context.harness.session.saveGoalStateSnapshot(goalWithRequirement(GOAL_A, REQUIREMENT_A));

		const first = await runDelegate(context, "call-1", {
			action: "start",
			instructions: "Work the retry ladder",
			requirementIds: [REQUIREMENT_A],
		});
		context.harness.session.saveGoalStateSnapshot(goalWithRequirement(GOAL_B, REQUIREMENT_B));

		const second = await runDelegate(context, "call-2", {
			action: "start",
			instructions: "Work the lease fences",
			requirementIds: [REQUIREMENT_B],
		});

		// Reuse must not change what an unnamed start means: it is new work on the current goal.
		expect(second.agentId).toBe(first.agentId);
		const turn = turnAttempts(context, first.agentId ?? "").at(-1);
		expect(turn?.dispatch.requirementIds).toEqual([REQUIREMENT_B]);
		expect(context.taskObjectiveId(turn?.taskId ?? "")).toBe(`goal:${GOAL_B}`);
	});

	it("negative control: an intentional follow_up stays a continuation, not new work", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("goal A task done");
		context.appendWorkerReply("follow-up done");
		context.harness.session.saveGoalStateSnapshot(goalWithRequirement(GOAL_A, REQUIREMENT_A));
		const first = await runDelegate(context, "call-1", {
			action: "start",
			instructions: "Work the retry ladder",
			requirementIds: [REQUIREMENT_A],
		});
		const agentId = first.agentId ?? "";
		context.harness.session.saveGoalStateSnapshot(goalWithRequirement(GOAL_B, REQUIREMENT_B));

		const followUp = await runDelegate(context, "call-2", {
			action: "follow_up",
			agentId,
			message: "Keep going on exactly what you were doing",
		});

		expect(followUp.started !== false || followUp.accepted === true).toBe(true);
		const turn = turnAttempts(context, agentId).at(-1);
		// A follow-up inherits; a defaulting host must not silently convert it into new goal-B work.
		expect(context.taskObjectiveId(turn?.taskId ?? "")).toBe(`goal:${GOAL_A}`);
		expect(turn?.dispatch.requirementIds).toEqual([REQUIREMENT_A]);
	});

	it("does not create a second task when one durable tool call is replayed after completion", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("replayable task done");

		const first = await runDelegate(context, "call-replay", { action: "start", instructions: "Replayable brief" });
		const tasksAfterFirst = context.attempts().length;
		const workerRequestsAfterFirst = context.workerRequests().length;
		const replay = await runDelegate(context, "call-replay", { action: "start", instructions: "Replayable brief" });

		expect(first.started).toBe(true);
		// The same durable tool call is one task, whether it is replayed while running or after it
		// settled; reuse must not turn a replay into a second turn on the specialist.
		expect(context.attempts()).toHaveLength(tasksAfterFirst);
		expect(context.workerRequests()).toHaveLength(workerRequestsAfterFirst);
		expect(replay.agentId).toBe(first.agentId);
	});

	it("reuses a specialist for a valid brief larger than the peer-message cap", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("opened the specialist");
		context.appendWorkerReply("handled the extended brief");
		const first = await runDelegate(context, "call-1", { action: "start", instructions: "Open the specialist" });
		const agentId = first.agentId ?? "";
		// Valid for a dispatch (16k cap), far above the 4k ordinary control-message cap.
		const brief = `Extended brief: ${"detail ".repeat(1_200)}`;
		expect(brief.length).toBeGreaterThan(8_000);
		expect(brief.length).toBeLessThanOrEqual(MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH);

		const accepted = await runDelegate(context, "call-2", { action: "start", agentId, instructions: brief });

		// A brief the dispatch contract accepts must not be refused or silently shortened just because
		// reuse routes it through the mailbox.
		expect(accepted.started ? "started" : (accepted.skipReason ?? "refused")).toBe("started");
		expect(turnAttempts(context, agentId).at(-1)?.dispatch.instructions).toBe(brief);
	});

	it("negative control: a brief over the dispatch maximum is refused", async () => {
		const context = await createReuseHarness();
		const oversized = "x".repeat(MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH + 1);

		const refused = await runDelegate(context, "call-1", { action: "start", instructions: oversized });

		expect(refused.started).toBe(false);
		expect(Object.keys(context.agents())).toHaveLength(0);
		expect(context.workerRequests()).toHaveLength(0);
	});

	it("does not force a duplicate when an explicit override equals the specialist's admitted binding", async () => {
		const context = await createReuseHarness();
		context.appendWorkerReply("opened the specialist");
		context.appendWorkerReply("continued with the same binding");
		const first = await runDelegate(context, "call-1", { action: "start", instructions: "Open the specialist" });
		const agentId = first.agentId ?? "";
		const [provider, ...rest] = (first.modelRef ?? "").split("/");
		expect(provider).toBeTruthy();

		const equalOverride = await runDelegate(context, "call-2", {
			action: "start",
			agentId,
			instructions: "Continue with the same binding",
			model: { provider: provider ?? "", modelId: rest.join("/") },
		});

		// An override that resolves to the binding this specialist already holds is not a reason to
		// tell the model to mint a second copy.
		expect(equalOverride.started ? "started" : (equalOverride.skipReason ?? "refused")).toBe("started");
		expect(Object.keys(context.agents())).toHaveLength(1);
	});
});
