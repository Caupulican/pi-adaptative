import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import { parseBoundedStringArray } from "./bounded-string-array.ts";
import {
	isHarnessCapability,
	isResourcePointerKind,
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
	MAX_WORKER_AUTHORITY_PATH_LENGTH,
	MAX_WORKER_AUTHORITY_PATHS,
	MAX_WORKER_RESOURCE_METADATA_NAME_LENGTH,
	MAX_WORKER_RESOURCE_PATH_LENGTH,
	MAX_WORKER_RESOURCE_POINTERS,
	MAX_WORKER_SOUL_LENGTH,
	ORCHESTRATION_SCHEMA_VERSION,
	ORCHESTRATION_THINKING_LEVELS,
	type OrchestrationModelBinding,
	type OrchestrationProfile,
	type ResourcePointer,
	type RiskBudget,
	type WorkerExecutionAuthorityContract,
	type WorkerExecutionContract,
	type WorkerProfileExecutionContract,
} from "./contracts.ts";
import { OrchestrationProfileError, parseOrchestrationProfile } from "./profile-registry.ts";
import { intersectRiskBudgets, parseRiskBudget } from "./risk-budget.ts";

export class WorkerExecutionContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerExecutionContractError";
	}
}

function parseModelBinding(value: unknown, label: string): OrchestrationModelBinding {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["provider", "modelId", "thinkingLevel"]) ||
		typeof value.provider !== "string" ||
		value.provider.length > MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH ||
		!value.provider.trim() ||
		typeof value.modelId !== "string" ||
		value.modelId.length > MAX_ORCHESTRATION_MODEL_ID_LENGTH ||
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

function stringArray(
	value: unknown,
	label: string,
	options: { maxEntries?: number; maxLength?: number } = {},
): string[] {
	return parseBoundedStringArray(value, {
		...options,
		invalidMessage: `${label} must be an array of non-empty strings.`,
		duplicateMessage: `${label} contains duplicates.`,
		createError: (message) => new WorkerExecutionContractError(message),
	});
}

function parseResourcePointers(value: unknown, label: string): ResourcePointer[] {
	if (!Array.isArray(value) || value.length > MAX_WORKER_RESOURCE_POINTERS) {
		throw new WorkerExecutionContractError(`${label} resource pointers are invalid.`);
	}
	const ids = new Set<string>();
	return value.map((candidate) => {
		if (
			!isPlainRecord(candidate) ||
			!hasOnlyKeys(candidate, ["id", "kind", "uri", "readOnly", "digest", "metadata"]) ||
			typeof candidate.id !== "string" ||
			!/^(skill|prompt):[a-f0-9]{64}$/i.test(candidate.id) ||
			typeof candidate.kind !== "string" ||
			!isResourcePointerKind(candidate.kind) ||
			(candidate.kind !== "skill" && candidate.kind !== "prompt") ||
			!candidate.id.startsWith(`${candidate.kind}:`) ||
			typeof candidate.uri !== "string" ||
			candidate.uri.length === 0 ||
			candidate.uri.length > MAX_WORKER_RESOURCE_PATH_LENGTH + 16 ||
			!candidate.uri.startsWith("file:") ||
			candidate.readOnly !== true ||
			(candidate.digest !== undefined &&
				(typeof candidate.digest !== "string" || !/^[a-f0-9]{64}$/i.test(candidate.digest))) ||
			(candidate.metadata !== undefined &&
				(!isPlainRecord(candidate.metadata) ||
					typeof candidate.metadata.name !== "string" ||
					candidate.metadata.name.length === 0 ||
					candidate.metadata.name.length > MAX_WORKER_RESOURCE_METADATA_NAME_LENGTH ||
					!hasOnlyKeys(candidate.metadata, ["name"])))
		) {
			throw new WorkerExecutionContractError(`${label} resource pointer is invalid.`);
		}
		if (ids.has(candidate.id)) {
			throw new WorkerExecutionContractError(`${label} resource pointers contain duplicates.`);
		}
		ids.add(candidate.id);
		return {
			id: candidate.id,
			kind: candidate.kind,
			uri: candidate.uri,
			readOnly: true,
			...(typeof candidate.digest === "string" ? { digest: candidate.digest } : {}),
			...(isPlainRecord(candidate.metadata) && typeof candidate.metadata.name === "string"
				? { metadata: { name: candidate.metadata.name } }
				: {}),
		};
	});
}

