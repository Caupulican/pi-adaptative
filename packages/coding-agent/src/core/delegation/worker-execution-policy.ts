import path from "node:path";
import { isPathWithinScope } from "../autonomy/path-scope.ts";
import { mapToolNamesForPlatform, STABLE_SHELL_TOOL_NAME } from "../default-tool-surface.ts";
import type {
	ExecutionGrant,
	HarnessCapability,
	OrchestrationProfile,
	ResourcePointer,
	RiskBudget,
	ToolCapabilityManifest,
	WorkerExecutionAuthorityContract,
	WorkerRole,
} from "../orchestration/contracts.ts";
import { buildLaneToolManifests } from "../orchestration/lane-tool-manifests.ts";
import { ExecutionPolicyCompiler } from "../orchestration/policy-compiler.ts";
import { intersectRiskBudgets } from "../orchestration/risk-budget.ts";
import type { ResolvedWorkerDelegationSettings } from "../settings-manager.ts";
import { getToolCapabilityPolicy } from "../tool-capability-policy.ts";

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

function intersectPathScopes(admittedPaths: readonly string[], currentPaths: readonly string[]): string[] {
	const intersections = admittedPaths.flatMap((admitted) =>
		currentPaths.flatMap((current) => {
			if (isPathWithinScope(current, admitted)) return [current];
			if (isPathWithinScope(admitted, current)) return [admitted];
			return [];
		}),
	);
	return [...new Set(intersections.map((entry) => path.resolve(entry)))];
}

export function workerExecutionAuthorityFromPlan(plan: WorkerExecutionPlan): WorkerExecutionAuthorityContract {
	return {
		capabilities: [...plan.requiredCapabilities],
		toolNames: plan.toolManifests.map((manifest) => manifest.toolName),
		readPaths: [...plan.readPaths],
		writePaths: [...plan.writePaths],
		deniedPaths: [...plan.deniedPaths],
		budget: { ...plan.budget },
	};
}

/** Apply live revocations to admitted authority without allowing later settings to widen it. */
export function narrowWorkerExecutionPlan(
	admitted: WorkerExecutionAuthorityContract,
	current: WorkerExecutionPlan,
): WorkerExecutionPlan {
	const admittedTools = new Set(mapToolNamesForPlatform(admitted.toolNames));
	const admittedCapabilities = new Set(admitted.capabilities);
	const toolManifests = current.toolManifests.filter(
		(manifest) =>
			admittedTools.has(manifest.toolName) &&
			manifest.capabilities.every((capability) => admittedCapabilities.has(capability)),
	);
	const requiredCapabilities = [...new Set(toolManifests.flatMap((manifest) => manifest.capabilities))];
	const grantedTools = new Set(toolManifests.map((manifest) => manifest.toolName));
	const readEnabled = requiredCapabilities.some(
		(capability) => capability === "filesystem.read" || capability === "worktree.read",
	);
	const writeEnabled = grantedTools.has("write") || grantedTools.has("edit");
	return {
		toolManifests,
		requiredCapabilities,
		readPaths: readEnabled ? intersectPathScopes(admitted.readPaths, current.readPaths) : [],
		writePaths: writeEnabled ? intersectPathScopes(admitted.writePaths, current.writePaths) : [],
		deniedPaths: [...new Set([...admitted.deniedPaths, ...current.deniedPaths].map((entry) => path.resolve(entry)))],
		readMemory: grantedTools.has("memory"),
		writeEnabled,
		processEnabled: grantedTools.has("run_process") || grantedTools.has(STABLE_SHELL_TOOL_NAME),
		budget: intersectRiskBudgets(admitted.budget, current.budget),
	};
}

