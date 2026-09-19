/**
 * Worker Steering Adapter.
 * Integrates subagents and workers into the root-owned steering plane.
 * Implements S1A-161..S1A-176, WorkerExecutionContract boundaries, and start_only orchestrator reviews.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
	SteeringMissionContext,
	SteeringMissionReference,
	WorkerSteeringMission,
	WorkerSteeringMissionWorkClass,
} from "./types.ts";

export interface WorkerDispatchPreparationInput {
	readonly objectiveId: string;
	readonly taskId: string;
	readonly workClass: WorkerSteeringMissionWorkClass;
	readonly certificateIds: readonly string[];
	readonly proofObligations: readonly string[];
	readonly canonicalStateDigest: string;
	readonly requirementIds?: readonly string[];
	readonly hypothesisIds?: readonly string[];
	readonly capabilityGapId?: string | null;
	readonly capabilitySpecId?: string | null;
	readonly contextSubset?: Record<string, unknown>;
}

export interface WorkerRawResult {
	readonly attemptId: string;
	readonly outcome?: string;
	readonly reasonCode?: string;
	readonly claims?: readonly string[];
	readonly changedFiles?: readonly string[];
	readonly artifacts?: readonly Record<string, unknown>[];
	readonly failureReason?: string;
}

export interface NormalizedWorkerEvidence {
	readonly attemptId: string;
	readonly missionId: string;
	readonly outcome: string;
	readonly isOrchestratorReview: boolean;
	readonly verifiedArtifactHashes: readonly string[];
	readonly rawResult: WorkerRawResult;
	readonly ingestedAt: string;
}

export class WorkerSteeringAdapter {
	private readonly missions = new Map<string, WorkerSteeringMission>();

	computeDigest(data: unknown): string {
		return createHash("sha256")
			.update(JSON.stringify(data ?? null))
			.digest("hex");
	}

	/**
	 * Prepares an immutable mission packet for a worker dispatch.
	 * S1A-162: Worker missions reference steering certificates.
	 */
	async prepareDispatch(input: WorkerDispatchPreparationInput): Promise<{
		mission: SteeringMissionContext;
		missionRef: SteeringMissionReference;
		missionRecord: WorkerSteeringMission;
	}> {
		const missionId = `WSM-${Date.now()}-${randomUUID().slice(0, 8)}`;

		const missionRecord: WorkerSteeringMission = {
			schema_version: "1.0",
			mission_id: missionId,
			objective_id: input.objectiveId,
			task_id: input.taskId,
			work_class: input.workClass,
			steering_certificate_ids: [...input.certificateIds],
			steering_state_digest: input.canonicalStateDigest,
			requirement_ids: input.requirementIds ? [...input.requirementIds] : undefined,
			hypothesis_ids: input.hypothesisIds ? [...input.hypothesisIds] : undefined,
			proof_obligations: [...input.proofObligations],
			capability_gap_id: input.capabilityGapId ?? null,
			capability_spec_id: input.capabilitySpecId ?? null,
		};

		this.missions.set(missionId, missionRecord);
		const digest = this.computeDigest(missionRecord);

		const mission: SteeringMissionContext = {
			missionId,
			objectiveId: input.objectiveId,
			taskId: input.taskId,
			workClass: input.workClass,
			proofObligations: [...input.proofObligations],
			certificateRefs: [...input.certificateIds],
			stateDigest: input.canonicalStateDigest,
			contextSubset: input.contextSubset,
		};

		const missionRef: SteeringMissionReference = {
			missionId,
			digest,
			steeringCertificateIds: [...input.certificateIds],
		};

		return { mission, missionRef, missionRecord };
	}

	/**
	 * Ingests a worker's result, normalizes evidence, and converts worker ask-user signals
	 * into root orchestrator reviews in start_only mode.
	 * S1A-166, S1A-167, S1A-171, S1A-172.
	 */
	async ingestResult(input: {
		attemptId: string;
		missionRef: SteeringMissionReference;
		result: WorkerRawResult;
		startOnlyMode?: boolean;
	}): Promise<NormalizedWorkerEvidence> {
		const isStartOnly = input.startOnlyMode ?? true;

		// S1A-167: In start_only mode, worker ask-user / parent_review_required
		// becomes orchestrator_review_required. It is NEVER emitted as a user prompt.
		let outcome = input.result.outcome ?? "success";
		let isOrchestratorReview = false;

		if (isStartOnly && (outcome === "ask-user" || input.result.reasonCode === "parent_review_required")) {
			outcome = "orchestrator_review_required";
			isOrchestratorReview = true;
		}

		// Compute verified artifact hashes
		const verifiedArtifactHashes: string[] = [];
		if (input.result.artifacts) {
			for (const artifact of input.result.artifacts) {
				verifiedArtifactHashes.push(this.computeDigest(artifact));
			}
		}

		return {
			attemptId: input.attemptId,
			missionId: input.missionRef.missionId,
			outcome,
			isOrchestratorReview,
			verifiedArtifactHashes,
			rawResult: input.result,
			ingestedAt: new Date().toISOString(),
		};
	}

	getMission(missionId: string): WorkerSteeringMission | undefined {
		return this.missions.get(missionId);
	}
}
