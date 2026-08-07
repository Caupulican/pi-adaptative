import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_WORKER_FLEET_LIMITS,
	evaluateNewWorkerAdmission,
	evaluateReusableWorkerTaskAdmission,
	pendingVerifierSubjectTaskIds,
	workerQueueHasCapacity,
} from "../src/core/delegation/worker-fleet-limits.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { type AgentBindingContract, ORCHESTRATION_SCHEMA_VERSION } from "../src/core/orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../src/core/orchestration/task-runtime.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-worker-fleet-limits-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	while (roots.length > 0) {
		const value = roots.pop();
		if (value) rmSync(value, { recursive: true, force: true });
	}
});

function binding(
	agentId: string,
	input: {
		parentAgentId?: string;
		rootAgentId?: string;
		depth?: number;
		status?: AgentBindingContract["status"];
	} = {},
): AgentBindingContract {
	const timestamp = "2026-08-07T00:00:00.000Z";
	return {
		schemaVersion: 1,
		agentId,
		resumeContext: {
			provider: "pi",
			sessionId: `session-${agentId}`,
			cwd: "/workspace",
			resourceProfileNames: [],
			contextPointers: [],
		},
		...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
		rootAgentId: input.rootAgentId ?? agentId,
		depth: input.depth ?? 0,
		role: "implementer",
		status: input.status ?? "registered",
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

describe("worker fleet admission limits", () => {
	it("admits a child below every durable fleet boundary", () => {
		const root = binding("root");
		const child = binding("child", { parentAgentId: "root", rootAgentId: "root", depth: 1 });

		expect(evaluateNewWorkerAdmission({ root, child }, "child")).toEqual({
			ok: true,
			depth: 2,
		});
	});

	it("rejects descendants beyond the fixed depth ceiling", () => {
		const parent = binding("parent", {
			parentAgentId: "ancestor",
			rootAgentId: "root",
			depth: DEFAULT_WORKER_FLEET_LIMITS.maxDepth,
		});

		expect(evaluateNewWorkerAdmission({ parent }, "parent")).toEqual({
			ok: false,
			reasonCode: "worker_agent_depth_limit_reached",
		});
	});

	it("rejects a parent whose direct fan-out reached the fixed child ceiling", () => {
		const agents: Record<string, AgentBindingContract> = { root: binding("root") };
		for (let index = 0; index < DEFAULT_WORKER_FLEET_LIMITS.maxChildrenPerAgent; index += 1) {
			const agentId = `child-${index}`;
			agents[agentId] = binding(agentId, { parentAgentId: "root", rootAgentId: "root", depth: 1 });
		}

		expect(evaluateNewWorkerAdmission(agents, "root")).toEqual({
			ok: false,
			reasonCode: "worker_agent_child_limit_reached",
		});
	});

	it("counts retired identities toward the persistent session ceiling", () => {
		const agents: Record<string, AgentBindingContract> = {};
		for (let index = 0; index < DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession; index += 1) {
			const agentId = `agent-${index}`;
			agents[agentId] = binding(agentId, { status: "retired" });
		}

		expect(evaluateNewWorkerAdmission(agents)).toEqual({
			ok: false,
			reasonCode: "worker_agent_session_limit_reached",
		});
	});

	it("reserves identity headroom for an admitted implementation and its required verifier", () => {
		const agents: Record<string, AgentBindingContract> = {};
		for (let index = 0; index < DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession - 2; index += 1) {
			const agentId = `agent-${index}`;
			agents[agentId] = binding(agentId);
		}

		expect(evaluateNewWorkerAdmission(agents, undefined, DEFAULT_WORKER_FLEET_LIMITS, 2)).toEqual({
			ok: true,
			depth: 0,
		});
		agents["final-ordinary-slot"] = binding("final-ordinary-slot");
		expect(evaluateNewWorkerAdmission(agents, undefined, DEFAULT_WORKER_FLEET_LIMITS, 2)).toEqual({
			ok: false,
			reasonCode: "worker_agent_session_limit_reached",
		});
	});

	it("retains verifier headroom across a restart until the durable verifier identity is bound", () => {
		const agentDir = root();
		const sessionId = "verifier-binding-crash-window";
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId });
		const verifierProfile = createTestWorkerOrchestrationProfile({
			profileId: "crash-window-verifier",
			model: { provider: "faux", id: "faux-1" },
			role: "verifier",
		});
		const implementationProfile = createTestWorkerOrchestrationProfile({
			profileId: "crash-window-implementation",
			model: { provider: "faux", id: "faux-1" },
			requireIndependentVerification: true,
			verificationProfileId: verifierProfile.profileId,
		});
		const implementation = lifecycle.prepare({
			instructions: "Implement before the verifier binding crash window.",
			executionContract: createWorkerExecutionContract({
				worker: {
					profile: implementationProfile,
					modelBinding: implementationProfile.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(implementationProfile, agentDir),
				},
				verifier: {
					profile: verifierProfile,
					modelBinding: verifierProfile.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(verifierProfile, agentDir),
				},
			}),
			requiredCapabilities: [],
		});
		const task = lifecycle.getTask(implementation.record.laneId);
		if (!task) throw new Error("Expected implementation task.");
		lifecycle.bindGrant(
			implementation.attempt.attemptId,
			createTestExecutionGrant({
				objectiveId: task.task.objectiveId,
				taskId: implementation.attempt.taskId,
				attemptId: implementation.attempt.attemptId,
				role: implementationProfile.role,
			}),
		);
		const handle = lifecycle.start(implementation.record.laneId, implementationProfile.leaseTtlMs);
		lifecycle.finish(
			{
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				resultId: `result-${handle.attemptId}`,
				objectiveId: handle.objectiveId,
				taskId: handle.taskId,
				attemptId: handle.attemptId,
				leaseId: handle.leaseId,
				fencingToken: handle.fencingToken,
				status: "partial",
				reasonCode: "independent_verification_required",
				summary: "Implementation awaits its admitted verifier.",
				artifacts: [],
				evidence: [],
				errors: [],
				usage: { costUsd: 0, wallClockMs: 1, toolCalls: 0 },
				nextAction: "independent_verification_required",
				createdAt: new Date().toISOString(),
			},
			{ notify: false },
		);
		const verifier = lifecycle.prepare({
			instructions: "Verify the implementation.",
			executionContract: createWorkerExecutionContract({
				worker: {
					profile: verifierProfile,
					modelBinding: verifierProfile.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(verifierProfile, agentDir),
				},
			}),
			requiredCapabilities: [],
			verificationOfTaskId: implementation.record.laneId,
		});

		const restarted = new WorkerLifecycle({ agentDir, sessionId });
		expect(pendingVerifierSubjectTaskIds(restarted.getTaskRuntimeSnapshot())).toEqual(
			new Set([implementation.record.laneId]),
		);

		restarted.ensureAgent({
			agentId: verifier.record.laneId,
			role: verifierProfile.role,
			resumeContext: {
				provider: "external",
				sessionId: "durable-verifier-conversation",
				cwd: agentDir,
				resourceProfileNames: [],
				contextPointers: [],
			},
		});
		const afterBindingRestart = new WorkerLifecycle({ agentDir, sessionId });
		expect(pendingVerifierSubjectTaskIds(afterBindingRestart.getTaskRuntimeSnapshot())).toEqual(new Set());
	});

	it("reserves the final bounded queue slot for mandatory verifier work", () => {
		const ordinaryCeiling = DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 1;

		expect(workerQueueHasCapacity(ordinaryCeiling - 1, false)).toBe(true);
		expect(workerQueueHasCapacity(ordinaryCeiling, false)).toBe(false);
		expect(workerQueueHasCapacity(ordinaryCeiling, true)).toBe(true);
		expect(workerQueueHasCapacity(DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches, true)).toBe(false);
	});

	it("uses durable attempt insertion order for an interleaved old-task retry despite reversed clocks", () => {
		const verifierProfile = createTestWorkerOrchestrationProfile({
			profileId: "reuse-order-verifier",
			model: { provider: "faux", id: "faux-1" },
			role: "verifier",
		});
		const implementationProfile = createTestWorkerOrchestrationProfile({
			profileId: "reuse-order-implementation",
			model: { provider: "faux", id: "faux-1" },
			requireIndependentVerification: true,
			verificationProfileId: verifierProfile.profileId,
		});
		const executionContract = createWorkerExecutionContract({
			worker: {
				profile: implementationProfile,
				modelBinding: implementationProfile.modelPolicy.candidates[0]!,
				authority: createTestWorkerExecutionAuthority(implementationProfile, "/workspace"),
			},
			verifier: {
				profile: verifierProfile,
				modelBinding: verifierProfile.modelPolicy.candidates[0]!,
				authority: createTestWorkerExecutionAuthority(verifierProfile, "/workspace"),
			},
		});
		const attempt = (
			attemptId: string,
			taskId: string,
			createdAt: string,
			withVerifier: boolean,
		): AttemptRuntimeState => ({
			attemptId,
			taskId,
			agentId: "agent-1",
			dispatch: {
				provider: "pi",
				taskId,
				instructions: "inspect",
				profileId: implementationProfile.profileId,
				logicalLaneId: "agent-1",
				resourcePointerIds: [],
				...(withVerifier ? { executionContract } : {}),
			},
			status: "completed",
			checkpointIds: [],
			createdAt,
			updatedAt: createdAt,
		});
		const oldTaskFirst = attempt("attempt-old-first", "task-old", "2026-08-07T03:00:00.000Z", false);
		const laterTask = attempt("attempt-later-task", "task-later", "2026-08-07T02:00:00.000Z", false);
		const oldTaskRetry = attempt("attempt-old-retry", "task-old", "2026-08-07T01:00:00.000Z", true);
		const agent = binding("agent-1");
		const snapshot = {
			agents: { [agent.agentId]: agent },
			tasks: {},
			attempts: {
				[oldTaskFirst.attemptId]: oldTaskFirst,
				[laterTask.attemptId]: laterTask,
				[oldTaskRetry.attemptId]: oldTaskRetry,
			},
		} as unknown as TaskRuntimeProjection;

		expect(
			evaluateReusableWorkerTaskAdmission(snapshot, agent.agentId, {
				...DEFAULT_WORKER_FLEET_LIMITS,
				maxAgentsPerSession: 1,
			}),
		).toEqual({ ok: false, reasonCode: "worker_agent_session_limit_reached" });
	});
});
