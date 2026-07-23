import { randomUUID } from "node:crypto";
import {
	type ApprovalRequestContract,
	type CapabilityDecision,
	type ExecutionGrant,
	type HarnessCapability,
	ORCHESTRATION_SCHEMA_VERSION,
	type ResourcePointer,
	type RiskBudget,
	type ToolCapabilityManifest,
	type WorkerRole,
} from "./contracts.ts";
import { exceededRiskBudgetFields, intersectRiskBudgets, validateRiskBudget } from "./risk-budget.ts";

export const DEFAULT_ROLE_CAPABILITY_CEILINGS: Readonly<Record<WorkerRole, readonly HarnessCapability[]>> = {
	orchestrator: ["workflow.delegate"],
	planner: ["workflow.plan"],
	explorer: ["filesystem.read", "worktree.read", "network.http", "service.mcp", "memory.query"],
	implementer: ["filesystem.read", "filesystem.write", "worktree.read", "worktree.mutate", "memory.query"],
	operator: ["filesystem.read", "worktree.read", "process.exec", "tests.execute", "network.http", "service.mcp"],
	verifier: ["filesystem.read", "worktree.read", "process.exec", "tests.execute", "network.http", "service.mcp"],
	database: ["memory.query", "memory.mutate"],
};

export interface CompileExecutionGrantInput {
	objectiveId: string;
	taskId: string;
	attemptId: string;
	subjectId: string;
	role: WorkerRole;
	requiredCapabilities: readonly HarnessCapability[];
	requestedCapabilities?: readonly HarnessCapability[];
	authorityCapabilities: readonly HarnessCapability[];
	requestedTools: readonly string[];
	toolManifests: readonly ToolCapabilityManifest[];
	resources?: readonly ResourcePointer[];
	readPaths?: readonly string[];
	writePaths?: readonly string[];
	deniedPaths?: readonly string[];
	requestedBudget?: RiskBudget;
	authorityBudget?: RiskBudget;
	policyVersion: string;
	expiresAt?: string;
}

export type PolicyCompilationResult =
	| { outcome: "allow"; grant: ExecutionGrant; toolManifests: readonly ToolCapabilityManifest[] }
	| {
			outcome: "approval-required";
			approval: ApprovalRequestContract;
			decisions: readonly CapabilityDecision[];
			reasonCodes: readonly string[];
	  }
	| { outcome: "deny"; decisions: readonly CapabilityDecision[]; reasonCodes: readonly string[] };

export interface PolicyCompilerOptions {
	now?: () => string;
	createId?: () => string;
	roleCapabilityCeilings?: Readonly<Record<WorkerRole, readonly HarnessCapability[]>>;
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function freezeGrant(grant: ExecutionGrant): ExecutionGrant {
	for (const resource of grant.resources) {
		if (resource.metadata) Object.freeze(resource.metadata);
		Object.freeze(resource);
	}
	for (const decision of grant.decisionTrace) Object.freeze(decision);
	Object.freeze(grant.capabilities);
	Object.freeze(grant.allowedTools);
	Object.freeze(grant.resources);
	Object.freeze(grant.readPaths);
	Object.freeze(grant.writePaths);
	Object.freeze(grant.deniedPaths);
	Object.freeze(grant.budget);
	Object.freeze(grant.decisionTrace);
	return Object.freeze(grant);
}

const CAPABILITY_ENFORCEMENT = new Map<HarnessCapability, ToolCapabilityManifest["enforcements"][number]>([
	["filesystem.read", "path-scope"],
	["filesystem.write", "path-scope"],
	["worktree.read", "path-scope"],
	["worktree.mutate", "path-scope"],
	["process.exec", "process-launcher"],
	["tests.execute", "process-launcher"],
	["network.http", "service-proxy"],
	["service.mcp", "service-proxy"],
	["credentials.use", "service-proxy"],
	["memory.query", "memory-broker"],
	["memory.mutate", "memory-broker"],
	["workflow.plan", "control-plane"],
	["workflow.delegate", "control-plane"],
	["policy.modify", "control-plane"],
	["learning.propose", "control-plane"],
]);

export class ExecutionPolicyCompiler {
	private readonly now: () => string;
	private readonly createId: () => string;
	private readonly roleCapabilityCeilings: Readonly<Record<WorkerRole, readonly HarnessCapability[]>>;

	constructor(options: PolicyCompilerOptions = {}) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.createId = options.createId ?? randomUUID;
		this.roleCapabilityCeilings = options.roleCapabilityCeilings ?? DEFAULT_ROLE_CAPABILITY_CEILINGS;
	}

