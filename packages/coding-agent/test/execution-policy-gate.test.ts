import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { ExecutionPolicyCompiler } from "../src/core/orchestration/policy-compiler.ts";
import { ExecutionPolicyGate } from "../src/core/orchestration/policy-gate.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";

const roots: string[] = [];
const now = "2026-07-23T12:00:00.000Z";

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ExecutionPolicyGate", () => {
	it("persists approval, blocks execution, then binds a newly compiled owner-authorized grant", () => {
		const agentDir = join(tmpdir(), `pi-policy-gate-${process.pid}-${Date.now()}`);
		mkdirSync(agentDir, { recursive: true });
		roots.push(agentDir);
		let nextId = 1;
		const runtime = new DurableTaskRuntime({
			store: new OrchestrationEventStore({
				agentDir,
				sessionId: "policy-gate",
				now: () => now,
				createEventId: () => `event-${nextId++}`,
			}),
			now: () => Date.parse(now),
			createId: () => `runtime-${nextId++}`,
		});
		const objective = runtime.createObjective({ title: "Gate", description: "Gate elevated execution" });
		const task = runtime.createTask({
			objectiveId: objective.objectiveId,
			title: "Run process",
			description: "Run one bounded process",
			role: "operator",
			requiredCapabilities: ["process.exec"],
		});
		const attempt = runtime.queueAttempt(task.taskId, {
			taskId: task.taskId,
			profileId: "operator-fixed",
			instructions: "Run the process",
			resourcePointerIds: [],
		});
		const gate = new ExecutionPolicyGate({
			runtime,
			compiler: new ExecutionPolicyCompiler({ now: () => now, createId: () => "policy-1" }),
		});
		const input = {
			objectiveId: objective.objectiveId,
			taskId: task.taskId,
			attemptId: attempt.attemptId,
			subjectId: "worker-1",
			role: "operator" as const,
			requiredCapabilities: ["process.exec"] as const,
			requestedCapabilities: ["process.exec"] as const,
			authorityCapabilities: [] as const,
			requestedTools: ["run_process"],
			toolManifests: [
				{
					toolName: "run_process",
					moduleSpecifier: "./run-process.ts",
					capabilities: ["process.exec"] as const,
					roles: ["operator"] as const,
					enforcements: ["process-launcher", "path-scope"] as const,
				},
			],
			policyVersion: "test-v1",
		};

		const first = gate.evaluate(input);
		expect(first.outcome).toBe("approval-required");
		if (first.outcome !== "approval-required") return;
		expect(runtime.getSnapshot().approvals[first.approval.approvalId]?.status).toBe("pending");
		expect(() => runtime.leaseAttempt(attempt.attemptId, "worker-1", 60_000)).toThrow("awaiting approval");

		runtime.resolveApproval(first.approval.approvalId, "approved", "owner_approved_process_execution");
		const second = gate.evaluate({ ...input, authorityCapabilities: ["process.exec"] });
		expect(second.outcome).toBe("allow");
		expect(runtime.getSnapshot().attempts[attempt.attemptId]?.grantId).toBe(
			second.outcome === "allow" ? second.grant.grantId : undefined,
		);
		expect(runtime.leaseAttempt(attempt.attemptId, "worker-1", 60_000).attemptId).toBe(attempt.attemptId);
	});
});
