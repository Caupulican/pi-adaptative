/**
 * What a watch reads about the worker runtime that armed it, from the session's durable task state, so it holds across a
 * restart: whether the runtime can still be woken (it exists, it was not retired, and its latest attempt was not cancelled;
 * retiring or cancelling a worker ends what it was waiting for, so its watches go with it), and whether its conversation
 * carries a third party's words now.
 */
import { conversationTurnOrigin } from "../orchestration/attempt-agent-identity.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";

export function workerRuntimeLive(
	snapshot: Pick<TaskRuntimeProjection, "agents" | "attempts">,
	runtimeId: string,
): boolean {
	const agent = snapshot.agents[runtimeId];
	if (!agent || agent.status === "retired") return false;
	let latest: string | undefined;
	for (const attempt of Object.values(snapshot.attempts)) if (attempt.agentId === runtimeId) latest = attempt.status;
	return latest !== "cancelled";
}

/**
 * Whether the runtime's conversation carries a third party's words: any of its attempts does, as its own gate reads each one
 * (`conversationTurnOrigin`), or the turns it released did. A steer can bring them after a watch was armed, so a watch reads
 * this at every check.
 */
export function workerRuntimeCarriesThirdPartyWords(
	snapshot: Pick<TaskRuntimeProjection, "agents" | "attempts">,
	runtimeId: string,
): boolean {
	if (snapshot.agents[runtimeId]?.prunedTurns?.conversationTurnOrigin?.thirdParty === true) return true;
	return Object.values(snapshot.attempts).some(
		(attempt) => attempt.agentId === runtimeId && conversationTurnOrigin(snapshot, attempt)?.thirdParty === true,
	);
}
