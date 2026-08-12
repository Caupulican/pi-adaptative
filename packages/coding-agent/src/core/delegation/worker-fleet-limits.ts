import { latestAgentAttemptByDurableOrder } from "../orchestration/attempt-ordering.ts";
import {
	type AgentBindingContract,
	MAX_ORCHESTRATION_AGENT_BINDINGS,
	MAX_ORCHESTRATION_AGENT_DEPTH,
	MAX_ORCHESTRATION_DIRECT_CHILDREN,
	type OrchestrationDelegationLimits,
} from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";

/**
 * Process-independent safety ceilings for one durable session fleet. These limits bound persisted
 * identity growth and scheduler fan-out; model/provider budgets remain separately authoritative.
 */
export interface WorkerFleetLimits {
	maxDepth: number;
	maxAgentsPerSession: number;
	maxChildrenPerAgent: number;
	maxNestedAgentsPerSession: number;
	maxQueuedDispatches: number;
}

export const DEFAULT_WORKER_FLEET_LIMITS: Readonly<WorkerFleetLimits> = Object.freeze({
	maxDepth: MAX_ORCHESTRATION_AGENT_DEPTH,
	maxAgentsPerSession: MAX_ORCHESTRATION_AGENT_BINDINGS,
	maxChildrenPerAgent: MAX_ORCHESTRATION_DIRECT_CHILDREN,
	maxNestedAgentsPerSession: MAX_ORCHESTRATION_AGENT_BINDINGS,
	maxQueuedDispatches: 256,
});

/** Profile-free workers get one useful nested identity without an open-ended recursive fleet. */
export const LEAN_WORKER_DELEGATION_LIMITS: Readonly<OrchestrationDelegationLimits> = Object.freeze({
	maxDepth: 1,
	maxChildrenPerAgent: 1,
	maxNestedAgentsPerSession: 1,
});

/** Materialize an optional profile limit inside the process-independent host safety ceiling. */
export function resolveWorkerFleetLimits(
	delegationLimits?: Readonly<OrchestrationDelegationLimits>,
): Readonly<WorkerFleetLimits> {
	return {
		...DEFAULT_WORKER_FLEET_LIMITS,
		maxDepth: Math.min(
			delegationLimits?.maxDepth ?? DEFAULT_WORKER_FLEET_LIMITS.maxDepth,
			MAX_ORCHESTRATION_AGENT_DEPTH,
		),
		maxChildrenPerAgent: Math.min(
			delegationLimits?.maxChildrenPerAgent ?? DEFAULT_WORKER_FLEET_LIMITS.maxChildrenPerAgent,
			MAX_ORCHESTRATION_DIRECT_CHILDREN,
		),
		maxNestedAgentsPerSession: Math.min(
			delegationLimits?.maxNestedAgentsPerSession ?? DEFAULT_WORKER_FLEET_LIMITS.maxNestedAgentsPerSession,
			MAX_ORCHESTRATION_AGENT_BINDINGS,
		),
	};
}

/** Descendant routing may preserve or narrow an ancestor's recursive authority, never widen it. */
export function intersectWorkerDelegationLimits(
	requested?: Readonly<OrchestrationDelegationLimits>,
	boundary?: Readonly<OrchestrationDelegationLimits>,
): OrchestrationDelegationLimits | undefined {
	if (!requested && !boundary) return undefined;
	const requestedLimits = resolveWorkerFleetLimits(requested);
	const boundaryLimits = resolveWorkerFleetLimits(boundary);
	return {
		maxDepth: Math.min(requestedLimits.maxDepth, boundaryLimits.maxDepth),
		maxChildrenPerAgent: Math.min(requestedLimits.maxChildrenPerAgent, boundaryLimits.maxChildrenPerAgent),
		maxNestedAgentsPerSession: Math.min(
			requestedLimits.maxNestedAgentsPerSession,
			boundaryLimits.maxNestedAgentsPerSession,
		),
	};
}

export type NewWorkerAdmission =
	| { ok: true; depth: number }
	| {
			ok: false;
			reasonCode:
				| "worker_agent_parent_unknown"
				| "worker_agent_parent_retired"
				| "worker_agent_depth_limit_reached"
				| "worker_agent_child_limit_reached"
				| "worker_agent_nested_session_limit_reached"
				| "worker_agent_session_limit_reached";
	  };

export type WorkerIdentityHeadroomAdmission =
	| { ok: true }
	| { ok: false; reasonCode: "worker_agent_session_limit_reached" };

