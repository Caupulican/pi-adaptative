import path from "node:path";
import type {
	ExecutionGrant,
	HarnessCapability,
	OrchestrationProfile,
	RiskBudget,
	ToolCapabilityManifest,
} from "../orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../orchestration/delegation-ledger.ts";
import { buildLaneToolManifests } from "../orchestration/lane-tool-manifests.ts";
import { ExecutionPolicyCompiler } from "../orchestration/policy-compiler.ts";
import { intersectRiskBudgets } from "../orchestration/risk-budget.ts";
import type { ResolvedWorkerDelegationSettings } from "../settings-manager.ts";

const READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const WRITE_TOOL_NAMES = ["write", "edit"] as const;

export interface WorkerExecutionPlan {
	toolManifests: readonly ToolCapabilityManifest[];
	requiredCapabilities: readonly HarnessCapability[];
	readPaths: readonly string[];
	writePaths: readonly string[];
	deniedPaths: readonly string[];
	readMemory: boolean;
	writeEnabled: boolean;
	processEnabled: boolean;
	budget: RiskBudget;
}

export function buildWorkerExecutionPlan(args: {
	profile: OrchestrationProfile;
	settings: ResolvedWorkerDelegationSettings;
	cwd: string;
	deniedPaths: readonly string[];
	foregroundMaxCostUsd?: number;
	memoryEnabled: boolean;
}): WorkerExecutionPlan {
	const grantsRead =
		args.profile.capabilityCeiling.includes("filesystem.read") ||
		args.profile.capabilityCeiling.includes("worktree.read");
	const writeEligible =
		args.settings.writeEnabled &&
		args.settings.writePaths.length > 0 &&
		(args.profile.capabilityCeiling.includes("filesystem.write") ||
			args.profile.capabilityCeiling.includes("worktree.mutate"));
	const memoryEligible =
		args.memoryEnabled &&
		args.profile.toolNames.includes("memory") &&
		args.profile.capabilityCeiling.includes("memory.query");
	const processEligible =
		args.profile.executionPolicy !== undefined &&
		(args.profile.capabilityCeiling.includes("process.exec") ||
			args.profile.capabilityCeiling.includes("tests.execute"));
	const enabledToolNames = [
		...(grantsRead ? READ_TOOL_NAMES : []),
		...(writeEligible ? WRITE_TOOL_NAMES : []),
		...(memoryEligible ? (["memory"] as const) : []),
		...(processEligible ? (["run_process"] as const) : []),
	];
	const toolManifests = buildLaneToolManifests(args.profile, enabledToolNames);
	const grantedTools = new Set(toolManifests.map((manifest) => manifest.toolName));
	const readEnabled = toolManifests.some((manifest) =>
		manifest.capabilities.some((capability) => capability === "filesystem.read" || capability === "worktree.read"),
	);
	const writeEnabled = grantedTools.has("write") || grantedTools.has("edit");
	const readMemory = grantedTools.has("memory");
	const processEnabled = grantedTools.has("run_process");
	const budget = intersectRiskBudgets(
		args.profile.budget,
		...(args.settings.maxUsd > 0 ? [{ maxCostUsd: args.settings.maxUsd }] : []),
		...(args.foregroundMaxCostUsd !== undefined ? [{ maxCostUsd: args.foregroundMaxCostUsd }] : []),
		...(args.settings.maxWallClockMs > 0 ? [{ maxWallClockMs: args.settings.maxWallClockMs }] : []),
	);
	return {
		toolManifests,
		requiredCapabilities: [...new Set(toolManifests.flatMap((manifest) => manifest.capabilities))],
		readPaths: readEnabled ? [path.resolve(args.cwd)] : [],
		writePaths: writeEnabled
			? args.settings.writePaths.map((entry) =>
					path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(args.cwd, entry),
				)
			: [],
		deniedPaths: args.deniedPaths.map((entry) => path.resolve(entry)),
		readMemory,
		writeEnabled,
		processEnabled,
		budget: { ...budget, maxToolCalls: budget.maxToolCalls ?? 6 },
	};
}

export function compileWorkerExecutionGrant(args: {
	handle: StartedDelegationAttempt;
	profile: OrchestrationProfile;
	plan: WorkerExecutionPlan;
}): { ok: true; grant: ExecutionGrant } | { ok: false; reasonCodes: readonly string[] } {
	const compiled = new ExecutionPolicyCompiler().compile({
		objectiveId: args.handle.objectiveId,
		taskId: args.handle.taskId,
		attemptId: args.handle.attemptId,
		subjectId: `in-process:${args.handle.attemptId}`,
		role: args.profile.role,
		requiredCapabilities: args.plan.requiredCapabilities,
		requestedCapabilities: args.plan.requiredCapabilities,
		authorityCapabilities: args.profile.capabilityCeiling,
		requestedTools: args.plan.toolManifests.map((manifest) => manifest.toolName),
		toolManifests: args.plan.toolManifests,
		readPaths: args.plan.readPaths,
		writePaths: args.plan.writePaths,
		deniedPaths: args.plan.deniedPaths,
		requestedBudget: args.plan.budget,
		authorityBudget: args.plan.budget,
		policyVersion: "worker-profile-v1",
		expiresAt: args.handle.expiresAt,
	});
	if (compiled.outcome !== "allow") return { ok: false, reasonCodes: compiled.reasonCodes };
	return { ok: true, grant: compiled.grant };
}
