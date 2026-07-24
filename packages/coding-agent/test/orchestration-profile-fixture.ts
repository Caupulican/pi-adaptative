import type { Api, Model } from "@caupulican/pi-ai";
import {
	type ExecutionGrant,
	type HarnessCapability,
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
	type OrchestrationThinkingLevel,
	type WorkerExecutionAuthorityContract,
	type WorkerRole,
} from "../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../src/core/orchestration/profile-store.ts";

export function createTestWorkerOrchestrationProfile(args: {
	profileId: string;
	model: Pick<Model<Api>, "provider" | "id"> & Partial<Pick<Model<Api>, "maxTokens">>;
	thinkingLevel?: OrchestrationThinkingLevel;
	capabilityCeiling?: readonly HarnessCapability[];
	toolNames?: readonly string[];
	resourceProfileNames?: readonly string[];
	maxConcurrent?: number;
	role?: WorkerRole;
	requireIndependentVerification?: boolean;
	verificationProfileId?: string;
}): OrchestrationProfile {
	const now = new Date().toISOString();
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: args.profileId,
		description: `Pinned ${args.model.id} test worker`,
		role: args.role ?? "implementer",
		modelPolicy: {
			mode: "fixed",
			candidates: [
				{
					provider: args.model.provider,
					modelId: args.model.id,
					thinkingLevel: args.thinkingLevel ?? "off",
				},
			],
		},
		capabilityCeiling: args.capabilityCeiling ?? ["filesystem.read"],
		toolNames: args.toolNames ?? ["read"],
		resourceProfileNames: args.resourceProfileNames ?? [],
		dispatchProfileIds: [],
		budget: {
			maxCostUsd: 1,
			...(args.model.maxTokens !== undefined ? { maxTokens: args.model.maxTokens } : {}),
			maxToolCalls: 20,
			maxWallClockMs: 60_000,
		},
		maxConcurrent: args.maxConcurrent ?? 1,
		leaseTtlMs: 90_000,
		requireIndependentVerification: args.requireIndependentVerification ?? false,
		...(args.verificationProfileId ? { verificationProfileId: args.verificationProfileId } : {}),
		createdAt: now,
		updatedAt: now,
	};
}

export function createTestWorkerExecutionAuthority(
	profile: OrchestrationProfile,
	rootPath = "/repo",
): WorkerExecutionAuthorityContract {
	return {
		capabilities: [...profile.capabilityCeiling],
		toolNames: [...profile.toolNames],
		readPaths: profile.capabilityCeiling.some(
			(capability) => capability === "filesystem.read" || capability === "worktree.read",
		)
			? [rootPath]
			: [],
		writePaths: profile.capabilityCeiling.some(
			(capability) => capability === "filesystem.write" || capability === "worktree.mutate",
		)
			? [rootPath]
			: [],
		deniedPaths: [],
		budget: { ...profile.budget },
	};
}

export function createTestExecutionGrant(args: {
	objectiveId: string;
	taskId: string;
	attemptId: string;
	role?: WorkerRole;
	grantId?: string;
}): ExecutionGrant {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		grantId: args.grantId ?? `grant-${args.attemptId}`,
		objectiveId: args.objectiveId,
		taskId: args.taskId,
		attemptId: args.attemptId,
		subjectId: `test:${args.attemptId}`,
		role: args.role ?? "implementer",
		capabilities: [],
		allowedTools: [],
		resources: [],
		readPaths: [],
		writePaths: [],
		deniedPaths: [],
		budget: {},
		policyVersion: "test-v1",
		decisionTrace: [],
		issuedAt: new Date().toISOString(),
	};
}

export function saveTestWorkerOrchestrationProfile(args: {
	agentDir: string;
	cwd: string;
	profile: OrchestrationProfile;
}): void {
	new OrchestrationProfileStore({ agentDir: args.agentDir, cwd: args.cwd, projectTrusted: true }).save(
		args.profile,
		"global",
		{ overwrite: true },
	);
}
