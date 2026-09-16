import { isDeepStrictEqual } from "node:util";
import { latestAgentAttemptByDurableOrder } from "../orchestration/attempt-ordering.ts";
import type {
	AgentBindingContract,
	ResourcePointer,
	WorkerExecutionContract,
	WorkerProfileExecutionContract,
} from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { NONTERMINAL_WORKER_ATTEMPT_STATUSES } from "./worker-lane-projection.ts";

/**
 * Normalized description of ONE specialization, derived from the compiled execution contract.
 *
 * Only semantics are compared. Compiler-generated profile ids, contract schema/session provenance
 * and record timestamps are deliberately absent: `adaptiveProfileId` hashes an order-sensitive
 * descriptor, so equal effective authority can carry two different names and two different requests
 * can carry the same name. Sets are canonicalized because tool and path grants are sets; resource
 * pointers keep their order because that order drives prompt materialization and model fallback.
 */
export interface WorkerSpecializationFingerprint {
	role: string;
	provider: string;
	modelId: string;
	thinkingLevel: string;
	/** Fallback candidates in policy order: a different ladder is a different admitted binding. */
	modelPolicy: string;
	cwd: string;
	capabilities: readonly string[];
	toolNames: readonly string[];
	readPaths: readonly string[];
	writePaths: readonly string[];
	deniedPaths: readonly string[];
	/** Effective budget ceiling: reusing a context under a newly tightened budget is not the same work. */
	budget: string;
	/** Process-execution policy admitted for this specialization, when the profile carries one. */
	executionPolicy: string;
	/** Lineage bounds admitted with the profile. */
	delegationLimits: string;
	/** Resolved identity prompt: different prompt identity is a different specialist. */
	soul: string;
	/** Owner-selected resource profile names, in the order the profile declares them. */
	resourceProfileNames: readonly string[];
	/** Mandatory-verification policy, independent of whether a verifier contract is attached. */
	requireIndependentVerification: boolean;
	/** Worktree lane this specialization is bound to, when the dispatcher claimed one. */
	worktreeLaneKey: string;
	/** Ordered: resource order changes the materialized prompt, so it is part of the specialization. */
	resources: readonly string[];
	/**
	 * Physical workspace identity, as the directory backend spells it under one fixed nonce. A
	 * different physical directory is different work even when the path spelling matches.
	 */
	namespaceKey: string;
	/** The verifier this specialization is required to run with, described the same way. */
	verifier?: Omit<WorkerSpecializationFingerprint, "verifier">;
}

function canonicalSet(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort();
}

function describeResourcePointer(pointer: ResourcePointer): string {
	// Identity AND content reference: a pointer id alone would treat a re-pointed resource as equal.
	// `digest`/`metadata` are explicit contract fields, so a pointer that names the same URI with a
	// different admitted version is a different resource here, exactly as legacy authority narrowing
	// already treats it.
	return JSON.stringify([
		pointer.kind,
		pointer.id,
		pointer.uri,
		pointer.readOnly === true,
		pointer.digest ?? null,
		pointer.metadata ?? null,
	]);
}

/** Stable text for an optional structured policy value; absence and presence must not compare equal. */
function describeOptionalPolicy(value: unknown): string {
	return value === undefined ? "" : JSON.stringify(value);
}

