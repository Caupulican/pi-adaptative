import { isDeepStrictEqual } from "node:util";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import type { SpecialistContextOwnership } from "../orchestration/specialist-context-ownership.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { isLocalProcessAlive, isLocalWorkerProcessOwnerProvenDead } from "./worker-process-owner.ts";

/**
 * Initial queued work has never held an execution lease, so its dead parent cannot have left tools
 * running. Read the projection inside the transcript claim lock: a competing executor must acquire
 * that same claim before it can lease this task. Suspended/previously leased turns require their own
 * resource-cleanup evidence and are deliberately excluded.
 */
export function assertQueuedWorkerContextRecoverable(
	ownership: SpecialistContextOwnership,
	parentSessionId: string,
	agent: AgentBindingContract,
	snapshot: TaskRuntimeProjection,
): void {
	const bindings = Object.values(snapshot.agents).filter(
		(candidate) => candidate.resumeContext.sessionId === agent.resumeContext.sessionId,
	);
	const task = snapshot.tasks[agent.agentId];
	const attempt = task?.attemptIds.length === 1 ? snapshot.attempts[task.attemptIds[0]] : undefined;
	if (
		ownership.state !== "busy" ||
		ownership.claim.parentSessionId !== parentSessionId ||
		!isLocalWorkerProcessOwnerProvenDead(ownership.claim.incarnation, isLocalProcessAlive) ||
		bindings.length !== 1 ||
		!isDeepStrictEqual(bindings[0], agent) ||
		agent.status !== "registered" ||
		agent.activeAttemptId !== undefined ||
		agent.contextOrigin !== undefined ||
		!attempt ||
		attempt.status !== "queued" ||
		attempt.lease !== undefined ||
		attempt.agentId !== undefined ||
		attempt.dispatch.logicalLaneId !== agent.agentId ||
		attempt.dispatch.executionKind === "managed-process" ||
		Object.values(snapshot.attempts).some(
			(candidate) =>
				candidate.attemptId !== attempt.attemptId &&
				(candidate.agentId === agent.agentId || candidate.dispatch.logicalLaneId === agent.agentId),
		)
	)
		throw new Error("Worker queued context has no proof of never-started, dead-owner recovery.");
}
