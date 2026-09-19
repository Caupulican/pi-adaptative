/**
 * System One Steering Plane.
 * Root semantic control plane.
 * Implements S1A-001..S1A-010, S1A-161, S1A-176.
 */

import { createHash, randomUUID } from "node:crypto";
import type { JevAdapter, JevEvaluationResponse } from "../system-one/adapter.ts";
import { SteeringCertificateStore } from "./certificate-store.ts";
import {
	CONSEQUENCE_THRESHOLDS,
	DEFAULT_STEERING_POLICY,
	getPolicyRef,
	PINNED_JEV_MODEL,
	type SteeringPolicyConfig,
} from "./policy.ts";
import { findPackForCheckpoint, getQuestionPackRef } from "./programs.ts";
import type { SteeringCertificate, SteeringCheckpointRequest, SteeringDirective, SteeringResult } from "./types.ts";

export class SystemOneSteeringUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SystemOneSteeringUnavailableError";
	}
}

export class SteeringConfidenceTooLowError extends Error {
	readonly checkpointId: string;
	readonly confidence: number;
	readonly required: number;

	constructor(checkpointId: string, confidence: number, required: number) {
		super(`Confidence for checkpoint ${checkpointId} (${confidence}) is below required threshold (${required}).`);
		this.name = "SteeringConfidenceTooLowError";
		this.checkpointId = checkpointId;
		this.confidence = confidence;
		this.required = required;
	}
}

export interface SystemOneSteeringPlaneDeps {
	readonly adapter?: JevAdapter;
	readonly certificates?: SteeringCertificateStore;
	readonly policy?: SteeringPolicyConfig;
	readonly persistentPath?: string;
}

export class SystemOneSteeringPlane {
	readonly certificates: SteeringCertificateStore;
	readonly policy: SteeringPolicyConfig;
	private readonly adapter?: JevAdapter;

	constructor(deps: SystemOneSteeringPlaneDeps = {}) {
		this.certificates = deps.certificates ?? new SteeringCertificateStore(deps.persistentPath);
		this.policy = deps.policy ?? DEFAULT_STEERING_POLICY;
		this.adapter = deps.adapter;
	}

	computeDigest(data: unknown): string {
		return createHash("sha256")
			.update(JSON.stringify(data ?? null))
			.digest("hex");
	}

	/**
	 * Derives a SteeringDirective from the evaluated question pack and answers.
	 */
	private composeDirective(checkpointId: string, answers: Record<string, unknown>): SteeringDirective {
		const reasonCodes: string[] = [];

		// Checkpoint-specific action synthesis
		if (checkpointId === "JEV-004") {
			const completionPlausible = (answers.completion_plausible as { noul?: number })?.noul ?? 0;
			const gapSuspected = (answers.capability_gap_suspected as { noul?: number })?.noul ?? 0;
			const missingWork = (answers.missing_work_class as { choice?: string })?.choice;

			if (completionPlausible >= 0.8) {
				return { action: "completion_candidate", reasonCodes: ["completion_plausible"] };
			}
			if (gapSuspected >= 0.7 || missingWork === "resolve_capability") {
				return { action: "resolve_capability", reasonCodes: ["capability_gap_suspected"] };
			}
			if (missingWork === "investigate") {
				return { action: "investigate", reasonCodes: ["investigation_needed"] };
			}
			if (missingWork === "replan") {
				return { action: "replan", reasonCodes: ["replan_needed"] };
			}
			if (missingWork === "deterministic_verify") {
				return { action: "deterministic_verify", reasonCodes: ["verify_needed"] };
			}
			if (missingWork === "independent_review") {
				return { action: "independent_review", reasonCodes: ["independent_review_needed"] };
			}
			return { action: "implement", reasonCodes: ["work_remaining"] };
		}

		if (checkpointId === "JEV-007" || checkpointId === "JEV-008") {
			const needsCap = (answers.needs_capability as { noul?: number })?.noul ?? 0;
			const gapRemains = (answers.gap_remains as { noul?: number })?.noul ?? 0;
			if (needsCap >= 0.6 || gapRemains >= 0.6) {
				return { action: "synthesize_capability", reasonCodes: ["capability_gap_proven"] };
			}
			return { action: "continue_current_work", reasonCodes: ["existing_capability_adequate"] };
		}

		if (checkpointId === "JEV-010") {
			const adaptationClass = (answers.adaptation_class as { choice?: string })?.choice ?? "ephemeral_script";
			return {
				action: "synthesize_capability",
				reasonCodes: [`adaptation_level_${adaptationClass}`],
				metadata: { adaptationClass },
			};
		}

		if (checkpointId === "JEV-013" || checkpointId === "JEV-014") {
			const fulfilled = (answers.spec_fulfilled as { noul?: number })?.noul ?? 1;
			if (fulfilled >= 0.7) {
				return { action: "activate_capability", reasonCodes: ["pre_activation_verified"] };
			}
			return { action: "repair_capability", reasonCodes: ["spec_not_fulfilled"] };
		}

		if (checkpointId === "JEV-024") {
			const completionPlausible = (answers.completion_plausible as { noul?: number })?.noul ?? 0;
			if (completionPlausible >= 0.75) {
				return { action: "completion_candidate", reasonCodes: ["completion_plausible"] };
			}
			return { action: "continue_current_work", reasonCodes: ["work_remaining"] };
		}

		if (checkpointId === "JEV-040") {
			const lowest = (answers.lowest_adequate_adaptation as { choice?: string })?.choice ?? "strategy";
			if (lowest === "expert_reroute") {
				return { action: "reroute_expert", reasonCodes: ["expert_reroute_selected"] };
			}
			if (lowest === "specialist") {
				return {
					action: "resolve_capability",
					reasonCodes: ["specialist_synthesis_selected"],
					metadata: { dimension: "specialist" },
				};
			}
			if (lowest === "capability") {
				return {
					action: "resolve_capability",
					reasonCodes: ["capability_synthesis_selected"],
					metadata: { dimension: "capability" },
				};
			}
			if (lowest === "runtime") {
				return {
					action: "synthesize_capability",
					reasonCodes: ["runtime_patch_selected"],
					metadata: { dimension: "runtime" },
				};
			}
			return { action: "replan", reasonCodes: ["strategy_adaptation_selected"] };
		}

		if (checkpointId === "JEV-041" || checkpointId === "JEV-042") {
			const disposition = (answers.recommended_disposition as { choice?: string })?.choice ?? "unique";
			if (disposition === "insufficient_evidence") {
				return { action: "retrieve_more", reasonCodes: ["insufficient_evidence"] };
			}
			return {
				action: "continue_current_work",
				reasonCodes: [`disposition_${disposition}`],
				metadata: { disposition },
			};
		}

		return { action: "continue_current_work", reasonCodes };
	}

