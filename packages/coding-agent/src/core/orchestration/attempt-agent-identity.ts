import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { OrchestrationDispatchRequest } from "./contracts.ts";
import { type AttemptRuntimeState, attemptTurnOrigin, DurableTaskRuntimeError } from "./task-runtime-state.ts";

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

/**
 * The origin the attempt's conversation carries: its own (`attemptTurnOrigin`), else a third party's words another
 * attempt of the same native agent admitted, since that agent's conversation keeps every word an attempt read.
 */
export function conversationTurnOrigin(
	attempts: Readonly<Record<string, AttemptRuntimeState>>,
	attempt: AttemptRuntimeState,
): TurnOriginRecord | undefined {
	const own = attemptTurnOrigin(attempt);
	const agentId = nativeAgentIdForAttempt(attempt);
	if (own?.thirdParty || agentId === undefined) return own;
	for (const candidate of Object.values(attempts)) {
		if (candidate.admittedTurnOrigin && nativeAgentIdForAttempt(candidate) === agentId)
			return candidate.admittedTurnOrigin;
	}
	return own;
}
