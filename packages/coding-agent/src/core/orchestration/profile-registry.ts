import type {
	ExecutionGrant,
	OrchestrationDispatchRequest,
	OrchestrationModelBinding,
	OrchestrationProfile,
	ResourcePointer,
	TaskContract,
	ToolCapabilityManifest,
} from "./contracts.ts";
import { HARNESS_CAPABILITIES, ORCHESTRATION_SCHEMA_VERSION, toJsonObject, WORKER_ROLES } from "./contracts.ts";
import { ORCHESTRATION_PROFILE_TOOL_NAMES } from "./lane-tool-manifests.ts";
import {
	type CompileExecutionGrantInput,
	DEFAULT_ROLE_CAPABILITY_CEILINGS,
	type ExecutionPolicyCompiler,
	type PolicyCompilationResult,
} from "./policy-compiler.ts";
import { RISK_BUDGET_FIELDS, validateRiskBudget } from "./risk-budget.ts";

export interface ModelHealthView {
	isHealthy(binding: OrchestrationModelBinding): boolean;
}

export interface ProfileDispatchPlan {
	profile: OrchestrationProfile;
	model: OrchestrationModelBinding;
	grant: ExecutionGrant;
	toolManifests: readonly ToolCapabilityManifest[];
}

export type ProfileDispatchPlanResult =
	| { outcome: "allow"; plan: ProfileDispatchPlan }
	| Exclude<PolicyCompilationResult, { outcome: "allow" }>
	| { outcome: "deny"; decisions: readonly []; reasonCodes: readonly ["profile_model_unavailable"] };

export class OrchestrationProfileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrchestrationProfileError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedSet = new Set(allowed);
	return Object.keys(record).every((key) => allowedSet.has(key));
}

function duplicateStrings(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) duplicates.add(value);
		seen.add(value);
	}
	return [...duplicates];
}

export function parseOrchestrationDispatchRequest(value: unknown): OrchestrationDispatchRequest {
	if (!isRecord(value)) throw new OrchestrationProfileError("Dispatch request must be an object.");
	if (!exactKeys(value, ["taskId", "profileId", "instructions", "resourcePointerIds"])) {
		throw new OrchestrationProfileError(
			"Dispatch request contains an unsupported field. Model and thinking overrides are forbidden; select a profileId.",
		);
	}
	if (
		typeof value.taskId !== "string" ||
		!value.taskId ||
		typeof value.profileId !== "string" ||
		!value.profileId ||
		typeof value.instructions !== "string" ||
		!value.instructions.trim() ||
		!Array.isArray(value.resourcePointerIds) ||
		!value.resourcePointerIds.every((entry) => typeof entry === "string")
	) {
		throw new OrchestrationProfileError("Dispatch request is invalid.");
	}
	return {
		taskId: value.taskId,
		profileId: value.profileId,
		instructions: value.instructions.trim(),
		resourcePointerIds: [...value.resourcePointerIds],
	};
}

