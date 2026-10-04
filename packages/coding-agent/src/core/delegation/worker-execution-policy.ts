import { join } from "node:path";
import { TOOL_SCHEMA_SEARCH_NAME } from "@caupulican/pi-ai";
import { isPathWithinScope } from "../autonomy/path-scope.ts";
import { HARNESS_CAPABILITIES } from "../capability-contract.ts";
import { mapToolNamesForPlatform, STABLE_SHELL_TOOL_NAME } from "../default-tool-surface.ts";
import { WORKER_MEMORY_READ_TOOL_NAME, WORKER_ROOT_MEMORY_TOOL_NAMES } from "../memory/worker-memory-tools.ts";
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
import {
	getToolCapabilityPolicy,
	requiredEnvelopeCapabilities,
	toolSurvivesReadOnly,
} from "../tool-capability-policy.ts";
import { isWorkerProcessToolAllowed } from "../worker-tool-ceiling.ts";
import { resolveWorkerWorkspacePath, workerMachinePathRoots } from "./worker-machine-scope.ts";

const READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const REPO_READ_TOOL_NAME = "repo_read";
const WRITE_TOOL_NAMES = ["write", "edit"] as const;

/** The YOLO lane still excludes root-only control-plane capabilities. */
export const YOLO_WORKER_CAPABILITIES = HARNESS_CAPABILITIES.filter(
	(capability) => capability !== "workflow.delegate" && capability !== "memory.mutate",
);

/** Capabilities that let a lane change files. */
function isWriteCapability(capability: HarnessCapability): boolean {
	return capability === "filesystem.write" || capability === "worktree.mutate";
}

/** Capabilities that put a lane's read paths in play (repo.read reads the repository under them). */
function isReadPathCapability(capability: HarnessCapability): boolean {
	return capability === "filesystem.read" || capability === "worktree.read" || capability === "repo.read";
}

function delegatedToolCapabilities(toolName: string): readonly HarnessCapability[] {
	return requiredEnvelopeCapabilities(toolName);
}

export interface WorkerExecutionPlan {
	/** Actual process and relative-tool working directory fixed at admission. */
	cwd: string;
	toolManifests: readonly ToolCapabilityManifest[];
	requiredCapabilities: readonly HarnessCapability[];
	readPaths: readonly string[];
	writePaths: readonly string[];
	/**
	 * The subset of `writePaths` that fences other lanes. Absent means all of `writePaths`. The default
	 * scope (the worker's own cwd with no explicit workspace or grant) is deliberately unreserved: reserving
	 * it would serialize every default worker sharing a repository.
	 */
	writeReservationPaths?: readonly string[];
	deniedPaths: readonly string[];
	readMemory: boolean;
	writeEnabled: boolean;
	processEnabled: boolean;
	/** A `readOnly` grant: the lane keeps only tools that edit nothing, in every mode, whether or not it has a shell. */
	readOnly: boolean;
	/** A `readOnly` grant: the lane's shell may run only commands that edit nothing that exists. */
	shellReadOnly: boolean;
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
			!WORKER_ROOT_MEMORY_TOOL_NAMES.has(manifest.toolName) &&
			admittedTools.has(manifest.toolName) &&
			manifest.capabilities.every((capability) => admittedCapabilities.has(capability)),
	);
	const requiredCapabilities = [...new Set(toolManifests.flatMap((manifest) => manifest.capabilities))];
	const grantedTools = new Set(toolManifests.map((manifest) => manifest.toolName));
	const readEnabled = requiredCapabilities.some(isReadPathCapability);
	const writeEnabled = grantedTools.has("write") || grantedTools.has("edit");
	return {
		cwd: admitted.cwd ?? current.cwd,
		toolManifests,
		requiredCapabilities,
		readPaths: readEnabled ? intersectPathScopes(admitted.readPaths, current.readPaths) : [],
		writePaths: writeEnabled ? intersectPathScopes(admitted.writePaths, current.writePaths) : [],
		...(current.writeReservationPaths
			? {
					writeReservationPaths: writeEnabled
						? intersectPathScopes(admitted.writePaths, current.writeReservationPaths)
						: [],
				}
			: {}),
		deniedPaths: [
			...new Set(
				[...admitted.deniedPaths, ...current.deniedPaths].map((entry) =>
					resolveWorkerWorkspacePath(current.cwd, entry),
				),
			),
		],
		readMemory: grantedTools.has(WORKER_MEMORY_READ_TOOL_NAME),
		writeEnabled,
		processEnabled:
			grantedTools.has("python") ||
			grantedTools.has("run_process") ||
			grantedTools.has(STABLE_SHELL_TOOL_NAME) ||
			grantedTools.has("run_toolkit_script"),
		readOnly: current.readOnly,
		shellReadOnly: current.shellReadOnly,
		budget: intersectRiskBudgets(admitted.budget, current.budget),
	};
}

