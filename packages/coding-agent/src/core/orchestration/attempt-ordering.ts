import type { AttemptRuntimeState, TaskRuntimeProjection } from "./task-runtime.ts";

/**
 * Project the latest logical-agent attempt from the attempt projection's durable insertion order.
 * Event replay appends every new attempt to this record, including a retry queued against an older
 * task, so task grouping, UUID spelling, and tied clocks never participate in lifecycle selection.
 */
const latestAttemptsMemo = new WeakMap<object, ReadonlyMap<string, AttemptRuntimeState>>();

export function latestAgentAttemptsByDurableOrder(
	snapshot: Pick<TaskRuntimeProjection, "agents" | "attempts">,
): ReadonlyMap<string, AttemptRuntimeState> {
	// A frozen snapshot is immutable (the runtime deep-freezes what it shares), so the derived map
	// is memoized on its identity; an unfrozen literal is scanned on every call.
	const immutable = Object.isFrozen(snapshot);
	const cached = immutable ? latestAttemptsMemo.get(snapshot) : undefined;
	if (cached) return cached;
	const latest = new Map<string, AttemptRuntimeState>();
	const agents = snapshot.agents ?? {};
	const attempts = snapshot.attempts ?? {};
	for (const attempt of Object.values(attempts)) {
		const agentId = attempt.agentId ?? attempt.dispatch.logicalLaneId;
		if (agentId && agents[agentId]) latest.set(agentId, attempt);
	}
	// The binding is the authoritative live lease owner. Prefer it when a recovered legacy snapshot
	// contains a later terminal attempt after an older attempt was suspended and resumed in place.
	for (const agent of Object.values(agents)) {
		if (!agent.activeAttemptId) continue;
		const activeAttempt = attempts[agent.activeAttemptId];
		if (activeAttempt) latest.set(agent.agentId, activeAttempt);
	}
	if (immutable) latestAttemptsMemo.set(snapshot, latest);
	return latest;
}

export function latestAgentAttemptByDurableOrder(
	snapshot: Pick<TaskRuntimeProjection, "agents" | "attempts">,
	agentId: string,
): AttemptRuntimeState | undefined {
	return latestAgentAttemptsByDurableOrder(snapshot).get(agentId);
}
