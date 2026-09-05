import { describe, expect, it } from "vitest";
import type { WorkerClaim } from "../src/core/autonomy/contracts.ts";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createGoalWorkerDelegationRequest } from "../src/core/runtime-builder.ts";
import {
	createGoalToolDefinition,
	type GoalToolDependencies,
	type GoalToolDetails,
	type GoalToolInput,
} from "../src/core/tools/goal.ts";

const ctx = undefined as unknown as ExtensionContext;

/** Wires an in-memory goal tool over a plain in-memory state slot (no SessionManager needed). */
function createProducer(overrides: Partial<GoalToolDependencies> = {}) {
	let state: ReturnType<GoalToolDependencies["getGoalState"]>;
	let counter = 0;
	const tool = createGoalToolDefinition({
		getGoalState: () => state,
		saveGoalState: (s) => {
			state = s;
		},
		now: () => `T${counter++}`,
		...overrides,
	});
	return {
		run: async (input: GoalToolInput) => {
			const result = await tool.execute("call", input, undefined, undefined, ctx);
			return { content: result.content, details: result.details as GoalToolDetails };
		},
		getState: () => state,
	};
}

function firstText(content: Array<{ type: string; text?: string }>): string {
	const first = content[0];
	if (first?.type !== "text" || typeof first.text !== "string") {
		throw new Error("expected text content");
	}
	return first.text;
}

/**
 * `dispatch_worker`'s tool-layer side effect is now LIVE (previously it was a stub). These tests
 * exercise the adapter's honest reporting: a real dispatch (laneId), a real decline from an
 * underlying delegation starter that IS wired (skipReason), and the dependency being altogether
 * absent -- three distinct, never-conflated outcomes. `goal-worker-evidence.test.ts` already
 * covers the pure "worker" evidence-kind verification against injected
 * getLaneRecords/getWorkerClaimSnapshots; the last test here closes the loop end-to-end through
 * the SAME tool instance to prove the live dep wiring composes with that existing verification.
 */