	compile(input: CompileExecutionGrantInput): PolicyCompilationResult {
		const required = unique(input.requiredCapabilities);
		const requested = unique([...(input.requestedCapabilities ?? required), ...required]);
		const authority = new Set(input.authorityCapabilities);
		const roleCeiling = new Set(this.roleCapabilityCeilings[input.role]);
		const decisions: CapabilityDecision[] = [];
		const roleDenied: HarnessCapability[] = [];
		const approvalCapabilities: HarnessCapability[] = [];
		const granted: HarnessCapability[] = [];

		for (const capability of requested) {
			if (!roleCeiling.has(capability)) {
				roleDenied.push(capability);
				decisions.push({ capability, outcome: "deny", reasonCode: "role_ceiling_denied", source: input.role });
				continue;
			}
			if (!authority.has(capability)) {
				approvalCapabilities.push(capability);
				decisions.push({
					capability,
					outcome: "deny",
					reasonCode: "owner_authority_required",
					source: "authority",
				});
				continue;
			}
			granted.push(capability);
			decisions.push({ capability, outcome: "allow", reasonCode: "role_and_authority_allowed", source: input.role });
		}

		if (roleDenied.some((capability) => required.includes(capability))) {
			return { outcome: "deny", decisions, reasonCodes: ["required_capability_exceeds_role_ceiling"] };
		}

		const requestedBudget = { ...(input.requestedBudget ?? {}) };
		const authorityBudget = { ...(input.authorityBudget ?? {}) };
		validateRiskBudget(requestedBudget, "requestedBudget");
		validateRiskBudget(authorityBudget, "authorityBudget");
		const exceededBudgetFields = exceededRiskBudgetFields(requestedBudget, authorityBudget);
		if (approvalCapabilities.some((capability) => required.includes(capability)) || exceededBudgetFields.length > 0) {
			const approval: ApprovalRequestContract = {
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				approvalId: `approval-${this.createId()}`,
				objectiveId: input.objectiveId,
				taskId: input.taskId,
				attemptId: input.attemptId,
				reasonCode:
					exceededBudgetFields.length > 0
						? "requested_budget_exceeds_authority"
						: "required_capability_needs_authority",
				summary:
					exceededBudgetFields.length > 0
						? `Requested budget exceeds authority for: ${exceededBudgetFields.join(", ")}.`
						: `Required capabilities need owner authority: ${approvalCapabilities.join(", ")}.`,
				requestedCapabilities: approvalCapabilities,
				...(Object.keys(requestedBudget).length > 0 ? { requestedBudget } : {}),
				reversible: true,
				createdAt: this.now(),
			};
			return {
				outcome: "approval-required",
				approval,
				decisions,
				reasonCodes: [approval.reasonCode],
			};
		}

		const manifestsByName = new Map(input.toolManifests.map((manifest) => [manifest.toolName, manifest]));
		const allowedManifests: ToolCapabilityManifest[] = [];
		const toolReasonCodes: string[] = [];
		for (const toolName of unique(input.requestedTools)) {
			const manifest = manifestsByName.get(toolName);
			if (!manifest) {
				toolReasonCodes.push(`unknown_tool:${toolName}`);
				continue;
			}
			if (!manifest.roles.includes(input.role)) {
				toolReasonCodes.push(`tool_role_denied:${toolName}`);
				continue;
			}
			if (!manifest.capabilities.every((capability) => granted.includes(capability))) {
				toolReasonCodes.push(`tool_capability_denied:${toolName}`);
				continue;
			}
			if (
				!manifest.capabilities.every((capability) => {
					const enforcement = CAPABILITY_ENFORCEMENT.get(capability);
					return enforcement !== undefined && manifest.enforcements.includes(enforcement);
				})
			) {
				toolReasonCodes.push(`tool_enforcement_missing:${toolName}`);
				continue;
			}
			allowedManifests.push(structuredClone(manifest));
		}

		if (toolReasonCodes.length > 0) {
			return { outcome: "deny", decisions, reasonCodes: toolReasonCodes };
		}

		const readPaths = unique(input.readPaths ?? []);
		const writePaths = unique(input.writePaths ?? []);
		const deniedPaths = unique(input.deniedPaths ?? []);
		if ((granted.includes("filesystem.read") || granted.includes("worktree.read")) && readPaths.length === 0) {
			return { outcome: "deny", decisions, reasonCodes: ["read_capability_missing_positive_path_scope"] };
		}
		if ((granted.includes("filesystem.write") || granted.includes("worktree.mutate")) && writePaths.length === 0) {
			return { outcome: "deny", decisions, reasonCodes: ["write_capability_missing_positive_path_scope"] };
		}

		const grant = freezeGrant({
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			grantId: `grant-${this.createId()}`,
			objectiveId: input.objectiveId,
			taskId: input.taskId,
			attemptId: input.attemptId,
			subjectId: input.subjectId,
			role: input.role,
			capabilities: granted,
			allowedTools: allowedManifests.map((manifest) => manifest.toolName),
			resources: structuredClone(input.resources ?? []),
			readPaths,
			writePaths,
			deniedPaths,
			budget: intersectRiskBudgets(requestedBudget, authorityBudget),
			policyVersion: input.policyVersion,
			decisionTrace: decisions,
			issuedAt: this.now(),
			...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
		});
		return { outcome: "allow", grant, toolManifests: allowedManifests };
	}
}