function describeProfileContract(
	contract: WorkerProfileExecutionContract,
	selectedResourcePointerIds: readonly string[] | undefined,
	namespaceKey: string,
	worktreeLaneKey?: string,
): Omit<WorkerSpecializationFingerprint, "verifier"> {
	const selected = new Set(selectedResourcePointerIds ?? contract.resourcePointers.map((pointer) => pointer.id));
	return {
		role: contract.profile.role,
		provider: contract.modelBinding.provider,
		modelId: contract.modelBinding.modelId,
		thinkingLevel: contract.modelBinding.thinkingLevel ?? "off",
		modelPolicy: describeOptionalPolicy(contract.profile.modelPolicy),
		cwd: contract.authority.cwd ?? "",
		capabilities: canonicalSet(contract.authority.capabilities),
		toolNames: canonicalSet(contract.authority.toolNames),
		readPaths: canonicalSet(contract.authority.readPaths),
		writePaths: canonicalSet(contract.authority.writePaths),
		deniedPaths: canonicalSet(contract.authority.deniedPaths),
		budget: describeOptionalPolicy(contract.authority.budget),
		executionPolicy: describeOptionalPolicy(contract.profile.executionPolicy),
		delegationLimits: describeOptionalPolicy(contract.profile.delegationLimits),
		soul: contract.soul ?? "",
		resourceProfileNames: [...contract.profile.resourceProfileNames],
		requireIndependentVerification: contract.profile.requireIndependentVerification === true,
		worktreeLaneKey: worktreeLaneKey ?? "",
		resources: contract.resourcePointers.filter((pointer) => selected.has(pointer.id)).map(describeResourcePointer),
		namespaceKey,
	};
}

/** The physical workspace root one compiled profile contract executes in. */
export function workerContractWorkspaceRoot(contract: WorkerProfileExecutionContract): string | undefined {
	return contract.executionContext?.attachment.root ?? contract.authority.cwd;
}

/** Describe the specialization one compiled contract materializes, for comparison only. */
export function describeWorkerSpecialization(
	contract: WorkerExecutionContract,
	selectedResourcePointerIds: readonly string[] | undefined,
	namespaceKeyOf: (root: string | undefined) => string,
	worktreeLaneKey?: string,
): WorkerSpecializationFingerprint {
	return {
		...describeProfileContract(
			contract.worker,
			selectedResourcePointerIds,
			namespaceKeyOf(workerContractWorkspaceRoot(contract.worker)),
			worktreeLaneKey,
		),
		...(contract.verifier
			? {
					verifier: describeProfileContract(
						contract.verifier,
						undefined,
						namespaceKeyOf(workerContractWorkspaceRoot(contract.verifier)),
						worktreeLaneKey,
					),
				}
			: {}),
	};
}

/**
 * Every physical workspace root the decision below will compare: the candidate's own and each
 * in-process specialist's. Resolving them is I/O, so the caller does it once, before deciding.
 */
export function workerSpecializationWorkspaceRoots(
	snapshot: Pick<TaskRuntimeProjection, "agents" | "attempts" | "tasks">,
): string[] {
	const roots = new Set<string>();
	for (const agent of Object.values(snapshot.agents)) {
		if (agent.status !== "registered") continue;
		const attempt = latestAgentAttemptByDurableOrder(snapshot, agent.agentId);
		const contract = attempt?.dispatch.executionContract;
		if (!contract || attempt?.dispatch.executionKind === "managed-process") continue;
		const root = workerContractWorkspaceRoot(contract.worker);
		if (root) roots.add(root);
	}
	return [...roots];
}

export function sameWorkerSpecialization(
	left: WorkerSpecializationFingerprint,
	right: WorkerSpecializationFingerprint,
): boolean {
	return isDeepStrictEqual(left, right);
}

/**
 * What an ordinary native start should do with the specialists this session already has.
 *
 * `reuse` names the one compatible specialist that is idle and settled. `unavailable` is a bounded
 * answer about compatible specialists that cannot take the work right now -- busy, still cleaning up
 * after a finished task, ambiguous, or holding a context that cannot be read. It is never a reason
 * to mint a second copy of the same specialization.
 */
export type WorkerSpecialistReuseDecision =
	| { outcome: "fresh"; releaseAllocation?: () => void }
	| { outcome: "reuse"; agentId: string }
	| { outcome: "unavailable"; skipReason: string };

