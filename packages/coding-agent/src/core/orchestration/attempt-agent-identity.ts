import type { OrchestrationDispatchRequest } from "./contracts.ts";
import { DurableTaskRuntimeError } from "./task-runtime-state.ts";

interface AttemptAgentIdentity {
	readonly agentId?: string;
	readonly dispatch: Pick<OrchestrationDispatchRequest, "executionKind" | "logicalLaneId">;
}

/** The native agent owning a bound attempt, or the intended agent of a queued native turn. */
export function nativeAgentIdForAttempt(attempt: AttemptAgentIdentity): string | undefined {
	// A managed logical lane has a separate namespace, even when its name matches a native agent.
	if (attempt.dispatch.executionKind === "managed-process") return undefined;
	return attempt.agentId ?? attempt.dispatch.logicalLaneId;
}

/** Command, event replay and snapshot restore enforce the same native binding boundary. */
export function assertAttemptAgentBinding(attempt: AttemptAgentIdentity): void {
	if (attempt.agentId !== undefined && nativeAgentIdForAttempt(attempt) !== attempt.agentId)
		throw new DurableTaskRuntimeError("A managed process cannot lease a native agent binding.");
}
