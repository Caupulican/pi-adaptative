/** Reserves a new conversation birth and its durable dispatch under the same capture lock. */
import { isDeepStrictEqual } from "node:util";
import { sameTaskBrief } from "../comms/comms-records.ts";
import type { WorkerContextForkReference } from "../orchestration/worker-context-fork-reference.ts";
import {
	type CaptureAndPrepareWorkerContextForkResult,
	type CaptureWorkerContextForkRequest,
	type WorkerContextForkStore,
	WorkerContextForkStoreError,
} from "./worker-context-fork-store.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import type { WorkerAdmission } from "./worker-fit-route.ts";
import { DEFAULT_WORKER_FLEET_LIMITS } from "./worker-fleet-limits.ts";
import type { WorkerLifecycle } from "./worker-lifecycle.ts";

export function allocateWorkerBirth<T>(
	lifecycle: WorkerLifecycle,
	forks: WorkerContextForkStore,
	request: WorkerDelegationRequest,
	admission: Extract<WorkerAdmission, { ok: true }>,
	birth: Omit<CaptureWorkerContextForkRequest, "logicalAgentId">,
	references: () => WorkerContextForkReference[],
	prepare: (birth: WorkerContextForkReference, taskId: string) => T,
	inScope: (capture: () => CaptureAndPrepareWorkerContextForkResult<T>) => CaptureAndPrepareWorkerContextForkResult<T>,
): T {
	for (let allocation = 0; allocation < DEFAULT_WORKER_FLEET_LIMITS.maxAgentsPerSession; allocation++) {
		const reserved = request.modelTransfer?.successorAgentId;
		const preferred = allocation === 0 ? request.preferredAgentId?.trim() : undefined;
		const snapshotBefore = preferred ? lifecycle.getTaskRuntimeSnapshot() : undefined;
		const preferredAvailable =
			preferred !== undefined &&
			/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(preferred) &&
			snapshotBefore?.tasks[preferred] === undefined &&
			snapshotBefore?.agents[preferred] === undefined;
		const laneId = reserved ?? (preferredAvailable ? preferred : lifecycle.getNextAvailableLaneIdCandidate());
		let proposedReference: WorkerContextForkReference | undefined;
		try {
			const capture = () =>
				forks.captureAndPrepare({
					logicalAgentId: laneId,
					...birth,
					readDurableReferences: references,
					isLogicalIdentityClaimed: () => {
						const snapshot = lifecycle.getTaskRuntimeSnapshot();
						return (
							Boolean(reserved && snapshot.agents[laneId]) ||
							(snapshot.tasks[laneId]?.attemptIds.some(
								(attemptId) => snapshot.attempts[attemptId] !== undefined,
							) ??
								false)
						);
					},
					prepare: (birthContextForkReference) => {
						proposedReference = birthContextForkReference;
						return prepare(birthContextForkReference, request.modelTransfer?.taskId ?? laneId);
					},
				});
			return inScope(capture).value;
		} catch (error) {
			if (reserved) throw error;
			if (error instanceof WorkerContextForkStoreError && error.code === "identity_claimed") continue;
			const snapshot = lifecycle.getTaskRuntimeSnapshot();
			const candidateTask = snapshot.tasks[laneId];
			const candidateAttempts = candidateTask?.attemptIds.map((attemptId) => snapshot.attempts[attemptId]) ?? [];
			const candidateOwnsDurableAttempt = candidateAttempts.some((attempt) => attempt !== undefined);
			const sameRequestReplay = candidateAttempts.some(
				(attempt) =>
					attempt !== undefined &&
					attempt.dispatch.instructions === request.instructions &&
					isDeepStrictEqual(attempt.dispatch.knowledgeReferences ?? [], admission.knowledgeReferences) &&
					isDeepStrictEqual(attempt.dispatch.subscriptions ?? [], admission.subscriptions) &&
					sameTaskBrief(attempt.dispatch.brief, request.brief) &&
					attempt.dispatch.parentAgentId === request.parentAgentId &&
					isDeepStrictEqual(attempt.dispatch.executionContract, admission.executionContract) &&
					(proposedReference === undefined ||
						isDeepStrictEqual(attempt.dispatch.birthContextForkReference, proposedReference)),
			);
			const corruptSnapshot =
				error instanceof WorkerContextForkStoreError &&
				(error.code === "snapshot_corrupt" || error.code === "snapshot_missing");
			const generatedIdWasConcurrentlyClaimed =
				candidateOwnsDurableAttempt && !sameRequestReplay && !corruptSnapshot;
			if (!generatedIdWasConcurrentlyClaimed) throw error;
		}
	}
	throw new Error("Worker logical-agent allocation retries were exhausted.");
}