export interface WorkerSpecialistReuseInput {
	/** An explicit selection narrows matching before ambiguity is evaluated. */
	agentId?: string;
	/** Immutable birth context and materialized resources must also match current admission. */
	isInitializationCompatible(agent: AgentBindingContract | undefined, attempt: AttemptRuntimeState): boolean;
	snapshot: Pick<TaskRuntimeProjection, "agents" | "attempts" | "tasks">;
	candidate: WorkerSpecializationFingerprint;
	/** True while another start in this process is already allocating this exact specialization. */
	freshAllocationInFlight?: boolean;
	/** True while this specialist's own execution has not fully released its resources. */
	isSettled(agentId: string): boolean;
	/** False when the specialist's durable context cannot be read; reuse then fails bounded. */
	isContextReadable(agent: AgentBindingContract, attempt: AttemptRuntimeState): boolean;
	/** Explicit, justified intent to run an independent copy beside the existing specialists. */
	independentParallelIntent?: boolean;
	/** Resolved workspace identity for a root the caller already asked the directory backend about. */
	namespaceKeyOf(root: string | undefined): string;
}

function attemptSpecialization(
	attempt: AttemptRuntimeState,
	namespaceKeyOf: (root: string | undefined) => string,
): WorkerSpecializationFingerprint | undefined {
	const contract = attempt.dispatch.executionContract;
	if (!contract || attempt.dispatch.executionKind === "managed-process") return undefined;
	return describeWorkerSpecialization(
		contract,
		attempt.dispatch.resourcePointerIds,
		namespaceKeyOf,
		attempt.dispatch.worktreeLaneKey,
	);
}

/**
 * Reuse is mandatory for a compatible, eligible context; it is never inferred from provider, model
 * or project alone. A retired, suspended or resuming binding is out of scope entirely: those
 * contexts are only re-entered by an explicit resume.
 */
export function selectReusableWorkerSpecialist(input: WorkerSpecialistReuseInput): WorkerSpecialistReuseDecision {
	if (input.independentParallelIntent) return { outcome: "fresh" };
	const idle: string[] = [];
	let busy = input.freshAllocationInFlight ? 1 : 0;
	let unreadable = 0;
	// Specialists are derived from durable work, not only from registered bindings: a dispatched turn
	// that has not reached execution yet owns its specialization already, and duplicating it while it
	// waits would be exactly the duplicate this decision exists to prevent.
	const specialistIds = new Set<string>(Object.keys(input.snapshot.agents));
	for (const attempt of Object.values(input.snapshot.attempts)) {
		const specialistId = attempt.agentId ?? attempt.dispatch.logicalLaneId;
		if (specialistId) specialistIds.add(specialistId);
	}
	for (const specialistId of specialistIds) {
		if (input.agentId && specialistId !== input.agentId) continue;
		const agent = input.snapshot.agents[specialistId];
		// Retired, suspended and resuming contexts are re-entered only by an explicit resume.
		if (agent && agent.status !== "registered" && agent.status !== "active") continue;
		const attempt = latestAgentAttemptByDurableOrder(input.snapshot, specialistId);
		if (!attempt) continue;
		const specialization = attemptSpecialization(attempt, input.namespaceKeyOf);
		if (!specialization || !sameWorkerSpecialization(specialization, input.candidate)) continue;
		if (!input.isInitializationCompatible(agent, attempt)) continue;
		if (
			agent?.status === "active" ||
			NONTERMINAL_WORKER_ATTEMPT_STATUSES.has(attempt.status) ||
			!input.isSettled(specialistId)
		) {
			busy += 1;
			continue;
		}
		// Only a registered binding can take a new turn: an unbound durable lane has no resumable
		// identity to dispatch onto.
		if (!agent) continue;
		if (!input.isContextReadable(agent, attempt)) {
			unreadable += 1;
			continue;
		}
		idle.push(specialistId);
	}
	if (idle.length === 1) return { outcome: "reuse", agentId: idle[0]! };
	// More than one equally compatible idle specialist is an ambiguity the host cannot resolve on the
	// caller's behalf: picking one silently would bind this work to an arbitrary context.
	if (idle.length > 1) {
		return { outcome: "unavailable", skipReason: `worker_specialist_choice_required:${idle.sort().join(",")}` };
	}
	if (unreadable > 0) return { outcome: "unavailable", skipReason: "worker_specialist_context_unavailable" };
	if (busy > 0) return { outcome: "unavailable", skipReason: "worker_specialist_busy" };
	return { outcome: "fresh" };
}