export function buildWorkerExecutionPlan(args: {
	profile: OrchestrationProfile;
	settings: ResolvedWorkerDelegationSettings;
	cwd: string;
	deniedPaths: readonly string[];
	foregroundMaxCostUsd?: number;
	memoryEnabled: boolean;
	requestedReadPaths?: readonly string[];
	requestedWritePaths?: readonly string[];
}): WorkerExecutionPlan {
	const profileToolNames = new Set(mapToolNamesForPlatform(args.profile.toolNames));
	const grantsRead =
		args.profile.capabilityCeiling.includes("filesystem.read") ||
		args.profile.capabilityCeiling.includes("worktree.read");
	const writeEligible =
		args.settings.writeEnabled &&
		args.settings.writePaths.length > 0 &&
		(args.profile.capabilityCeiling.includes("filesystem.write") ||
			args.profile.capabilityCeiling.includes("worktree.mutate"));
	const memoryEligible = args.memoryEnabled;
	const processEligible =
		args.profile.capabilityCeiling.includes("process.exec") ||
		args.profile.capabilityCeiling.includes("tests.execute");
	const enabledProcessToolNames = processEligible
		? [
				...(args.profile.executionPolicy && profileToolNames.has("run_process") ? (["run_process"] as const) : []),
				...(profileToolNames.has(STABLE_SHELL_TOOL_NAME) ? [STABLE_SHELL_TOOL_NAME] : []),
			]
		: [];
	const enabledToolNames = [
		...(grantsRead ? READ_TOOL_NAMES : []),
		...(writeEligible ? WRITE_TOOL_NAMES : []),
		...(memoryEligible ? (["memory"] as const) : []),
		...enabledProcessToolNames,
		...(profileToolNames.has("delegate") && args.profile.capabilityCeiling.includes("workflow.delegate")
			? (["delegate"] as const)
			: []),
	];
	const toolManifests = buildLaneToolManifests(args.profile, enabledToolNames);
	if (memoryEligible && !toolManifests.some((manifest) => manifest.toolName === "memory")) {
		toolManifests.push({
			toolName: "memory",
			moduleSpecifier: "../tools/memory.ts",
			capabilities: ["memory.query"],
			roles: [args.profile.role],
			enforcements: ["memory-broker"],
		});
	}
	const grantedTools = new Set(toolManifests.map((manifest) => manifest.toolName));
	const readEnabled = toolManifests.some((manifest) =>
		manifest.capabilities.some((capability) => capability === "filesystem.read" || capability === "worktree.read"),
	);
	const writeEnabled = grantedTools.has("write") || grantedTools.has("edit");
	const readMemory = grantedTools.has("memory");
	const processEnabled = grantedTools.has("run_process") || grantedTools.has(STABLE_SHELL_TOOL_NAME);
	const budget = intersectRiskBudgets(
		args.profile.budget,
		...(args.settings.maxUsd > 0 ? [{ maxCostUsd: args.settings.maxUsd }] : []),
		...(args.foregroundMaxCostUsd !== undefined ? [{ maxCostUsd: args.foregroundMaxCostUsd }] : []),
		...(args.settings.maxWallClockMs > 0 ? [{ maxWallClockMs: args.settings.maxWallClockMs }] : []),
	);
	return {
		toolManifests,
		requiredCapabilities: [...new Set(toolManifests.flatMap((manifest) => manifest.capabilities))],
		readPaths: readEnabled
			? (args.requestedReadPaths ?? [args.cwd]).map((entry) =>
					path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(args.cwd, entry),
				)
			: [],
		writePaths: writeEnabled
			? intersectPathScopes(
					args.settings.writePaths.map((entry) =>
						path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(args.cwd, entry),
					),
					(args.requestedWritePaths ?? args.settings.writePaths).map((entry) =>
						path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(args.cwd, entry),
					),
				)
			: [],
		deniedPaths: args.deniedPaths.map((entry) => path.resolve(entry)),
		readMemory,
		writeEnabled,
		processEnabled,
		budget,
	};
}