/** Subjects whose admitted verifier identity has not yet been materialized. */
export function pendingVerifierSubjectTaskIds(
	snapshot: Pick<TaskRuntimeProjection, "agents" | "tasks" | "attempts">,
): Set<string> {
	const agents = snapshot.agents ?? {};
	const tasks = snapshot.tasks ?? {};
	const attempts = snapshot.attempts ?? {};
	const pending = new Set<string>();
	for (const taskId in tasks) {
		if (!Object.hasOwn(tasks, taskId)) continue;
		const subject = tasks[taskId];
		if (!subject || subject.verification) continue;
		let attempt: AttemptRuntimeState | undefined;
		for (let index = subject.attemptIds.length - 1; index >= 0; index -= 1) {
			attempt = attempts[subject.attemptIds[index]!];
			if (attempt) break;
		}
		if (!attempt?.dispatch.executionContract?.verifier) continue;
		if (
			attempt.status === "queued" ||
			attempt.status === "leased" ||
			attempt.status === "running" ||
			attempt.status === "suspended" ||
			attempt.result?.nextAction === "independent_verification_required"
		) {
			pending.add(subject.task.taskId);
		}
	}
	if (pending.size === 0) return pending;
	for (const taskId in tasks) {
		if (!Object.hasOwn(tasks, taskId)) continue;
		const verifierTask = tasks[taskId];
		const verificationOfTaskId = verifierTask?.task.verificationOfTaskId;
		if (!verifierTask || !verificationOfTaskId || !pending.has(verificationOfTaskId)) continue;
		let verifierAttempt: AttemptRuntimeState | undefined;
		for (let index = verifierTask.attemptIds.length - 1; index >= 0; index -= 1) {
			verifierAttempt = attempts[verifierTask.attemptIds[index]!];
			if (verifierAttempt) break;
		}
		const verifierAgentId =
			verifierAttempt?.agentId ?? verifierAttempt?.dispatch.logicalLaneId ?? verifierTask.task.taskId;
		if (agents[verifierAgentId]) pending.delete(verificationOfTaskId);
		if (pending.size === 0) break;
	}
	return pending;
}

/** Reserve durable identity slots without applying parent depth or direct-child limits. */
function evaluateWorkerIdentityHeadroom(
	agents: Readonly<Record<string, AgentBindingContract>>,
	requiredAgentSlots: number,
	limits: Readonly<WorkerFleetLimits> = DEFAULT_WORKER_FLEET_LIMITS,
): WorkerIdentityHeadroomAdmission {
	if (!Number.isSafeInteger(requiredAgentSlots) || requiredAgentSlots < 0) {
		throw new TypeError("requiredAgentSlots must be a non-negative safe integer.");
	}
	return requiredAgentSlots > limits.maxAgentsPerSession - Object.keys(agents).length
		? { ok: false, reasonCode: "worker_agent_session_limit_reached" }
		: { ok: true };
}

/**
 * A persistent-agent turn consumes no implementation identity, but its retained immutable contract
 * can still require a fresh verifier. Protect both that verifier and every earlier reservation.
 */
export function evaluateReusableWorkerTaskAdmission(
	snapshot: Pick<TaskRuntimeProjection, "agents" | "tasks" | "attempts">,
	agentId: string,
	limits: Readonly<WorkerFleetLimits> = DEFAULT_WORKER_FLEET_LIMITS,
): WorkerIdentityHeadroomAdmission {
	const latestAttempt = latestAgentAttemptByDurableOrder(snapshot, agentId);
	const requiredAgentSlots =
		pendingVerifierSubjectTaskIds(snapshot).size + (latestAttempt?.dispatch.executionContract?.verifier ? 1 : 0);
	return evaluateWorkerIdentityHeadroom(snapshot.agents, requiredAgentSlots, limits);
}

/** Evaluate a new durable identity before a task, conversation, or scheduler entry is created. */
export function evaluateNewWorkerAdmission(
	agents: Readonly<Record<string, AgentBindingContract>>,
	parentAgentId?: string,
	limits: Readonly<WorkerFleetLimits> = DEFAULT_WORKER_FLEET_LIMITS,
	requiredAgentSlots = 1,
): NewWorkerAdmission {
	if (!Number.isSafeInteger(requiredAgentSlots) || requiredAgentSlots < 1) {
		throw new TypeError("requiredAgentSlots must be a positive safe integer.");
	}
	const headroom = evaluateWorkerIdentityHeadroom(agents, requiredAgentSlots, limits);
	if (!headroom.ok) return headroom;
	if (!parentAgentId) return { ok: true, depth: 0 };
	const parent = agents[parentAgentId];
	if (!parent) return { ok: false, reasonCode: "worker_agent_parent_unknown" };
	if (parent.status === "retired") return { ok: false, reasonCode: "worker_agent_parent_retired" };
	const depth = parent.depth + 1;
	if (depth > limits.maxDepth) return { ok: false, reasonCode: "worker_agent_depth_limit_reached" };
	let directChildren = 0;
	for (const agent of Object.values(agents)) {
		if (agent.parentAgentId === parent.agentId) directChildren += 1;
	}
	if (directChildren >= limits.maxChildrenPerAgent) {
		return { ok: false, reasonCode: "worker_agent_child_limit_reached" };
	}
	let nestedAgents = 0;
	for (const agent of Object.values(agents)) {
		if (agent.parentAgentId) nestedAgents += 1;
	}
	if (nestedAgents >= limits.maxNestedAgentsPerSession) {
		return { ok: false, reasonCode: "worker_agent_nested_session_limit_reached" };
	}
	return { ok: true, depth };
}

/** Keep one queue slot reserved for an already-admitted mandatory verifier. */
export function workerQueueHasCapacity(
	queuedCount: number,
	priority: boolean,
	limits: Readonly<WorkerFleetLimits> = DEFAULT_WORKER_FLEET_LIMITS,
): boolean {
	if (!Number.isSafeInteger(queuedCount) || queuedCount < 0) return false;
	const ceiling = priority ? limits.maxQueuedDispatches : limits.maxQueuedDispatches - 1;
	return queuedCount < ceiling;
}
