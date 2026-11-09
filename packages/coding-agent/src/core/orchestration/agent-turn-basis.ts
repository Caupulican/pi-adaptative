/**
 * The turn an agent's next turn is built from: its latest live native attempt, or, once retention released that attempt,
 * the basis its binding carries (`prunedTurns.last`). Readers of an agent's latest turn for its dispatch, identity, turn
 * count or origin go through here, so a released turn reads the same as a live one. Readers of status or lease keep the
 * live attempt: an agent with no live attempt has no running turn.
 */

import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import { conversationTurnOrigin, nativeAgentIdForAttempt } from "./attempt-agent-identity.ts";
import { latestAgentAttemptByDurableOrder } from "./attempt-ordering.ts";
import type { AttemptStatus, OrchestrationDispatchRequest } from "./contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "./task-runtime-state.ts";

/** The projection fields a turn basis reads: narrower than a full projection, so each snapshot passes what it holds. */
export type AgentTurnProjection = Pick<TaskRuntimeProjection, "agents" | "attempts" | "objectives" | "tasks">;

export interface AgentTurnBasis {
	/** True while the attempt is in the projection; false once retention released it and only the carry remains. */
	readonly live: boolean;
	/** The live attempt, present only when `live`. */
	readonly attempt?: AttemptRuntimeState;
	readonly attemptId: string;
	readonly taskId: string;
	/** Undefined when the objective is gone, which is always the case after an objective prune. */
	readonly objectiveId: string | undefined;
	readonly status: AttemptStatus;
	readonly dispatch: OrchestrationDispatchRequest;
	/** The task's criteria: the live task's, or the ones the released task named when the basis is carried. */
	readonly acceptanceCriterionIds: readonly string[];
}

/** The turn an agent's next turn is built from: its latest live native attempt, else the carried basis. */
export function agentTurnBasis(state: AgentTurnProjection, agentId: string): AgentTurnBasis | undefined {
	const latest = latestAgentAttemptByDurableOrder(state, agentId);
	if (latest) {
		const task = state.tasks[latest.taskId]?.task;
		return {
			live: true,
			attempt: latest,
			attemptId: latest.attemptId,
			taskId: latest.taskId,
			objectiveId: task && state.objectives[task.objectiveId] ? task.objectiveId : undefined,
			status: latest.status,
			dispatch: latest.dispatch,
			acceptanceCriterionIds: task?.acceptanceCriterionIds ?? [],
		};
	}
	const last = state.agents[agentId]?.prunedTurns?.last;
	if (!last) return undefined;
	return {
		live: false,
		attemptId: last.attemptId,
		taskId: last.taskId,
		objectiveId: state.objectives[last.objectiveId] ? last.objectiveId : undefined,
		status: last.status,
		dispatch: last.dispatch,
		acceptanceCriterionIds: last.acceptanceCriterionIds,
	};
}

/** The dispatch an agent's next turn is built from, live or carried past retention. */
export function agentTurnDispatch(
	state: Pick<AgentTurnProjection, "agents" | "attempts">,
	agentId: string,
): OrchestrationDispatchRequest | undefined {
	return (latestAgentAttemptByDurableOrder(state, agentId) ?? state.agents[agentId]?.prunedTurns?.last)?.dispatch;
}

/** The native turns an agent has taken: the ones retention released, plus its live native attempts. */
export function agentNativeTurnCount(state: Pick<AgentTurnProjection, "agents" | "attempts">, agentId: string): number {
	let live = 0;
	for (const attempt of Object.values(state.attempts)) {
		if (nativeAgentIdForAttempt(attempt) === agentId) live += 1;
	}
	return (state.agents[agentId]?.prunedTurns?.count ?? 0) + live;
}

/**
 * The origin an agent's next turn carries, given the basis it is built from. A live basis reads the conversation origin
 * of its attempt. A carried basis reads the third-party origin its released turns left: its own when that is third-party,
 * else the earliest one the binding carries, else its own.
 */
export function agentBasisTurnOrigin(
	state: Pick<AgentTurnProjection, "agents" | "attempts">,
	agentId: string,
	basis: AgentTurnBasis,
): TurnOriginRecord | undefined {
	if (basis.attempt) return conversationTurnOrigin(state, basis.attempt);
	const carry = state.agents[agentId]?.prunedTurns;
	const own = carry?.last?.ownTurnOrigin;
	if (own?.thirdParty) return own;
	return carry?.conversationTurnOrigin ?? own;
}
