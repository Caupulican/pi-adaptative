/** Observable ownership at worker-controller teardown and resource inspection. */
import type { AgentBindingContract } from "../orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../orchestration/delegation-ledger.ts";
import type { SpecialistContextClaim } from "../orchestration/specialist-context-ownership.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import type { RetainedReleaseSnapshot } from "../util/resource-release.ts";
import type { WorkerAgentMailboxResourceSnapshot } from "./worker-agent-control.ts";
import type { WorkerAgentControlResourceSnapshot } from "./worker-agent-control-coordinator.ts";
import type { WorkerDispatchResourceSnapshot } from "./worker-dispatch-scheduler.ts";
import type { WorkerWriteReservationResourceSnapshot } from "./worker-write-reservation-coordinator.ts";

export interface WorkerDelegationResourceSnapshot {
	readonly ingressPromiseCount: number;
	readonly executionPromiseCount: number;
	readonly pendingPhysicalCleanups: readonly Readonly<
		Pick<StartedDelegationAttempt, "attemptId" | "leaseId" | "fencingToken">
	>[];
	readonly executingHolds: readonly { readonly agentId: string; readonly count: number }[];
	readonly inFlightLedgerCount: number;
	readonly laneAbortControllerCount: number;
	readonly shellSessionCount: number;
	readonly pendingTerminalHandoffCount: number;
	readonly scheduler: WorkerDispatchResourceSnapshot;
	readonly reservations: WorkerWriteReservationResourceSnapshot;
	/** Execution teardowns and project releases that failed and are retried on the release backoff. */
	readonly retainedReleases: RetainedReleaseSnapshot;
	readonly control: WorkerAgentControlResourceSnapshot;
	readonly ownedProjectClaims: readonly {
		readonly sessionId: string;
		readonly claim: Readonly<SpecialistContextClaim>;
		readonly agents: readonly {
			readonly agentId: string;
			readonly agentStatus: AgentBindingContract["status"];
			readonly attemptId: string | undefined;
			readonly attemptStatus: AttemptRuntimeState["status"] | undefined;
			readonly executingHoldCount: number;
			readonly mailboxLoaded: boolean;
			readonly mailbox: WorkerAgentMailboxResourceSnapshot | undefined;
		}[];
	}[];
}
