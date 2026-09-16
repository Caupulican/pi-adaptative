import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { expect, it, vi } from "vitest";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import { WorkerAgentControlCoordinator } from "../src/core/delegation/worker-agent-control-coordinator.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { createLocalWorkerProcessOwnerId, isLocalProcessAlive } from "../src/core/delegation/worker-process-owner.ts";
import { createTestExecutionGrant } from "./orchestration-profile-fixture.ts";
import { setConcurrentResponses } from "./suite/concurrent-responses.ts";
import { createHarness } from "./suite/harness.ts";

it.each(["lease", "foreign-parent", "stale-view"] as const)("queued recovery respects the %s fence", async (fence) => {
	const harness = await createHarness();
	const original = (harness.session as unknown as { _backgroundLanes: BackgroundLaneController })._backgroundLanes;
	const deps = (original as unknown as { deps: BackgroundLaneControllerDeps }).deps;
	const exited = spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" });
	expect(exited.status).toBe(0);
	const pid = Number(exited.stdout.trim());
	expect(isLocalProcessAlive(pid)).toBe(false);
	const incarnation = createLocalWorkerProcessOwnerId(pid, randomUUID());
	const identity = vi.spyOn(WorkerAgentControlCoordinator.prototype, "getProcessOwnerId").mockReturnValue(incarnation);
	let replacement: BackgroundLaneController | undefined;
	const remaining = setConcurrentResponses(harness, [fauxAssistantMessage('{"summary":"Done","status":"completed"}')]);
	try {
		const request = { instructions: "Execute this one accepted task." };
		const admitted = await original.startWorkerDelegation(request);
		if (!admitted.started) throw new Error(admitted.skipReason);
		identity.mockRestore();
		const lifecycle = new WorkerLifecycle({ agentDir: harness.tempDir, sessionId: harness.session.sessionId });
		const agent = lifecycle.getAgent(admitted.record.laneId)!;
		const store = new WorkerConversationStore();
		const open = {
			agentDir: harness.tempDir,
			resumeContext: agent.resumeContext,
			expectedLogicalAgentId: agent.agentId,
		};
		const binding = store.getProjectContextBinding(open)!;
		const stale = store.open({ ...open, projectClaim: binding.ownership.claim });
		if (fence === "lease") {
			const runtime = lifecycle.ledger.runtime;
			const attempt = lifecycle.getActiveAttempt(admitted.record.laneId)!;
			const task = lifecycle.getTask(attempt.taskId)!;
			runtime.bindAttemptGrant(
				attempt.attemptId,
				createTestExecutionGrant({
					objectiveId: task.task.objectiveId,
					taskId: attempt.taskId,
					attemptId: attempt.attemptId,
					role: agent.role,
				}),
			);
			runtime.leaseAttempt(attempt.attemptId, incarnation, 60000);
		}
		if (fence === "foreign-parent") {
			store.releaseProjectContext(stale);
			store.claimProjectContext({
				...open,
				specializationKey: binding.specializationKey,
				owner: { parentSessionId: "another-parent", incarnation },
			});
		}
		replacement = new BackgroundLaneController(deps);
		// Existing lease recovery expires an unbound dead-owner lease and queues its successor.
		// Establish that baseline first; this probe gates context takeover, not that separate transition.
		replacement.getLaneRecords();
		const before = lifecycle.getTaskRuntimeSnapshot();
		if (fence === "lease") {
			expect(
				Object.values(before.attempts)
					.map((attempt) => attempt.status)
					.sort(),
			).toEqual(["expired", "queued"]);
		}
		const metadata = readFileSync(`${agent.resumeContext.sessionFile}.worker.json`);
		const transcript = readFileSync(agent.resumeContext.sessionFile!);
		const outcome = await replacement.runWorkerDelegationOnce(request, undefined, admitted.record);
		if (fence === "stale-view") {
			expect(outcome.record?.status).toBe("succeeded");
			expect(remaining()).toBe(0);
			expect(() => stale.appendMessage({ role: "user", content: "stale write", timestamp: 0 })).toThrow();
			expect(
				store
					.open(open)
					.getRawTranscript()
					.some((message) => message.content === "stale write"),
			).toBe(false);
		} else {
			expect(outcome.started).toBe(false);
			expect(remaining()).toBe(1);
			expect(lifecycle.getTaskRuntimeSnapshot()).toEqual(before);
			expect(readFileSync(`${agent.resumeContext.sessionFile}.worker.json`)).toEqual(metadata);
			expect(readFileSync(agent.resumeContext.sessionFile!)).toEqual(transcript);
		}
	} finally {
		identity.mockRestore();
		replacement?.abortInFlightLanes();
		await harness.cleanup();
	}
});
