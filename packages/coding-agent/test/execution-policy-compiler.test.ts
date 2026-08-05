import { describe, expect, it } from "vitest";
import type { ToolCapabilityManifest } from "../src/core/orchestration/contracts.ts";
import { ExecutionPolicyCompiler } from "../src/core/orchestration/policy-compiler.ts";

const manifests: ToolCapabilityManifest[] = [
	{
		toolName: "read",
		moduleSpecifier: "./tools/read.ts",
		capabilities: ["filesystem.read"],
		roles: ["explorer", "implementer", "operator", "verifier"],
		enforcements: ["path-scope"],
	},
	{
		toolName: "bash",
		moduleSpecifier: "./tools/bash.ts",
		capabilities: ["process.exec"],
		roles: ["operator", "verifier"],
		enforcements: ["process-launcher"],
	},
	{
		toolName: "write",
		moduleSpecifier: "./tools/write.ts",
		capabilities: ["filesystem.write"],
		roles: ["implementer"],
		enforcements: ["path-scope"],
	},
];

function compiler(): ExecutionPolicyCompiler {
	let id = 1;
	return new ExecutionPolicyCompiler({
		now: () => "2026-07-23T12:00:00.000Z",
		createId: () => String(id++),
	});
}

describe("ExecutionPolicyCompiler", () => {
	it("compiles an immutable least-privilege grant and load plan", () => {
		const result = compiler().compile({
			objectiveId: "objective-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			subjectId: "worker-1",
			role: "implementer",
			requiredCapabilities: ["filesystem.read", "filesystem.write"],
			authorityCapabilities: ["filesystem.read", "filesystem.write", "process.exec"],
			requestedTools: ["read", "write"],
			toolManifests: manifests,
			readPaths: ["packages/coding-agent"],
			writePaths: ["packages/coding-agent"],
			requestedBudget: { maxTokens: 10_000, maxCostUsd: 1 },
			authorityBudget: { maxTokens: 20_000, maxCostUsd: 2 },
			policyVersion: "policy-1",
		});

		expect(result.outcome).toBe("allow");
		if (result.outcome !== "allow") return;
		expect(result.grant.capabilities).toEqual(["filesystem.read", "filesystem.write"]);
		expect(result.grant.allowedTools).toEqual(["read", "write"]);
		expect(result.toolManifests.map((manifest) => manifest.moduleSpecifier)).toEqual([
			"./tools/read.ts",
			"./tools/write.ts",
		]);
		expect(Object.isFrozen(result.grant)).toBe(true);
		expect(Object.isFrozen(result.grant.capabilities)).toBe(true);
	});

	it("blocks a capability even when a tool is renamed to hide it", () => {
		const result = compiler().compile({
			objectiveId: "objective-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			subjectId: "worker-1",
			role: "explorer",
			requiredCapabilities: ["filesystem.read"],
			authorityCapabilities: ["filesystem.read", "process.exec"],
			requestedTools: ["innocent_runner"],
			toolManifests: [
				...manifests,
				{
					toolName: "innocent_runner",
					moduleSpecifier: "extension:runner",
					capabilities: ["process.exec"],
					roles: ["explorer"],
					enforcements: ["process-launcher"],
				},
			],
			readPaths: ["."],
			policyVersion: "policy-1",
		});

		expect(result).toMatchObject({ outcome: "deny", reasonCodes: ["tool_capability_denied:innocent_runner"] });
	});

	it("refuses a manifest that claims authority without the required enforcement backend", () => {
		const result = compiler().compile({
			objectiveId: "objective-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			subjectId: "worker-1",
			role: "operator",
			requiredCapabilities: ["process.exec"],
			authorityCapabilities: ["process.exec"],
			requestedTools: ["unsafe_shell"],
			toolManifests: [
				{
					toolName: "unsafe_shell",
					moduleSpecifier: "extension:unsafe-shell",
					capabilities: ["process.exec"],
					roles: ["operator"],
					enforcements: [],
				},
			],
			policyVersion: "policy-1",
		});

		expect(result).toMatchObject({ outcome: "deny", reasonCodes: ["tool_enforcement_missing:unsafe_shell"] });
	});

	it("treats roles as scheduling labels when immutable authority grants the capability", () => {
		const result = compiler().compile({
			objectiveId: "objective-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			subjectId: "worker-1",
			role: "planner",
			requiredCapabilities: ["process.exec"],
			authorityCapabilities: ["process.exec"],
			requestedTools: [],
			toolManifests: manifests,
			policyVersion: "policy-1",
		});

		expect(result).toMatchObject({
			outcome: "allow",
			grant: { role: "planner", capabilities: ["process.exec"] },
		});
	});

	it("honors an explicit host-supplied role ceiling when an embedding chooses one", () => {
		const roleCapabilityCeilings = {
			orchestrator: ["workflow.delegate" as const],
			planner: ["workflow.plan" as const],
			explorer: ["filesystem.read" as const],
			implementer: ["filesystem.write" as const],
			operator: ["process.exec" as const],
			verifier: ["tests.execute" as const],
			database: ["memory.query" as const],
		};
		const result = new ExecutionPolicyCompiler({ roleCapabilityCeilings }).compile({
			objectiveId: "objective-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			subjectId: "worker-1",
			role: "planner",
			requiredCapabilities: ["process.exec"],
			authorityCapabilities: ["process.exec"],
			requestedTools: [],
			toolManifests: manifests,
			policyVersion: "policy-1",
		});

		expect(result).toMatchObject({ outcome: "deny", reasonCodes: ["required_capability_exceeds_role_ceiling"] });
	});

	it("requests approval when owner authority or budget is exceeded", () => {
		const result = compiler().compile({
			objectiveId: "objective-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			subjectId: "worker-1",
			role: "operator",
			requiredCapabilities: ["process.exec"],
			authorityCapabilities: ["filesystem.read"],
			requestedTools: ["bash"],
			toolManifests: manifests,
			requestedBudget: { maxCostUsd: 5 },
			authorityBudget: { maxCostUsd: 1 },
			policyVersion: "policy-1",
		});

		expect(result.outcome).toBe("approval-required");
		if (result.outcome !== "approval-required") return;
		expect(result.approval.requestedCapabilities).toEqual(["process.exec"]);
		expect(result.approval.reasonCode).toBe("requested_budget_exceeds_authority");
	});

	it("requires a positive path scope for filesystem authority", () => {
		const result = compiler().compile({
			objectiveId: "objective-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			subjectId: "worker-1",
			role: "explorer",
			requiredCapabilities: ["filesystem.read"],
			authorityCapabilities: ["filesystem.read"],
			requestedTools: ["read"],
			toolManifests: manifests,
			policyVersion: "policy-1",
		});

		expect(result).toMatchObject({
			outcome: "deny",
			reasonCodes: ["read_capability_missing_positive_path_scope"],
		});
	});

	it("intersects approval thresholds with cost ceilings in the canonical budget", () => {
		const result = compiler().compile({
			objectiveId: "objective-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			subjectId: "worker-1",
			role: "planner",
			requiredCapabilities: ["workflow.plan"],
			authorityCapabilities: ["workflow.plan"],
			requestedTools: [],
			toolManifests: [],
			requestedBudget: { maxCostUsd: 2, requireApprovalAboveCostUsd: 1.5 },
			authorityBudget: { maxCostUsd: 3, requireApprovalAboveCostUsd: 1 },
			policyVersion: "policy-1",
		});

		expect(result.outcome).toBe("allow");
		if (result.outcome !== "allow") return;
		expect(result.grant.budget).toMatchObject({ maxCostUsd: 1, requireApprovalAboveCostUsd: 1 });
	});
});
