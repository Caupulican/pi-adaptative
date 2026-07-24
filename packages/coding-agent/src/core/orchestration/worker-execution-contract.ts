import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	isHarnessCapability,
	ORCHESTRATION_SCHEMA_VERSION,
	ORCHESTRATION_THINKING_LEVELS,
	type OrchestrationModelBinding,
	type OrchestrationProfile,
	type WorkerExecutionAuthorityContract,
	type WorkerExecutionContract,
	type WorkerProfileExecutionContract,
} from "./contracts.ts";
import { OrchestrationProfileError, parseOrchestrationProfile } from "./profile-registry.ts";
import { intersectRiskBudgets, validateRiskBudget } from "./risk-budget.ts";

export class WorkerExecutionContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerExecutionContractError";
	}
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedSet = new Set(allowed);
	return Object.keys(record).every((key) => allowedSet.has(key));
}

function parseModelBinding(value: unknown, label: string): OrchestrationModelBinding {
	if (
		!isPlainRecord(value) ||
		!exactKeys(value, ["provider", "modelId", "thinkingLevel"]) ||
		typeof value.provider !== "string" ||
		!value.provider.trim() ||
		typeof value.modelId !== "string" ||
		!value.modelId.trim() ||
		typeof value.thinkingLevel !== "string" ||
		!ORCHESTRATION_THINKING_LEVELS.includes(value.thinkingLevel as (typeof ORCHESTRATION_THINKING_LEVELS)[number])
	) {
		throw new WorkerExecutionContractError(`${label} model binding is invalid.`);
	}
	return {
		provider: value.provider,
		modelId: value.modelId,
		thinkingLevel: value.thinkingLevel as (typeof ORCHESTRATION_THINKING_LEVELS)[number],
	};
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
		throw new WorkerExecutionContractError(`${label} must be an array of non-empty strings.`);
	}
	if (new Set(value).size !== value.length) {
		throw new WorkerExecutionContractError(`${label} contains duplicates.`);
	}
	return [...value];
}

function parseAuthority(
	value: unknown,
	profile: OrchestrationProfile,
	label: string,
): WorkerExecutionAuthorityContract {
	if (
		!isPlainRecord(value) ||
		!exactKeys(value, ["capabilities", "toolNames", "readPaths", "writePaths", "deniedPaths", "budget"])
	) {
		throw new WorkerExecutionContractError(`${label} authority is invalid.`);
	}
	const capabilities = stringArray(value.capabilities, `${label} authority capabilities`);
	if (!capabilities.every(isHarnessCapability)) {
		throw new WorkerExecutionContractError(`${label} authority contains an unknown capability.`);
	}
	if (capabilities.some((capability) => !profile.capabilityCeiling.includes(capability))) {
		throw new WorkerExecutionContractError(`${label} authority exceeds its profile capability ceiling.`);
	}
	const toolNames = stringArray(value.toolNames, `${label} authority toolNames`);
	if (toolNames.some((toolName) => !profile.toolNames.includes(toolName))) {
		throw new WorkerExecutionContractError(`${label} authority contains a tool outside its profile.`);
	}
	const readPaths = stringArray(value.readPaths, `${label} authority readPaths`);
	const writePaths = stringArray(value.writePaths, `${label} authority writePaths`);
	const deniedPaths = stringArray(value.deniedPaths, `${label} authority deniedPaths`);
	if ([...readPaths, ...writePaths, ...deniedPaths].some((entry) => !path.isAbsolute(entry))) {
		throw new WorkerExecutionContractError(`${label} authority paths must be absolute.`);
	}
	if (!isPlainRecord(value.budget)) {
		throw new WorkerExecutionContractError(`${label} authority budget is invalid.`);
	}
	const budget = structuredClone(value.budget);
	try {
		validateRiskBudget(budget, `${label} authority budget`);
	} catch (error) {
		throw new WorkerExecutionContractError(error instanceof Error ? error.message : String(error));
	}
	if (!isDeepStrictEqual(intersectRiskBudgets(profile.budget, budget), budget)) {
		throw new WorkerExecutionContractError(`${label} authority exceeds its profile budget.`);
	}
	const readGranted = capabilities.some(
		(capability) => capability === "filesystem.read" || capability === "worktree.read",
	);
	const writeGranted = capabilities.some(
		(capability) => capability === "filesystem.write" || capability === "worktree.mutate",
	);
	if (readGranted && readPaths.length === 0) {
		throw new WorkerExecutionContractError(`${label} read authority lacks a positive path scope.`);
	}
	if (writeGranted && writePaths.length === 0) {
		throw new WorkerExecutionContractError(`${label} write authority lacks a positive path scope.`);
	}
	return {
		capabilities: capabilities as WorkerExecutionAuthorityContract["capabilities"],
		toolNames,
		readPaths,
		writePaths,
		deniedPaths,
		budget,
	};
}

