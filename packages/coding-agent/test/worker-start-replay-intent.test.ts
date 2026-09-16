import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { createResourceReuseHarness, writeAdmittedSkill } from "./fixtures/resource-specialist-harness.ts";
import { createReuseHarness } from "./fixtures/specialist-reuse-harness.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker start command replay intent", () => {
	it.each([false, true])("rejects changed dependencies on a replay, reused=%s", async (reuse) => {
		const context = await createReuseHarness();
		const dependency = await context.harness.session.runWorkerDelegationOnce({
			instructions: "establish a dependency",
			authority: { readOnly: true },
		});
		expect(dependency.record?.status).toBe("succeeded");
		if (reuse) await context.harness.session.runWorkerDelegationOnce({ instructions: "establish the specialist" });
		const request: WorkerDelegationRequest = {
			instructions: "work after dependency",
			messageReplayKey: "dependency-command",
			taskContext: {
				requirementIds: [],
				acceptanceCriterionIds: [],
				resourcePointerIds: [],
				dependsOnTaskIds: [dependency.record!.laneId],
			},
		};
		const first = await context.harness.session.runWorkerDelegationOnce(request);
		expect(first.record?.status).toBe("succeeded");
		const attempts = context.attempts().length;
		const requests = context.workerRequests().length;
		const exact = await context.lanes().startWorkerDelegation(request);
		expect(exact.started && exact.record.laneId).toBe(first.record!.laneId);
		const changed = await context
			.lanes()
			.startWorkerDelegation({ ...request, taskContext: { ...request.taskContext!, dependsOnTaskIds: [] } });
		expect(changed.started).toBe(false);
		expect(changed.started ? "" : changed.skipReason).toMatch(/replay_conflict/);
		expect(context.attempts()).toHaveLength(attempts);
		expect(context.workerRequests()).toHaveLength(requests);
	});

	it.each(["1", "none"])(
		"rejects changed fork declaration %s while exact replay survives parent growth",
		async (changedMode) => {
			const context = await createReuseHarness();
			await context.harness.session.prompt("Original parent context", { autoContinueGoal: false });
			const request: WorkerDelegationRequest = {
				instructions: "work from parent",
				forkTurns: "all",
				messageReplayKey: "fork-command",
			};
			const first = await context.harness.session.runWorkerDelegationOnce(request);
			expect(first.record?.status).toBe("succeeded");
			await context.harness.session.waitForForegroundIdle();
			await context.harness.session.prompt("Parent progressed after the admitted command", {
				autoContinueGoal: false,
			});
			const attempts = context.attempts().length;
			const requests = context.workerRequests().length;
			const exact = await context.lanes().startWorkerDelegation(request);
			expect(exact.started && exact.record.laneId).toBe(first.record!.laneId);
			const changed = await context.lanes().startWorkerDelegation({ ...request, forkTurns: changedMode });
			expect(changed.started).toBe(false);
			expect(changed.started ? "" : changed.skipReason).toMatch(/replay_conflict/);
			expect(context.attempts()).toHaveLength(attempts);
			expect(context.workerRequests()).toHaveLength(requests);
		},
	);

	it("replays a named new task with implicit admitted resources", async () => {
		const skill = writeAdmittedSkill("REPLAY_RESOURCE_DOCTRINE");
		roots.push(skill.root);
		const context = await createResourceReuseHarness(skill.skillPath);
		const first = await context.harness.session.runWorkerDelegationOnce({ instructions: "read resource doctrine" });
		expect(first.record?.status).toBe("succeeded");
		const agentId = first.record!.agentId!;
		const options = { idempotencyKey: "implicit-resource-command", newTask: {} };
		const admitted = context.lanes().startWorkerAgentTask(agentId, "apply resource doctrine again", options);
		await context.settleLanes();
		expect(admitted.started).toBe(true);
		const attempts = context.attempts().length;
		const requests = context.workerRequests().length;
		const replay = context.lanes().startWorkerAgentTask(agentId, "apply resource doctrine again", options);
		expect(replay.skipReason ?? "").not.toMatch(/conflict/);
		expect(replay.record?.laneId).toBe(admitted.record?.laneId);
		expect(context.attempts()).toHaveLength(attempts);
		expect(context.workerRequests()).toHaveLength(requests);
	});
});
