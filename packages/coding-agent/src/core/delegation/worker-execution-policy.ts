import { join } from "node:path";
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
import { getToolCapabilityPolicy, requiredEnvelopeCapabilities } from "../tool-capability-policy.ts";
import { resolveWorkerWorkspacePath, workerMachinePathRoots } from "./worker-machine-scope.ts";

const READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const WRITE_TOOL_NAMES = ["write", "edit"] as const;

function delegatedToolCapabilities(toolName: string): readonly HarnessCapability[] {
	return toolName === "memory" ? ["memory.query"] : requiredEnvelopeCapabilities(toolName);
}

export interface WorkerExecutionPlan {
	/** Actual process and relative-tool working directory fixed at admission. */
	cwd: string;
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
	return [...new Set(intersections.map((entry) => resolveWorkerWorkspacePath(entry, entry)))];
}

export function workerExecutionAuthorityFromPlan(plan: WorkerExecutionPlan): WorkerExecutionAuthorityContract {
	return {
		cwd: plan.cwd,
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
		cwd: admitted.cwd ?? current.cwd,
		toolManifests,
		requiredCapabilities,
		readPaths: readEnabled ? intersectPathScopes(admitted.readPaths, current.readPaths) : [],
		writePaths: writeEnabled ? intersectPathScopes(admitted.writePaths, current.writePaths) : [],
		deniedPaths: [
			...new Set(
				[...admitted.deniedPaths, ...current.deniedPaths].map((entry) =>
					resolveWorkerWorkspacePath(current.cwd, entry),
				),
			),
		],
		readMemory: grantedTools.has("memory"),
		writeEnabled,
		processEnabled:
			grantedTools.has("python") ||
			grantedTools.has("run_process") ||
			grantedTools.has(STABLE_SHELL_TOOL_NAME) ||
			grantedTools.has("run_toolkit_script"),
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
	workerToolAdapterNames?: readonly string[];
}): WorkerExecutionPlan {
	const parentCwd = resolveWorkerWorkspacePath(args.cwd, args.cwd);
	const cwd = args.profile.workspacePath
		? resolveWorkerWorkspacePath(parentCwd, args.profile.workspacePath)
		: parentCwd;
	const pathScopes = args.profile.workspacePath ? [cwd] : workerMachinePathRoots(cwd);
	const profileToolNames = new Set(mapToolNamesForPlatform(args.profile.toolNames));
	const grantsRead =
		args.profile.capabilityCeiling.includes("filesystem.read") ||
		args.profile.capabilityCeiling.includes("worktree.read");
	const writeEligible =
		args.settings.writeEnabled &&
		(args.profile.capabilityCeiling.includes("filesystem.write") ||
			args.profile.capabilityCeiling.includes("worktree.mutate"));
	const memoryEligible = args.memoryEnabled && profileToolNames.has("memory");
	const processEligible =
		args.profile.capabilityCeiling.includes("process.exec") ||
		args.profile.capabilityCeiling.includes("tests.execute");
	const enabledProcessToolNames = processEligible
		? [
				...(profileToolNames.has("python") ? (["python"] as const) : []),
				...(args.profile.executionPolicy && profileToolNames.has("run_process") ? (["run_process"] as const) : []),
				...(profileToolNames.has(STABLE_SHELL_TOOL_NAME) ? [STABLE_SHELL_TOOL_NAME] : []),
			]
		: [];
	const enabledAdapterToolNames = (args.workerToolAdapterNames ?? []).filter((name) => profileToolNames.has(name));
	const enabledToolNames = [
		...(grantsRead ? READ_TOOL_NAMES : []),
		...(writeEligible ? WRITE_TOOL_NAMES : []),
		...enabledProcessToolNames,
		...enabledAdapterToolNames,
	];
	const toolManifests = buildLaneToolManifests(args.profile, enabledToolNames);
	if (memoryEligible) {
		toolManifests.push({
			toolName: "memory",
			moduleSpecifier: "../tools/memory.ts",
			capabilities: delegatedToolCapabilities("memory"),
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
	const processEnabled =
		grantedTools.has("python") ||
		grantedTools.has("run_process") ||
		grantedTools.has(STABLE_SHELL_TOOL_NAME) ||
		grantedTools.has("run_toolkit_script");
	const budget = intersectRiskBudgets(
		args.profile.budget,
		...(args.settings.maxUsd > 0 ? [{ maxCostUsd: args.settings.maxUsd }] : []),
		...(args.foregroundMaxCostUsd !== undefined ? [{ maxCostUsd: args.foregroundMaxCostUsd }] : []),
		...(args.settings.maxWallClockMs > 0 ? [{ maxWallClockMs: args.settings.maxWallClockMs }] : []),
	);
	return {
		cwd,
		toolManifests,
		requiredCapabilities: [...new Set(toolManifests.flatMap((manifest) => manifest.capabilities))],
		readPaths: readEnabled ? pathScopes : [],
		writePaths: writeEnabled ? pathScopes : [],
		deniedPaths: [
			...new Set(
				[...args.deniedPaths, join(cwd, ".pi", "settings.json")].map((entry) =>
					resolveWorkerWorkspacePath(cwd, entry),
				),
			),
		],
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
		const capabilities = delegatedToolCapabilities(toolName);
		if (!policy || capabilities.length === 0) {
			unknownTools.push(toolName);
			continue;
		}
		manifests.push({
			toolName,
			moduleSpecifier: `managed-process:${toolName}`,
			capabilities,
			roles: [args.role],
			enforcements: policy.enforcements,
		});
	}
	if (unknownTools.length > 0) return { ok: false, reasonCodes: unknownTools.map((name) => `unknown_tool:${name}`) };
	const capabilities = [...new Set(manifests.flatMap((manifest) => manifest.capabilities))];
	const readEnabled = capabilities.some(
		(capability) => capability === "filesystem.read" || capability === "worktree.read",
	);
	const writeEnabled = capabilities.some(
		(capability) => capability === "filesystem.write" || capability === "worktree.mutate",
	);
	const cwd = resolveWorkerWorkspacePath(args.cwd, args.cwd);
	const explicitScopes = args.writePaths.map((entry) => resolveWorkerWorkspacePath(cwd, entry));
	const pathScopes = explicitScopes.length > 0 ? explicitScopes : workerMachinePathRoots(cwd);
	const compiled = new ExecutionPolicyCompiler().compile({
		...args.target,
		subjectId: `managed:${args.laneId}:${args.authorizationId}`,
		role: args.role,
		requiredCapabilities: capabilities,
		requestedCapabilities: capabilities,
		authorityCapabilities: capabilities,
		requestedTools: manifests.map((manifest) => manifest.toolName),
		toolManifests: manifests,
		readPaths: readEnabled ? pathScopes : [],
		writePaths: writeEnabled ? pathScopes : [],
		deniedPaths: args.deniedPaths.map((entry) => resolveWorkerWorkspacePath(cwd, entry)),
		requestedBudget: args.budget,
		authorityBudget: args.budget,
		policyVersion: "managed-process-v1",
	});
	if (compiled.outcome !== "allow") return { ok: false, reasonCodes: compiled.reasonCodes };
	return { ok: true, grant: compiled.grant };
}