function parseProfileContract(value: unknown, label: string): WorkerProfileExecutionContract {
	if (
		!isPlainRecord(value) ||
		!exactKeys(value, ["schemaVersion", "profile", "modelBinding", "authority", "soul"]) ||
		value.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION
	) {
		throw new WorkerExecutionContractError(`${label} is invalid.`);
	}
	let profile: OrchestrationProfile;
	try {
		profile = parseOrchestrationProfile(value.profile);
	} catch (error) {
		throw new WorkerExecutionContractError(
			error instanceof OrchestrationProfileError ? error.message : `${label} profile is invalid.`,
		);
	}
	if (profile.role === "orchestrator") {
		throw new WorkerExecutionContractError(`${label} cannot materialize an orchestrator profile.`);
	}
	const modelBinding = parseModelBinding(value.modelBinding, label);
	if (!profile.modelPolicy.candidates.some((candidate) => isDeepStrictEqual(candidate, modelBinding))) {
		throw new WorkerExecutionContractError(`${label} model binding is not declared by its profile.`);
	}
	if (value.soul !== undefined && (typeof value.soul !== "string" || !value.soul.trim())) {
		throw new WorkerExecutionContractError(`${label} soul is invalid.`);
	}
	const authority = parseAuthority(value.authority, profile, label);
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profile,
		modelBinding,
		authority,
		...(typeof value.soul === "string" ? { soul: value.soul } : {}),
	};
}

export function parseWorkerExecutionContract(value: unknown): WorkerExecutionContract {
	if (
		!isPlainRecord(value) ||
		!exactKeys(value, ["schemaVersion", "worker", "verifier"]) ||
		value.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION
	) {
		throw new WorkerExecutionContractError("Worker execution contract is invalid.");
	}
	const worker = parseProfileContract(value.worker, "Worker execution contract");
	const verifier = value.verifier
		? parseProfileContract(value.verifier, "Worker verifier execution contract")
		: undefined;
	if (worker.profile.requireIndependentVerification) {
		if (!verifier || worker.profile.verificationProfileId !== verifier.profile.profileId) {
			throw new WorkerExecutionContractError("Worker execution contract is missing its owner-pinned verifier.");
		}
		if (verifier.profile.role !== "verifier") {
			throw new WorkerExecutionContractError("Worker verifier execution contract does not use a verifier profile.");
		}
	} else if (verifier) {
		throw new WorkerExecutionContractError("Worker execution contract has an unexpected verifier.");
	}
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		worker,
		...(verifier ? { verifier } : {}),
	};
}

function snapshotProfile(profile: OrchestrationProfile): OrchestrationProfile {
	const { sourcePath: _sourcePath, ...persisted } = profile;
	return structuredClone(persisted) as OrchestrationProfile;
}

function snapshotResolvedProfile(source: {
	profile: OrchestrationProfile;
	modelBinding: OrchestrationModelBinding;
	authority: WorkerExecutionAuthorityContract;
	soul?: string;
}): WorkerProfileExecutionContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profile: snapshotProfile(source.profile),
		modelBinding: structuredClone(source.modelBinding),
		authority: structuredClone(source.authority),
		...(source.soul ? { soul: source.soul } : {}),
	};
}

export function createWorkerExecutionContract(args: {
	worker: {
		profile: OrchestrationProfile;
		modelBinding: OrchestrationModelBinding;
		authority: WorkerExecutionAuthorityContract;
		soul?: string;
	};
	verifier?: {
		profile: OrchestrationProfile;
		modelBinding: OrchestrationModelBinding;
		authority: WorkerExecutionAuthorityContract;
		soul?: string;
	};
}): WorkerExecutionContract {
	return parseWorkerExecutionContract({
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		worker: snapshotResolvedProfile(args.worker),
		...(args.verifier ? { verifier: snapshotResolvedProfile(args.verifier) } : {}),
	});
}

export function verifierWorkerExecutionContract(
	contract: WorkerExecutionContract,
): WorkerExecutionContract | undefined {
	return contract.verifier
		? parseWorkerExecutionContract({ schemaVersion: ORCHESTRATION_SCHEMA_VERSION, worker: contract.verifier })
		: undefined;
}