function parseAuthority(
	value: unknown,
	profile: OrchestrationProfile,
	label: string,
): WorkerExecutionAuthorityContract {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["cwd", "capabilities", "toolNames", "readPaths", "writePaths", "deniedPaths", "budget"])
	) {
		throw new WorkerExecutionContractError(`${label} authority is invalid.`);
	}
	const cwd = value.cwd;
	if (
		cwd !== undefined &&
		(typeof cwd !== "string" ||
			!cwd.trim() ||
			cwd.length > MAX_WORKER_AUTHORITY_PATH_LENGTH ||
			(!path.isAbsolute(cwd) && !path.win32.isAbsolute(cwd)))
	) {
		throw new WorkerExecutionContractError(`${label} authority cwd must be an absolute path.`);
	}
	const capabilities = stringArray(value.capabilities, `${label} authority capabilities`);
	if (!capabilities.every(isHarnessCapability)) {
		throw new WorkerExecutionContractError(`${label} authority contains an unknown capability.`);
	}
	if (
		capabilities.some(
			(capability) =>
				capability !== "workflow.delegate" &&
				capability !== "memory.query" &&
				!profile.capabilityCeiling.includes(capability),
		)
	) {
		throw new WorkerExecutionContractError(`${label} authority exceeds its profile capability ceiling.`);
	}
	const toolNames = stringArray(value.toolNames, `${label} authority toolNames`);
	if (
		toolNames.some(
			(toolName) => toolName !== "delegate" && toolName !== "memory" && !profile.toolNames.includes(toolName),
		)
	) {
		throw new WorkerExecutionContractError(`${label} authority contains a tool outside its profile.`);
	}
	const pathArrayOptions = {
		maxEntries: MAX_WORKER_AUTHORITY_PATHS,
		maxLength: MAX_WORKER_AUTHORITY_PATH_LENGTH,
	};
	const readPaths = stringArray(value.readPaths, `${label} authority readPaths`, pathArrayOptions);
	const writePaths = stringArray(value.writePaths, `${label} authority writePaths`, pathArrayOptions);
	const deniedPaths = stringArray(value.deniedPaths, `${label} authority deniedPaths`, pathArrayOptions);
	if (
		[...readPaths, ...writePaths, ...deniedPaths].some(
			(entry) => !path.isAbsolute(entry) && !path.win32.isAbsolute(entry),
		)
	) {
		throw new WorkerExecutionContractError(`${label} authority paths must be absolute.`);
	}
	let budget: RiskBudget;
	try {
		budget = parseRiskBudget(value.budget, `${label} authority budget`);
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
		...(typeof cwd === "string" ? { cwd } : {}),
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
		!hasOnlyKeys(value, ["schemaVersion", "profile", "modelBinding", "authority", "resourcePointers", "soul"]) ||
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
	const modelBinding = parseModelBinding(value.modelBinding, label);
	if (!profile.modelPolicy.candidates.some((candidate) => isDeepStrictEqual(candidate, modelBinding))) {
		throw new WorkerExecutionContractError(`${label} model binding is not declared by its profile.`);
	}
	if (
		value.soul !== undefined &&
		(typeof value.soul !== "string" || value.soul.length > MAX_WORKER_SOUL_LENGTH || !value.soul.trim())
	) {
		throw new WorkerExecutionContractError(`${label} soul is invalid.`);
	}
	const authority = parseAuthority(value.authority, profile, label);
	const resourcePointers = parseResourcePointers(value.resourcePointers ?? [], label);
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profile,
		modelBinding,
		authority,
		resourcePointers,
		...(typeof value.soul === "string" ? { soul: value.soul } : {}),
	};
}

export function parseWorkerExecutionContract(value: unknown): WorkerExecutionContract {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["schemaVersion", "worker", "verifier"]) ||
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
	resourcePointers?: readonly ResourcePointer[];
	soul?: string;
}): WorkerProfileExecutionContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profile: snapshotProfile(source.profile),
		modelBinding: structuredClone(source.modelBinding),
		authority: structuredClone(source.authority),
		resourcePointers: structuredClone(source.resourcePointers ?? []),
		...(source.soul ? { soul: source.soul } : {}),
	};
}

export function createWorkerExecutionContract(args: {
	worker: {
		profile: OrchestrationProfile;
		modelBinding: OrchestrationModelBinding;
		authority: WorkerExecutionAuthorityContract;
		resourcePointers?: readonly ResourcePointer[];
		soul?: string;
	};
	verifier?: {
		profile: OrchestrationProfile;
		modelBinding: OrchestrationModelBinding;
		authority: WorkerExecutionAuthorityContract;
		resourcePointers?: readonly ResourcePointer[];
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