export function buildWorkerExecutionPlan(args: {
	yolo?: boolean;
	profile: OrchestrationProfile;
	settings: ResolvedWorkerDelegationSettings;
	cwd: string;
	deniedPaths: readonly string[];
	/** Fresh caller task cwd. Does not re-anchor profile paths or change an admitted grant. */
	executionCwd?: string;
	foregroundMaxCostUsd?: number;
	memoryEnabled: boolean;
	workerToolAdapterNames?: readonly string[];
}): WorkerExecutionPlan {
	const parentCwd = resolveWorkerWorkspacePath(args.cwd, args.cwd);
	const cwd = args.profile.workspacePath
		? resolveWorkerWorkspacePath(parentCwd, args.profile.workspacePath)
		: resolveWorkerWorkspacePath(parentCwd, args.executionCwd ?? parentCwd);
	// Reads keep the host's machine scope unless an explicit workspace focuses them. Writes never default to
	// the machine: a worker writes inside its own cwd, plus only the extra roots the root's grant names.
	const readScopes = args.yolo || !args.profile.workspacePath ? workerMachinePathRoots(parentCwd) : [cwd];
	const grantedWriteRoots = (args.profile.writePaths ?? []).map((entry) => resolveWorkerWorkspacePath(cwd, entry));
	const writeScopes = [...new Set([cwd, ...grantedWriteRoots])];
	// Only an explicit workspace or granted root fences other lanes; the bare cwd default does not.
	const writeReservationScopes = args.profile.workspacePath ? writeScopes : grantedWriteRoots;
	// A readOnly grant stays read-only in YOLO too: YOLO removes permission prompts, not the parent's
	// promise that this worker edits nothing.
	const readOnly = args.profile.readOnly === true;
	const profileToolNames = new Set(
		mapToolNamesForPlatform(args.profile.toolNames).filter((name) => !WORKER_ROOT_MEMORY_TOOL_NAMES.has(name)),
	);
	if (args.yolo)
		for (const name of [
			...READ_TOOL_NAMES,
			REPO_READ_TOOL_NAME,
			TOOL_SCHEMA_SEARCH_NAME,
			...(readOnly ? [] : [...WRITE_TOOL_NAMES, "python"]),
			STABLE_SHELL_TOOL_NAME,
		])
			profileToolNames.add(name);
	const grantsRead =
		args.yolo ||
		args.profile.capabilityCeiling.includes("filesystem.read") ||
		args.profile.capabilityCeiling.includes("worktree.read");
	const grantsRepoRead = args.yolo || args.profile.capabilityCeiling.includes("repo.read");
	const writeEligible = args.yolo
		? !readOnly
		: args.settings.writeEnabled && args.profile.capabilityCeiling.some(isWriteCapability);
	const memoryEligible =
		args.memoryEnabled &&
		profileToolNames.has(WORKER_MEMORY_READ_TOOL_NAME) &&
		args.profile.capabilityCeiling.includes("memory.query");
	const processEligible =
		args.yolo ||
		args.profile.capabilityCeiling.includes("process.exec") ||
		args.profile.capabilityCeiling.includes("tests.execute");
	const enabledProcessToolNames = processEligible
		? [
				...(profileToolNames.has("python") ? (["python"] as const) : []),
				...(args.profile.executionPolicy && profileToolNames.has("run_process") ? (["run_process"] as const) : []),
				...(profileToolNames.has(STABLE_SHELL_TOOL_NAME) ? [STABLE_SHELL_TOOL_NAME] : []),
			].filter((name) => !readOnly || toolSurvivesReadOnly(name))
		: [];
	const enabledAdapterToolNames = (args.workerToolAdapterNames ?? []).filter(
		(name) => (args.yolo || profileToolNames.has(name)) && (!readOnly || toolSurvivesReadOnly(name)),
	);
	const enabledZeroAuthorityToolNames = profileToolNames.has(TOOL_SCHEMA_SEARCH_NAME) ? [TOOL_SCHEMA_SEARCH_NAME] : [];
	const enabledToolNames = [
		...(grantsRead ? READ_TOOL_NAMES : []),
		...(grantsRepoRead ? [REPO_READ_TOOL_NAME] : []),
		...(writeEligible ? WRITE_TOOL_NAMES : []),
		...(memoryEligible ? [WORKER_MEMORY_READ_TOOL_NAME] : []),
		...enabledZeroAuthorityToolNames,
		...enabledProcessToolNames,
		...enabledAdapterToolNames,
	];
	const toolManifests = buildLaneToolManifests(
		args.yolo
			? {
					...args.profile,
					toolNames: [...new Set([...args.profile.toolNames, ...enabledToolNames])],
					capabilityCeiling: readOnly
						? YOLO_WORKER_CAPABILITIES.filter((capability) => !isWriteCapability(capability))
						: YOLO_WORKER_CAPABILITIES,
				}
			: args.profile,
		enabledToolNames,
	);
	const grantedTools = new Set(toolManifests.map((manifest) => manifest.toolName));
	const readEnabled = toolManifests.some((manifest) => manifest.capabilities.some(isReadPathCapability));
	const writeEnabled = grantedTools.has("write") || grantedTools.has("edit");
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
		readPaths: readEnabled ? readScopes : [],
		writePaths: writeEnabled ? writeScopes : [],
		writeReservationPaths: writeEnabled ? writeReservationScopes : [],
		// Private harness state (credentials, sessions) stays denied in YOLO; only the project settings
		// file, which guarded mode protects as settings authority, opens up.
		deniedPaths: [
			...new Set(
				[...args.deniedPaths, ...(args.yolo ? [] : [join(cwd, ".pi", "settings.json")])].map((entry) =>
					resolveWorkerWorkspacePath(cwd, entry),
				),
			),
		],
		readMemory: memoryEligible && grantedTools.has(WORKER_MEMORY_READ_TOOL_NAME),
		writeEnabled,
		processEnabled,
		readOnly,
		shellReadOnly: processEnabled && readOnly,
		budget,
	};
}