describe("goal action 'dispatch_worker' (live adapter)", () => {
	it("maps the selected goal requirement into runtime-owned worker correlation", () => {
		expect(
			createGoalWorkerDelegationRequest({ requirementId: "r1", instructions: "implement the requirement" }),
		).toEqual({
			instructions: "implement the requirement",
			taskContext: {
				requirementIds: ["r1"],
				dependsOnTaskIds: [],
				acceptanceCriterionIds: [],
				resourcePointerIds: [],
			},
		});
	});

	it("captures a real laneId, binds it as boundLaneId, and reports the in-process route", async () => {
		const { run, getState } = createProducer({
			startWorkerDelegation: ({ requirementId }) => ({ laneId: `lane-for-${requirementId}` }),
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go do it" });

		expect(result.details.applied).toBe(true);
		expect(result.details.dispatchedLaneId).toBe("lane-for-r1");
		expect(result.details.dispatchSkipReason).toBeUndefined();
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBe("lane-for-r1");
		expect(getState()?.requirements.find((r) => r.id === "r1")?.status).toBe("open");
		expect(firstText(result.content)).toContain("Dispatched in-process worker lane 'lane-for-r1'");
		expect(firstText(result.content)).toContain("native default");
	});

	it("reports a real decline from a wired starter distinctly from an unwired dependency", async () => {
		const { run, getState } = createProducer({
			startWorkerDelegation: () => ({ skipReason: "worker_delegation_already_running" }),
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go do it" });

		expect(result.details.applied).toBe(true);
		expect(result.details.dispatchedLaneId).toBeUndefined();
		expect(result.details.dispatchSkipReason).toBe("worker_delegation_already_running");
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBeUndefined();
		expect(firstText(result.content)).toContain("worker_delegation_already_running");
	});

	it("reports 'dependency_unwired' distinctly when startWorkerDelegation is absent altogether", async () => {
		const { run, getState } = createProducer();

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go do it" });

		expect(result.details.dispatchSkipReason).toBe("dependency_unwired");
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBeUndefined();
	});

	it("end-to-end: a dispatched lane's worker result later verifies 'worker' evidence true through the SAME tool", async () => {
		let laneRecords: LaneRecord[] = [];
		let workerClaims: WorkerClaim[] = [];
		const { run, getState } = createProducer({
			startWorkerDelegation: ({ requirementId }) => {
				const laneId = `lane-for-${requirementId}`;
				laneRecords = [{ laneId, type: "worker", status: "succeeded" }];
				return { laneId };
			},
			getLaneRecords: () => laneRecords,
			getWorkerClaimSnapshots: () => workerClaims,
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const dispatched = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go do it" });
		const laneId = dispatched.details.dispatchedLaneId;
		expect(laneId).toBe("lane-for-r1");

		// The worker "completes" -- a result snapshot lands keyed by that same laneId.
		workerClaims = [
			{
				requestId: laneId as string,
				status: "completed",
				summary: "done",
				changedFiles: [],
				parentReviewRequired: false,
			},
		];

		await run({
			action: "add_evidence",
			evidenceId: "e1",
			kind: "worker",
			summary: "worker finished the task",
			uri: laneId,
		});
		expect(getState()?.evidence.find((e) => e.id === "e1")?.verified).toBe(true);

		await run({ action: "satisfy_requirement", requirementId: "r1", evidenceIds: ["e1"] });
		const completed = await run({ action: "complete" });
		expect(completed.details.applied).toBe(true);
		expect(getState()?.status).toBe("completed");
	});
});

/**
 * `dispatchTarget:"collaboration"` routing: an explicit persistent-worker opt-in that
 * defaults OFF. Selected ONLY when both `input.dispatchTarget === "collaboration"` AND `dispatchCollaborationWorker`
 * is wired; every other combination falls back to the EXISTING `startWorkerDelegation` in-process
 * path, byte-identical to before this field existed.
 */
describe("goal action 'dispatch_worker' (dispatchTarget routing)", () => {
	it("dispatchTarget:'collaboration' with the dep wired routes to dispatchCollaborationWorker, never startWorkerDelegation", async () => {
		let collaborationCalls = 0;
		let inProcessCalls = 0;
		const { run, getState } = createProducer({
			dispatchCollaborationWorker: async ({ requirementId }) => {
				collaborationCalls++;
				return { laneId: `collaboration-worker-for-${requirementId}` };
			},
			startWorkerDelegation: () => {
				inProcessCalls++;
				return { laneId: "should-not-be-used" };
			},
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({
			action: "dispatch_worker",
			requirementId: "r1",
			instructions: "go do it",
			dispatchTarget: "collaboration",
		});

		expect(collaborationCalls).toBe(1);
		expect(inProcessCalls).toBe(0);
		expect(result.details.dispatchedLaneId).toBe("collaboration-worker-for-r1");
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBe("collaboration-worker-for-r1");
		expect(firstText(result.content)).toContain("Dispatched collaboration worker lane 'collaboration-worker-for-r1'");
	});

	it("dispatchTarget omitted stays on the in-process path, byte-identical, even when dispatchCollaborationWorker is wired", async () => {
		let collaborationCalls = 0;
		const { run, getState } = createProducer({
			dispatchCollaborationWorker: async () => {
				collaborationCalls++;
				return { laneId: "should-not-be-used" };
			},
			startWorkerDelegation: ({ requirementId }) => ({ laneId: `lane-for-${requirementId}` }),
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({ action: "dispatch_worker", requirementId: "r1", instructions: "go do it" });

		expect(collaborationCalls).toBe(0);
		expect(result.details.dispatchedLaneId).toBe("lane-for-r1");
		expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBe("lane-for-r1");
		expect(firstText(result.content)).toContain("Dispatched in-process worker lane 'lane-for-r1'");
		expect(firstText(result.content)).toContain("native default");
	});

	it("dispatchTarget:'collaboration' with the dep UNWIRED falls back to the in-process path (honest, not a silent collaboration fake)", async () => {
		let inProcessCalls = 0;
		const { run } = createProducer({
			startWorkerDelegation: ({ requirementId }) => {
				inProcessCalls++;
				return { laneId: `lane-for-${requirementId}` };
			},
		});

		await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
		await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
		const result = await run({
			action: "dispatch_worker",
			requirementId: "r1",
			instructions: "go do it",
			dispatchTarget: "collaboration",
		});

		expect(inProcessCalls).toBe(1);
		expect(result.details.dispatchedLaneId).toBe("lane-for-r1");
	});

	it.each(["collaboration_dispatch_failed", "collaboration_dispatch_incomplete", "lane_correlation_failed"])(
		"does not dispatch a fallback after ambiguous collaboration outcome %s",
		async (skipReason) => {
			let nativeCalls = 0;
			const { run, getState } = createProducer({
				dispatchCollaborationWorker: async () => ({ skipReason }),
				startWorkerDelegation: () => {
					nativeCalls++;
					return { laneId: "duplicate-must-not-launch" };
				},
			});

			await run({ action: "start", goalId: "g1", userGoal: "Ship it" });
			await run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
			const result = await run({
				action: "dispatch_worker",
				requirementId: "r1",
				instructions: "go do it",
				dispatchTarget: "collaboration",
			});

			expect(result.details.applied).toBe(true);
			expect(result.details.dispatchedLaneId).toBeUndefined();
			expect(result.details.dispatchSkipReason).toBe(skipReason);
			expect(getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBeUndefined();
			expect(firstText(result.content)).toContain(skipReason);
			expect(nativeCalls).toBe(0);
		},
	);

	it.each(["collaboration_extension_not_loaded", "collaboration_unavailable"])(
		"falls back to the native worker when the explicit collaboration route returns %s",
		async (collaborationSkipReason) => {
			let nativeCalls = 0;
			const dispatchCollaborationWorker = async () => ({ skipReason: collaborationSkipReason });
			const producer = createProducer({
				dispatchCollaborationWorker,
				startWorkerDelegation: ({ requirementId }) => {
					nativeCalls++;
					return { laneId: `native-worker-for-${requirementId}` };
				},
			});

			await producer.run({ action: "start", goalId: "g1", userGoal: "Ship it" });
			await producer.run({ action: "add_requirement", requirementId: "r1", text: "Do the thing" });
			const result = await producer.run({
				action: "dispatch_worker",
				requirementId: "r1",
				instructions: "go do it",
				dispatchTarget: "collaboration",
			});

			expect(nativeCalls).toBe(1);
			expect(result.details.dispatchSkipReason).toBeUndefined();
			expect(result.details.dispatchedLaneId).toBe("native-worker-for-r1");
			expect(producer.getState()?.requirements.find((r) => r.id === "r1")?.boundLaneId).toBe("native-worker-for-r1");
			expect(firstText(result.content)).toContain(collaborationSkipReason);
			expect(firstText(result.content)).toContain("native fallback");
		},
	);
});
