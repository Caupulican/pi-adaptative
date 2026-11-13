/**
 * Whether a worker runtime can still be woken by a watch it armed: it exists, it was not retired, and its latest attempt was
 * not cancelled. Retiring or cancelling a worker ends what it was waiting for, so its watches go with it. Read from the
 * session's durable task state, so the rule holds across a restart.
 */
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
