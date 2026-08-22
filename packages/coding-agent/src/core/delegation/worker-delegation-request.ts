import { parseBoundedStringArray } from "../orchestration/bounded-string-array.ts";
import {
	type HarnessCapability,
	isHarnessCapability,
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
	MAX_WORKER_AUTHORITY_PATH_LENGTH,
	ORCHESTRATION_THINKING_LEVELS,
	type OrchestrationThinkingLevel,
	type RiskBudget,
	WORKER_ROLES,
	type WorkerRole,
} from "../orchestration/contracts.ts";
import { parseRiskBudget } from "../orchestration/risk-budget.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";

/** Runtime-owned task correlation retained with a durable worker dispatch. Never model-settable. */
export interface WorkerDelegationTaskContext {
	requirementIds: readonly string[];
	dependsOnTaskIds: readonly string[];
	acceptanceCriterionIds: readonly string[];
	/**
	 * Optional runtime narrowing of the owner-admitted profile resources. An empty list does not
	 * suppress owner resources: admission expands it to the immutable profile pointer set and
	 * persists that exact selection with the attempt.
	 */
	resourcePointerIds: readonly string[];
}

export interface WorkerDelegationModelRequest {
	provider: string;
	modelId: string;
}

/**
 * Trusted caller execution preferences compiled into an immutable, inherited runtime grant.
 * The model-facing `delegate` adapter intentionally exposes a budget-free subset.
 */
export interface WorkerDelegationAuthorityRequest {
	role?: WorkerRole;
	model?: WorkerDelegationModelRequest;
	thinkingLevel?: OrchestrationThinkingLevel;
	capabilities?: readonly HarnessCapability[];
	toolNames?: readonly string[];
	/** One model-selectable workspace focus. The host derives cwd plus symmetric read/write scope. */
	path?: string;
	budget?: RiskBudget;
}

export class WorkerDelegationRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerDelegationRequestError";
	}
}

function uniqueStringArray(value: unknown, label: string, options: { maxEntries?: number; maxLength?: number } = {}) {
	return parseBoundedStringArray(value, {
		...options,
		trim: true,
		invalidMessage: `${label} must contain bounded, non-empty strings.`,
		duplicateMessage: `${label} must contain unique strings.`,
		createError: (message) => new WorkerDelegationRequestError(message),
	});
}

/** Parse a caller authority request before it reaches admission or durable state. */
export function parseWorkerDelegationAuthorityRequest(value: unknown): WorkerDelegationAuthorityRequest {
	if (!isPlainRecord(value)) throw new WorkerDelegationRequestError("Delegation authority must be an object.");
	if (!hasOnlyKeys(value, ["role", "model", "thinkingLevel", "capabilities", "toolNames", "path", "budget"])) {
		throw new WorkerDelegationRequestError("Delegation authority contains an unsupported field.");
	}
	if (value.role !== undefined && !WORKER_ROLES.includes(value.role as WorkerRole)) {
		throw new WorkerDelegationRequestError("Delegation authority role is invalid.");
	}
	if (
		value.thinkingLevel !== undefined &&
		!ORCHESTRATION_THINKING_LEVELS.includes(value.thinkingLevel as OrchestrationThinkingLevel)
	) {
		throw new WorkerDelegationRequestError("Delegation authority thinkingLevel is invalid.");
	}
	let model: WorkerDelegationModelRequest | undefined;
	if (value.model !== undefined) {
		if (
			!isPlainRecord(value.model) ||
			!hasOnlyKeys(value.model, ["provider", "modelId"]) ||
			typeof value.model.provider !== "string" ||
			!value.model.provider.trim() ||
			value.model.provider.length > MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH ||
			typeof value.model.modelId !== "string" ||
			!value.model.modelId.trim() ||
			value.model.modelId.length > MAX_ORCHESTRATION_MODEL_ID_LENGTH
		) {
			throw new WorkerDelegationRequestError("Delegation authority model is invalid.");
		}
		model = { provider: value.model.provider.trim(), modelId: value.model.modelId.trim() };
	}
	let capabilities: HarnessCapability[] | undefined;
	if (value.capabilities !== undefined) {
		const parsed = uniqueStringArray(value.capabilities, "Delegation authority capabilities");
		if (!parsed.every(isHarnessCapability)) {
			throw new WorkerDelegationRequestError("Delegation authority contains an unknown capability.");
		}
		capabilities = parsed;
	}
	const toolNames =
		value.toolNames === undefined ? undefined : uniqueStringArray(value.toolNames, "Delegation authority toolNames");
	const workspacePath =
		value.path === undefined
			? undefined
			: typeof value.path === "string" &&
					value.path.trim() &&
					!value.path.includes("\0") &&
					value.path.length <= MAX_WORKER_AUTHORITY_PATH_LENGTH
				? value.path.trim()
				: undefined;
	if (value.path !== undefined && workspacePath === undefined) {
		throw new WorkerDelegationRequestError("Delegation authority path must be a bounded, non-empty string.");
	}
	let budget: RiskBudget | undefined;
	try {
		budget = value.budget === undefined ? undefined : parseRiskBudget(value.budget, "Delegation authority budget");
	} catch (error) {
		throw new WorkerDelegationRequestError(error instanceof Error ? error.message : String(error));
	}
	return {
		...(value.role ? { role: value.role as WorkerRole } : {}),
		...(model ? { model } : {}),
		...(value.thinkingLevel ? { thinkingLevel: value.thinkingLevel as OrchestrationThinkingLevel } : {}),
		...(capabilities ? { capabilities } : {}),
		...(toolNames ? { toolNames } : {}),
		...(workspacePath ? { path: workspacePath } : {}),
		...(budget ? { budget } : {}),
	};
}

/** A profile is an optional preset; authority is compiled and persisted by the host. */
export interface WorkerDelegationRequest {
	instructions: string;
	profileId?: string;
	authority?: WorkerDelegationAuthorityRequest;
	/** Tool-facing immutable birth-context selection for a newly admitted logical worker. */
	forkTurns?: string;
	/** Runtime-owned creator identity retained for recovery of legacy durable records. */
	parentAgentId?: string;
	/** Runtime-owned correlation for an automatically dispatched verifier; never model-settable. */
	verificationOfTaskId?: string;
	/** Runtime-owned durable task correlation; the delegate tool schema intentionally omits this. */
	taskContext?: WorkerDelegationTaskContext;
}
