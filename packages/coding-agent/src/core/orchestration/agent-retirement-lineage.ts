/** Lineage constraints shared by worker retirement and durable model transfer admission. */
import { DurableTaskRuntimeError, type TaskRuntimeProjection, terminalAttemptStatus } from "./task-runtime-state.ts";

/** Memoize each ancestor walk so a tall worker tree still takes linear time to check. */
export function assertAgentHasNoLiveDescendant(state: TaskRuntimeProjection, agentId: string): void {
	const known = new Map<string, boolean>([[agentId, true]]);
	for (const candidate of Object.values(state.agents)) {
		if (candidate.status === "retired" || candidate.agentId === agentId) continue;
		const path = new Set<string>();
		let parentId = candidate.parentAgentId;
		while (parentId && !known.has(parentId)) {
			if (path.has(parentId))
				throw new DurableTaskRuntimeError(`Agent '${candidate.agentId}' lineage contains a cycle.`);
			path.add(parentId);
			parentId = state.agents[parentId]?.parentAgentId;
		}
		if (parentId && known.get(parentId))
			throw new DurableTaskRuntimeError(`Agent '${agentId}' has non-retired descendant '${candidate.agentId}'.`);
		for (const visited of path) known.set(visited, false);
		known.set(candidate.agentId, false);
	}
}

export function assertTransferHasNoDependentWork(state: TaskRuntimeProjection, agentId: string): void {
	assertAgentHasNoLiveDescendant(state, agentId);
	if (
		Object.values(state.attempts).some(
			(attempt) => attempt.dispatch.parentAgentId === agentId && !terminalAttemptStatus(attempt.status),
		)
	)
		throw new DurableTaskRuntimeError(`Agent '${agentId}' has an unfinished child dispatch.`);
}
