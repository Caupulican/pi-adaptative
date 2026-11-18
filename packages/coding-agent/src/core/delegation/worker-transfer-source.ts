/** Source execution and conversation ownership at a durable worker handoff. */
import { isDeepStrictEqual } from "node:util";
import { nativeAgentIdForAttempt } from "../orchestration/attempt-agent-identity.ts";
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import { modelTransferIsPending } from "../orchestration/model-transfer.ts";
import type {
	SpecialistContextClaim,
	SpecialistContextOwnership,
} from "../orchestration/specialist-context-ownership.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { terminalAttemptStatus } from "../orchestration/task-runtime-state.ts";
import { isLocalProcessAlive, isLocalWorkerProcessOwnerProvenDead } from "./worker-process-owner.ts";

export function canControlTransferSource(
	source: AttemptRuntimeState,
	localOwner: string,
	parent: string,
	project: () => { ownership?: SpecialistContextOwnership; held?: SpecialistContextClaim; retired?: boolean },
): boolean {
	const prior = source.lease?.ownerId;
	// Only the process that can signal the running executor may ask it to halt.
	if (source.status === "running" || source.status === "leased") return prior === localOwner;
	if (!prior || prior === localOwner) return true;
	const { ownership, held, retired } = project();
	if (retired && source.modelTransfer?.successorStarted && terminalAttemptStatus(source.status)) return true;
	if (ownership?.state === "busy" && isDeepStrictEqual(ownership.claim, held)) return true;
	if (ownership?.claim.parentSessionId === parent && (ownership.state === "idle" || ownership.state === "handoff"))
		return true; // the earlier owner released only after physical cleanup
	return isLocalWorkerProcessOwnerProvenDead(prior, isLocalProcessAlive);
}

/** Invoked under the transcript lock only for an otherwise-busy claim left by a proven-dead executor. */
export function assertTransferClaimRecoverable(
	ownership: SpecialistContextOwnership,
	parent: string,
	agent: AgentBindingContract,
	expected: AttemptRuntimeState,
	snapshot: TaskRuntimeProjection,
): void {
	const source = snapshot.attempts[expected.attemptId];
	const transfer = source?.modelTransfer;
	if (
		ownership.state !== "busy" ||
		ownership.claim.parentSessionId !== parent ||
		!source ||
		!transfer ||
		!modelTransferIsPending(transfer) ||
		transfer.commandId !== expected.modelTransfer?.commandId ||
		transfer.sourceAttemptId !== expected.attemptId ||
		transfer.sourceAgentId !== agent.agentId ||
		nativeAgentIdForAttempt(source) !== agent.agentId ||
		source.status !== expected.status ||
		(source.status !== "suspended" && !terminalAttemptStatus(source.status)) ||
		!source.lease ||
		source.lease.ownerId !== ownership.claim.incarnation ||
		!isDeepStrictEqual(source.lease, expected.lease) ||
		!isLocalWorkerProcessOwnerProvenDead(source.lease.ownerId, isLocalProcessAlive) ||
		!isDeepStrictEqual(snapshot.agents[agent.agentId], agent) ||
		(agent.activeAttemptId !== undefined && agent.activeAttemptId !== source.attemptId) ||
		Object.values(snapshot.agents).some(
			(other) => other.agentId !== agent.agentId && other.resumeContext.sessionId === agent.resumeContext.sessionId,
		)
	)
		throw new Error("Cannot recover a handoff source without its exact settled, dead-owner generation.");
}