export function validateOrchestrationProfile(profile: OrchestrationProfile): void {
	if (profile.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION) {
		throw new OrchestrationProfileError(`Profile '${profile.profileId}' has an unsupported schema version.`);
	}
	if (!profile.profileId.trim() || !profile.description.trim())
		throw new OrchestrationProfileError("Profile id and description are required.");
	if (profile.role !== "orchestrator" && profile.dispatchProfileIds.length > 0) {
		throw new OrchestrationProfileError(
			`Only orchestrator profiles may declare dispatchProfileIds ('${profile.profileId}').`,
		);
	}
	if (profile.dispatchProfileIds.includes(profile.profileId)) {
		throw new OrchestrationProfileError(`Profile '${profile.profileId}' cannot dispatch itself.`);
	}
	if (profile.requireIndependentVerification) {
		if (profile.role === "verifier") {
			throw new OrchestrationProfileError(
				`Verifier profile '${profile.profileId}' cannot require another verifier.`,
			);
		}
		if (!profile.verificationProfileId?.trim()) {
			throw new OrchestrationProfileError(
				`Profile '${profile.profileId}' requires independent verification but has no verificationProfileId.`,
			);
		}
	} else if (profile.verificationProfileId !== undefined) {
		throw new OrchestrationProfileError(
			`Profile '${profile.profileId}' cannot declare verificationProfileId without requiring verification.`,
		);
	}
	if (profile.verificationProfileId === profile.profileId) {
		throw new OrchestrationProfileError(`Profile '${profile.profileId}' cannot verify itself.`);
	}
	for (const [label, values] of [
		["capabilityCeiling", profile.capabilityCeiling],
		["toolNames", profile.toolNames],
		["resourceProfileNames", profile.resourceProfileNames],
		["dispatchProfileIds", profile.dispatchProfileIds],
	] as const) {
		const duplicates = duplicateStrings(values);
		if (duplicates.length > 0) {
			throw new OrchestrationProfileError(
				`Profile '${profile.profileId}' contains duplicate ${label}: ${duplicates.join(", ")}.`,
			);
		}
	}
	const duplicateModels = duplicateStrings(
		profile.modelPolicy.candidates.map((candidate) => `${candidate.provider}/${candidate.modelId}`),
	);
	if (duplicateModels.length > 0) {
		throw new OrchestrationProfileError(
			`Profile '${profile.profileId}' contains duplicate model candidates: ${duplicateModels.join(", ")}.`,
		);
	}
	const roleCeiling = new Set(DEFAULT_ROLE_CAPABILITY_CEILINGS[profile.role]);
	const outOfRoleCapabilities = profile.capabilityCeiling.filter((capability) => !roleCeiling.has(capability));
	if (outOfRoleCapabilities.length > 0) {
		throw new OrchestrationProfileError(
			`Profile '${profile.profileId}' exceeds the ${profile.role} role ceiling: ${outOfRoleCapabilities.join(", ")}.`,
		);
	}
	if (profile.modelPolicy.candidates.length === 0) {
		throw new OrchestrationProfileError(`Profile '${profile.profileId}' must declare a model candidate.`);
	}
	if (profile.modelPolicy.mode === "fixed" && profile.modelPolicy.candidates.length !== 1) {
		throw new OrchestrationProfileError(
			`Fixed profile '${profile.profileId}' must declare exactly one model candidate.`,
		);
	}
	for (const candidate of profile.modelPolicy.candidates) {
		if (!candidate.provider.trim() || !candidate.modelId.trim()) {
			throw new OrchestrationProfileError(`Profile '${profile.profileId}' contains an invalid model binding.`);
		}
	}
	if (!Number.isSafeInteger(profile.maxConcurrent) || profile.maxConcurrent <= 0) {
		throw new OrchestrationProfileError(`Profile '${profile.profileId}' maxConcurrent must be positive.`);
	}
	if (!Number.isSafeInteger(profile.leaseTtlMs) || profile.leaseTtlMs <= 0) {
		throw new OrchestrationProfileError(`Profile '${profile.profileId}' leaseTtlMs must be positive.`);
	}
	try {
		validateRiskBudget(profile.budget, `Profile '${profile.profileId}' budget`);
	} catch (error) {
		throw new OrchestrationProfileError(error instanceof Error ? error.message : String(error));
	}
	if (profile.budget.maxWallClockMs !== undefined && profile.budget.maxWallClockMs <= 0) {
		throw new OrchestrationProfileError(
			`Profile '${profile.profileId}' maxWallClockMs budget must be positive when specified.`,
		);
	}
	if (profile.budget.maxWallClockMs !== undefined && profile.leaseTtlMs < profile.budget.maxWallClockMs) {
		throw new OrchestrationProfileError(
			`Profile '${profile.profileId}' leaseTtlMs must cover its maxWallClockMs budget.`,
		);
	}
	const processCapable =
		profile.capabilityCeiling.includes("process.exec") || profile.capabilityCeiling.includes("tests.execute");
	if (processCapable && (!profile.executionPolicy || profile.executionPolicy.allowedExecutables.length === 0)) {
		throw new OrchestrationProfileError(
			`Profile '${profile.profileId}' must declare executionPolicy.allowedExecutables for process capabilities.`,
		);
	}
	if (!processCapable && profile.executionPolicy) {
		throw new OrchestrationProfileError(
			`Profile '${profile.profileId}' cannot declare executionPolicy without process capabilities.`,
		);
	}
	if (profile.executionPolicy) {
		if (
			profile.executionPolicy.allowedExecutables.some(
				(executable) => !executable.trim() || /[\0\r\n]/.test(executable),
			) ||
			profile.executionPolicy.allowedEnvironmentVariables.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
			!Number.isSafeInteger(profile.executionPolicy.maxOutputBytes) ||
			profile.executionPolicy.maxOutputBytes <= 0
		) {
			throw new OrchestrationProfileError(`Profile '${profile.profileId}' executionPolicy is invalid.`);
		}
	}
	const unrestrictedProcessTools = profile.toolNames.filter((toolName) =>
		["bash", "python", "powershell", "run_toolkit_script"].includes(toolName),
	);
	if (unrestrictedProcessTools.length > 0) {
		throw new OrchestrationProfileError(
			`Profile '${profile.profileId}' cannot expose unrestricted process tools (${unrestrictedProcessTools.join(", ")}); use run_process with executionPolicy.`,
		);
	}
	const unknownTools = profile.toolNames.filter(
		(toolName) => !(ORCHESTRATION_PROFILE_TOOL_NAMES as readonly string[]).includes(toolName),
	);
	if (unknownTools.length > 0) {
		throw new OrchestrationProfileError(
			`Profile '${profile.profileId}' contains unclassified orchestration tools: ${unknownTools.join(", ")}.`,
		);
	}
	for (const toolName of profile.toolNames) {
		if (
			["read", "grep", "find", "ls"].includes(toolName) &&
			!profile.capabilityCeiling.includes("filesystem.read") &&
			!profile.capabilityCeiling.includes("worktree.read")
		) {
			throw new OrchestrationProfileError(`Profile '${profile.profileId}' tool '${toolName}' lacks read authority.`);
		}
		if (
			["write", "edit"].includes(toolName) &&
			!profile.capabilityCeiling.includes("filesystem.write") &&
			!profile.capabilityCeiling.includes("worktree.mutate")
		) {
			throw new OrchestrationProfileError(
				`Profile '${profile.profileId}' tool '${toolName}' lacks write authority.`,
			);
		}
		if (
			toolName === "run_process" &&
			!profile.capabilityCeiling.includes("process.exec") &&
			!profile.capabilityCeiling.includes("tests.execute")
		) {
			throw new OrchestrationProfileError(
				`Profile '${profile.profileId}' tool '${toolName}' lacks process authority.`,
			);
		}
		if (
			toolName === "memory" &&
			!profile.capabilityCeiling.includes("memory.query") &&
			!profile.capabilityCeiling.includes("memory.mutate")
		) {
			throw new OrchestrationProfileError(
				`Profile '${profile.profileId}' tool '${toolName}' lacks memory authority.`,
			);
		}
		if (
			(toolName === "delegate" || toolName === "delegate_status") &&
			!profile.capabilityCeiling.includes("workflow.delegate")
		) {
			throw new OrchestrationProfileError(
				`Profile '${profile.profileId}' tool '${toolName}' lacks delegation authority.`,
			);
		}
	}
	toJsonObject({ profile });
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function parseOrchestrationProfile(value: unknown, sourcePath?: string): OrchestrationProfile {
	if (!isRecord(value)) throw new OrchestrationProfileError("Orchestration profile must be an object.");
	if (
		!exactKeys(value, [
			"schemaVersion",
			"profileId",
			"description",
			"role",
			"modelPolicy",
			"capabilityCeiling",
			"toolNames",
			"resourceProfileNames",
			"dispatchProfileIds",
			"executionPolicy",
			"budget",
			"maxConcurrent",
			"leaseTtlMs",
			"requireIndependentVerification",
			"verificationProfileId",
			"createdAt",
			"updatedAt",
		])
	) {
		throw new OrchestrationProfileError("Orchestration profile contains an unsupported field.");
	}
	const modelPolicy = value.modelPolicy;
	const budget = value.budget;
	const executionPolicy = value.executionPolicy;
	if (
		!isRecord(modelPolicy) ||
		!exactKeys(modelPolicy, ["mode", "candidates"]) ||
		!Array.isArray(modelPolicy.candidates)
	) {
		throw new OrchestrationProfileError("Orchestration profile modelPolicy is invalid.");
	}
	if (!isRecord(budget)) throw new OrchestrationProfileError("Orchestration profile budget is invalid.");
	if (
		executionPolicy !== undefined &&
		(!isRecord(executionPolicy) ||
			!exactKeys(executionPolicy, ["allowedExecutables", "allowedEnvironmentVariables", "maxOutputBytes"]) ||
			!isStringArray(executionPolicy.allowedExecutables) ||
			!isStringArray(executionPolicy.allowedEnvironmentVariables) ||
			!Number.isSafeInteger(executionPolicy.maxOutputBytes))
	) {
		throw new OrchestrationProfileError("Orchestration profile executionPolicy is invalid.");
	}
	const candidates = modelPolicy.candidates.map((candidate) => {
		if (!isRecord(candidate) || !exactKeys(candidate, ["provider", "modelId", "thinkingLevel"])) {
			throw new OrchestrationProfileError("Orchestration profile model candidate is invalid.");
		}
		if (
			typeof candidate.provider !== "string" ||
			typeof candidate.modelId !== "string" ||
			typeof candidate.thinkingLevel !== "string" ||
			!THINKING_LEVELS.includes(candidate.thinkingLevel as (typeof THINKING_LEVELS)[number])
		) {
			throw new OrchestrationProfileError("Orchestration profile model candidate is invalid.");
		}
		return {
			provider: candidate.provider,
			modelId: candidate.modelId,
			thinkingLevel: candidate.thinkingLevel as (typeof THINKING_LEVELS)[number],
		};
	});
	if (
		value.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION ||
		typeof value.profileId !== "string" ||
		typeof value.description !== "string" ||
		typeof value.role !== "string" ||
		!WORKER_ROLES.includes(value.role as (typeof WORKER_ROLES)[number]) ||
		(modelPolicy.mode !== "fixed" && modelPolicy.mode !== "ordered-fallback") ||
		!Array.isArray(value.capabilityCeiling) ||
		!value.capabilityCeiling.every(
			(capability) =>
				typeof capability === "string" &&
				HARNESS_CAPABILITIES.includes(capability as (typeof HARNESS_CAPABILITIES)[number]),
		) ||
		!isStringArray(value.toolNames) ||
		!isStringArray(value.resourceProfileNames) ||
		!isStringArray(value.dispatchProfileIds) ||
		!Number.isSafeInteger(value.maxConcurrent) ||
		!Number.isSafeInteger(value.leaseTtlMs) ||
		typeof value.requireIndependentVerification !== "boolean" ||
		(value.verificationProfileId !== undefined && typeof value.verificationProfileId !== "string") ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string"
	) {
		throw new OrchestrationProfileError("Orchestration profile is invalid.");
	}
	for (const [key, candidate] of Object.entries(budget)) {
		if (
			!RISK_BUDGET_FIELDS.includes(key as (typeof RISK_BUDGET_FIELDS)[number]) ||
			typeof candidate !== "number" ||
			!Number.isFinite(candidate) ||
			candidate < 0
		) {
			throw new OrchestrationProfileError("Orchestration profile budget is invalid.");
		}
	}
	const profile = structuredClone({
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: value.profileId,
		description: value.description,
		role: value.role as OrchestrationProfile["role"],
		modelPolicy: { mode: modelPolicy.mode as OrchestrationProfile["modelPolicy"]["mode"], candidates },
		capabilityCeiling: value.capabilityCeiling as OrchestrationProfile["capabilityCeiling"],
		toolNames: value.toolNames,
		resourceProfileNames: value.resourceProfileNames,
		dispatchProfileIds: value.dispatchProfileIds,
		...(executionPolicy
			? {
					executionPolicy: {
						allowedExecutables: executionPolicy.allowedExecutables as string[],
						allowedEnvironmentVariables: executionPolicy.allowedEnvironmentVariables as string[],
						maxOutputBytes: Number(executionPolicy.maxOutputBytes),
					},
				}
			: {}),
		budget,
		maxConcurrent: Number(value.maxConcurrent),
		leaseTtlMs: Number(value.leaseTtlMs),
		requireIndependentVerification: value.requireIndependentVerification,
		...(typeof value.verificationProfileId === "string"
			? { verificationProfileId: value.verificationProfileId }
			: {}),
		...(sourcePath ? { sourcePath } : {}),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	}) as OrchestrationProfile;
	validateOrchestrationProfile(profile);
	return profile;
}

function freezeProfile(profile: OrchestrationProfile): OrchestrationProfile {
	const clone = structuredClone(profile);
	for (const candidate of clone.modelPolicy.candidates) Object.freeze(candidate);
	Object.freeze(clone.modelPolicy.candidates);
	Object.freeze(clone.modelPolicy);
	Object.freeze(clone.capabilityCeiling);
	Object.freeze(clone.toolNames);
	Object.freeze(clone.resourceProfileNames);
	Object.freeze(clone.dispatchProfileIds);
	if (clone.executionPolicy) {
		Object.freeze(clone.executionPolicy.allowedExecutables);
		Object.freeze(clone.executionPolicy.allowedEnvironmentVariables);
		Object.freeze(clone.executionPolicy);
	}
	Object.freeze(clone.budget);
	return Object.freeze(clone);
}

export class OrchestrationProfileRegistry {
	private readonly profiles = new Map<string, OrchestrationProfile>();

	constructor(profiles: readonly OrchestrationProfile[] = []) {
		for (const profile of profiles) this.register(profile);
		for (const profile of this.profiles.values()) {
			for (const dispatchedProfileId of profile.dispatchProfileIds) {
				const target = this.profiles.get(dispatchedProfileId);
				if (!target) {
					throw new OrchestrationProfileError(
						`Profile '${profile.profileId}' dispatches missing profile '${dispatchedProfileId}'.`,
					);
				}
				if (target.role === "orchestrator") {
					throw new OrchestrationProfileError(
						`Profile '${profile.profileId}' cannot recursively dispatch orchestrator '${dispatchedProfileId}'.`,
					);
				}
			}
			if (profile.verificationProfileId) {
				const verifier = this.profiles.get(profile.verificationProfileId);
				if (!verifier) {
					throw new OrchestrationProfileError(
						`Profile '${profile.profileId}' requires missing verifier profile '${profile.verificationProfileId}'.`,
					);
				}
				if (verifier.role !== "verifier") {
					throw new OrchestrationProfileError(
						`Profile '${profile.profileId}' verificationProfileId '${profile.verificationProfileId}' is not a verifier.`,
					);
				}
			}
			if (profile.role === "orchestrator") {
				for (const dispatchedProfileId of profile.dispatchProfileIds) {
					const worker = this.profiles.get(dispatchedProfileId);
					if (
						worker?.verificationProfileId &&
						!profile.dispatchProfileIds.includes(worker.verificationProfileId)
					) {
						throw new OrchestrationProfileError(
							`Orchestrator '${profile.profileId}' dispatches '${worker.profileId}' but not its verifier '${worker.verificationProfileId}'.`,
						);
					}
				}
			}
		}
	}

	register(profile: OrchestrationProfile): void {
		validateOrchestrationProfile(profile);
		if (this.profiles.has(profile.profileId)) {
			throw new OrchestrationProfileError(`Duplicate orchestration profile '${profile.profileId}'.`);
		}
		this.profiles.set(profile.profileId, freezeProfile(profile));
	}

	get(profileId: string): OrchestrationProfile | undefined {
		const profile = this.profiles.get(profileId);
		return profile ? structuredClone(profile) : undefined;
	}

	list(): OrchestrationProfile[] {
		return [...this.profiles.values()].map((profile) => structuredClone(profile));
	}
}

export function resolveProfileModel(
	profile: OrchestrationProfile,
	health: ModelHealthView,
): OrchestrationModelBinding | undefined {
	if (profile.modelPolicy.mode === "fixed") {
		const fixed = profile.modelPolicy.candidates[0];
		return fixed && health.isHealthy(fixed) ? structuredClone(fixed) : undefined;
	}
	const selected = profile.modelPolicy.candidates.find((candidate) => health.isHealthy(candidate));
	return selected ? structuredClone(selected) : undefined;
}

export function planProfileDispatch(args: {
	request: OrchestrationDispatchRequest;
	task: TaskContract;
	attemptId: string;
	subjectId: string;
	registry: OrchestrationProfileRegistry;
	health: ModelHealthView;
	policyCompiler: ExecutionPolicyCompiler;
	toolManifests: readonly ToolCapabilityManifest[];
	resources: readonly ResourcePointer[];
	readPaths: readonly string[];
	writePaths?: readonly string[];
	deniedPaths?: readonly string[];
	policyVersion: string;
}): ProfileDispatchPlanResult {
	const profile = args.registry.get(args.request.profileId);
	if (!profile) return { outcome: "deny", decisions: [], reasonCodes: ["profile_model_unavailable"] };
	if (profile.role !== args.task.role) {
		return { outcome: "deny", decisions: [], reasonCodes: ["required_capability_exceeds_role_ceiling"] };
	}
	const model = resolveProfileModel(profile, args.health);
	if (!model) return { outcome: "deny", decisions: [], reasonCodes: ["profile_model_unavailable"] };
	const selectedResources = args.resources.filter((resource) => args.request.resourcePointerIds.includes(resource.id));
	const manifestsByName = new Map(args.toolManifests.map((manifest) => [manifest.toolName, manifest]));
	const requestedTools = profile.toolNames.filter((toolName) => {
		const manifest = manifestsByName.get(toolName);
		return manifest?.capabilities.every((capability) => args.task.requiredCapabilities.includes(capability)) === true;
	});
	const policyInput: CompileExecutionGrantInput = {
		objectiveId: args.task.objectiveId,
		taskId: args.task.taskId,
		attemptId: args.attemptId,
		subjectId: args.subjectId,
		role: profile.role,
		requiredCapabilities: args.task.requiredCapabilities,
		requestedCapabilities: args.task.requiredCapabilities,
		authorityCapabilities: profile.capabilityCeiling,
		requestedTools,
		toolManifests: args.toolManifests,
		resources: selectedResources,
		readPaths: args.readPaths,
		writePaths: args.writePaths,
		deniedPaths: args.deniedPaths,
		requestedBudget: profile.budget,
		authorityBudget: profile.budget,
		policyVersion: args.policyVersion,
	};
	const compiled = args.policyCompiler.compile(policyInput);
	if (compiled.outcome !== "allow") return compiled;
	return { outcome: "allow", plan: { profile, model, grant: compiled.grant, toolManifests: compiled.toolManifests } };
}