export function compileWorkerExecutionGrant(args: {
	yolo?: boolean;
	target: { objectiveId: string; taskId: string; attemptId: string };
	profile: OrchestrationProfile;
	plan: WorkerExecutionPlan;
	resources: readonly ResourcePointer[];
}): { ok: true; grant: ExecutionGrant } | { ok: false; reasonCodes: readonly string[] } {
	const compiled = new ExecutionPolicyCompiler().compile({
		objectiveId: args.target.objectiveId,
		taskId: args.target.taskId,
		attemptId: args.target.attemptId,
		subjectId: `in-process:${args.target.attemptId}`,
		role: args.profile.role,
		requiredCapabilities: args.plan.requiredCapabilities,
		requestedCapabilities: args.plan.requiredCapabilities,
		authorityCapabilities: args.yolo ? args.plan.requiredCapabilities : args.profile.capabilityCeiling,
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
		if (!isWorkerProcessToolAllowed(toolName)) {
			unknownTools.push(toolName);
			continue;
		}
		const policy = getToolCapabilityPolicy(toolName);
		const capabilities = delegatedToolCapabilities(toolName);
		// A zero-authority tool (tool_search) is classified with no capability clauses; only an
		// unclassified tool is unknown.
		if (!policy) {
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
	const readEnabled = capabilities.some(isReadPathCapability);
	const writeEnabled = capabilities.some(
		(capability) => capability === "filesystem.write" || capability === "worktree.mutate",
	);
	const cwd = resolveWorkerWorkspacePath(args.cwd, args.cwd);
	const explicitScopes = args.writePaths.map((entry) => resolveWorkerWorkspacePath(cwd, entry));
	// Reads default to the machine scope; writes default to the worker's cwd. Widening a write root is
	// an explicit grant: the dispatch names it in `writePaths`.
	const readScopes = explicitScopes.length > 0 ? explicitScopes : workerMachinePathRoots(cwd);
	const writeScopes = explicitScopes.length > 0 ? explicitScopes : [cwd];
	const compiled = new ExecutionPolicyCompiler().compile({
		...args.target,
		subjectId: `managed:${args.laneId}:${args.authorizationId}`,
		role: args.role,
		requiredCapabilities: capabilities,
		requestedCapabilities: capabilities,
		authorityCapabilities: capabilities,
		requestedTools: manifests.map((manifest) => manifest.toolName),
		toolManifests: manifests,
		readPaths: readEnabled ? readScopes : [],
		writePaths: writeEnabled ? writeScopes : [],
		deniedPaths: args.deniedPaths.map((entry) => resolveWorkerWorkspacePath(cwd, entry)),
		requestedBudget: args.budget,
		authorityBudget: args.budget,
		policyVersion: "managed-process-v1",
	});
	if (compiled.outcome !== "allow") return { ok: false, reasonCodes: compiled.reasonCodes };
	return { ok: true, grant: compiled.grant };
}