export function compileWorkerExecutionGrant(args: {
	target: { objectiveId: string; taskId: string; attemptId: string };
	profile: OrchestrationProfile;
	plan: WorkerExecutionPlan;
	resources: readonly ResourcePointer[];
}): { ok: true; grant: ExecutionGrant } | { ok: false; reasonCodes: readonly string[] } {
	const authorityCapabilities =
		args.plan.readMemory && !args.profile.capabilityCeiling.includes("memory.query")
			? [...args.profile.capabilityCeiling, "memory.query" as const]
			: args.profile.capabilityCeiling;
	const compiled = new ExecutionPolicyCompiler().compile({
		objectiveId: args.target.objectiveId,
		taskId: args.target.taskId,
		attemptId: args.target.attemptId,
		subjectId: `in-process:${args.target.attemptId}`,
		role: args.profile.role,
		requiredCapabilities: args.plan.requiredCapabilities,
		requestedCapabilities: args.plan.requiredCapabilities,
		authorityCapabilities,
		requestedTools: args.plan.toolManifests.map((manifest) => manifest.toolName),
		toolManifests: args.plan.toolManifests,
		resources: args.resources,
		readPaths: args.plan.readPaths,
		writePaths: args.plan.writePaths,
		deniedPaths: args.plan.deniedPaths,
		requestedBudget: args.plan.budget,
		authorityBudget: args.plan.budget,
		policyVersion: "worker-profile-v1",
	});
	if (compiled.outcome !== "allow") return { ok: false, reasonCodes: compiled.reasonCodes };
	return { ok: true, grant: compiled.grant };
}

/** Compile the host's durable authority record before an externally managed process is launched. */
export function compileManagedProcessExecutionGrant(args: {
	target: { objectiveId: string; taskId: string; attemptId: string };
	laneId: string;
	authorizationId: string;
	role: WorkerRole;
	allowedTools: readonly string[];
	writePaths: readonly string[];
	cwd: string;
	deniedPaths: readonly string[];
	budget: RiskBudget;
}): { ok: true; grant: ExecutionGrant } | { ok: false; reasonCodes: readonly string[] } {
	const manifests: ToolCapabilityManifest[] = [];
	const unknownTools: string[] = [];
	for (const toolName of [...new Set(args.allowedTools)]) {
		const policy = getToolCapabilityPolicy(toolName);
		const capability = policy?.capabilityCandidates[0];
		if (!policy || !capability) {
			unknownTools.push(toolName);
			continue;
		}
		manifests.push({
			toolName,
			moduleSpecifier: `managed-process:${toolName}`,
			capabilities: [capability],
			roles: [args.role],
			enforcements: [policy.enforcement],
		});
	}
	if (unknownTools.length > 0) return { ok: false, reasonCodes: unknownTools.map((name) => `unknown_tool:${name}`) };
	const capabilities = [...new Set(manifests.flatMap((manifest) => manifest.capabilities))];
	const readEnabled = capabilities.some(
		(capability) => capability === "filesystem.read" || capability === "worktree.read",
	);
	const compiled = new ExecutionPolicyCompiler().compile({
		...args.target,
		subjectId: `managed:${args.laneId}:${args.authorizationId}`,
		role: args.role,
		requiredCapabilities: capabilities,
		requestedCapabilities: capabilities,
		authorityCapabilities: capabilities,
		requestedTools: manifests.map((manifest) => manifest.toolName),
		toolManifests: manifests,
		readPaths: readEnabled ? [path.resolve(args.cwd)] : [],
		writePaths: args.writePaths.map((entry) =>
			path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(args.cwd, entry),
		),
		deniedPaths: args.deniedPaths.map((entry) => path.resolve(entry)),
		requestedBudget: args.budget,
		authorityBudget: args.budget,
		policyVersion: "managed-process-v1",
	});
	if (compiled.outcome !== "allow") return { ok: false, reasonCodes: compiled.reasonCodes };
	return { ok: true, grant: compiled.grant };
}