	/**
	 * Evaluates a checkpoint request and produces or reuses a SteeringCertificate.
	 */
	async evaluate(request: SteeringCheckpointRequest): Promise<SteeringResult> {
		const pack = findPackForCheckpoint(request.checkpointId);
		if (!pack) {
			throw new Error(`No question pack found for checkpoint ${request.checkpointId}`);
		}

		const stateDigest = this.computeDigest(request.state);

		// S1A-007: Check if a fresh certificate already exists for this exact state and evidence revision
		const existing = this.certificates.findCurrent(
			request.objectiveId,
			request.checkpointId,
			stateDigest,
			request.evidenceRevision,
		);
		if (existing) {
			const directive = this.composeDirective(request.checkpointId, existing.answers);
			return { certificate: existing, directive };
		}

		// S1A-008 / S1A-009: Pinned Jev model must be used
		const model = this.policy.model.id || PINNED_JEV_MODEL;
		const consequence = request.consequence ?? "medium";
		const thresholds = CONSEQUENCE_THRESHOLDS[consequence];

		let evaluationResponse: JevEvaluationResponse;

		if (this.adapter) {
			try {
				evaluationResponse = await this.adapter.evaluate(
					{
						model,
						state: {
							checkpointId: request.checkpointId,
							objectiveId: request.objectiveId,
							state: request.state,
						},
						questions: Object.fromEntries(pack.questions.map((q) => [q.id, { description: q.description }])),
					},
					{ impact: "read_only" },
				);
			} catch (err: unknown) {
				if (this.policy.mode === "system_one_required") {
					throw new SystemOneSteeringUnavailableError(
						`Jev steering unavailable for mandatory checkpoint ${request.checkpointId}: ${String(err)}`,
					);
				}
				throw err;
			}
		} else {
			// Fail-closed if system_one_required and no adapter
			if (this.policy.mode === "system_one_required") {
				throw new SystemOneSteeringUnavailableError(
					`Jev adapter missing for mandatory checkpoint ${request.checkpointId} in system_one_required mode.`,
				);
			}
			// Synthetic fallback only if not system_one_required
			evaluationResponse = {
				model,
				latency_ms: 0,
				answers: {},
			};
		}

		const answers = evaluationResponse.answers ?? {};

		// Validate confidence against consequence threshold
		const overallConfidence = (answers._confidence as number | undefined) ?? 1.0;
		if (overallConfidence < thresholds.minimumConfidence) {
			// S1A-010: No human fallback on low confidence
			throw new SteeringConfidenceTooLowError(request.checkpointId, overallConfidence, thresholds.minimumConfidence);
		}

		const directive = this.composeDirective(request.checkpointId, answers);

		const certificate: SteeringCertificate = {
			schema_version: "1.0",
			certificate_id: `SCERT-${request.checkpointId}-${Date.now()}-${randomUUID().slice(0, 8)}`,
			objective_id: request.objectiveId,
			task_id: request.taskId ?? null,
			work_unit_id: request.workUnitId ?? null,
			checkpoint_id: request.checkpointId,
			state_digest: stateDigest,
			evidence_revision: request.evidenceRevision,
			policy: getPolicyRef(this.policy),
			question_pack: getQuestionPackRef(pack),
			engine: {
				provider: this.policy.model.provider,
				model,
			},
			answers,
			directive: directive.action,
			policy_result: "accepted",
			parent_certificate_ids: request.parentCertificateIds ? [...request.parentCertificateIds] : undefined,
			usage: evaluationResponse.usage as Record<string, unknown> | undefined,
			created_at: new Date().toISOString(),
		};

		await this.certificates.persist(certificate);

		return { certificate, directive };
	}

	/**
	 * Convenience helper: require a certificate or evaluate fresh.
	 */
	async requireCertificate(
		checkpointId: string,
		state: unknown,
		options: {
			objectiveId?: string;
			taskId?: string;
			workUnitId?: string;
			evidenceRevision?: number;
			consequence?: "low" | "medium" | "high" | "critical";
			parentCertificateIds?: readonly string[];
			signal?: AbortSignal;
		} = {},
	): Promise<SteeringCertificate> {
		if (options.signal?.aborted) {
			throw new Error(`Steering evaluation aborted for ${checkpointId}`);
		}

		const objectiveId = options.objectiveId ?? "obj_default";
		const evidenceRevision = options.evidenceRevision ?? 1;

		const result = await this.evaluate({
			checkpointId,
			objectiveId,
			taskId: options.taskId,
			workUnitId: options.workUnitId,
			state,
			evidenceRevision,
			consequence: options.consequence,
			parentCertificateIds: options.parentCertificateIds,
		});

		return result.certificate;
	}
}
