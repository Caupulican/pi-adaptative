/**
 * H1b child: prepare+start one worker against a real store, then persist a progress mark
 * and wait to be SIGKILL'd. Not imported by the parent suite except as a spawn target.
 */
import { writeFileSync } from "node:fs";
import { WorkerLifecycle } from "../../src/core/delegation/worker-lifecycle.ts";
import { createWorkerExecutionContract } from "../../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "../../test/orchestration-profile-fixture.ts";

const agentDir = process.env.PI_H1B_AGENT_DIR;
const readyPath = process.env.PI_H1B_READY;
if (!agentDir || !readyPath) {
	process.stderr.write("H1b child missing PI_H1B_AGENT_DIR / PI_H1B_READY\n");
	process.exit(2);
}

const profile = createTestWorkerOrchestrationProfile({
	profileId: "worker",
	model: { provider: "test", id: "model", maxTokens: 8_192 },
});
const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "h1b" });
const prepared = lifecycle.prepare({
	instructions: "h1b kill target",
	executionContract: createWorkerExecutionContract({
		worker: {
			profile,
			modelBinding: profile.modelPolicy.candidates[0]!,
			authority: createTestWorkerExecutionAuthority(profile),
		},
	}),
	requiredCapabilities: [],
});
const attempt = lifecycle.getActiveAttempt(prepared.record.laneId);
if (!attempt) throw new Error("H1b child: no attempt");
const task = lifecycle.getTask(attempt.taskId);
if (!task) throw new Error("H1b child: no task");
lifecycle.bindGrant(
	attempt.attemptId,
	createTestExecutionGrant({
		objectiveId: task.task.objectiveId,
		taskId: attempt.taskId,
		attemptId: attempt.attemptId,
		role: task.task.role,
	}),
);
lifecycle.start(prepared.record.laneId, profile.leaseTtlMs);
writeFileSync(readyPath, `${prepared.record.laneId}\n`);
setInterval(() => {
	/* stay alive until SIGKILL */
}, 60_000);
