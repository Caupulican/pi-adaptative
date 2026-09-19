/**
 * System One Steering Plane.
 * Root semantic control plane backed by TypeSafe Decision Kernel.
 * Implements S1A-001..S1A-010, S1A-161, S1A-176, PH-001..PH-012.
 */

import { randomUUID } from "node:crypto";
import type { SemanticDecisionEngine } from "../decision/engine.ts";
import type { DecisionEngineRouter } from "../decision/engine-router.ts";
import { TypeSafeSystemOneDecisionEngine } from "../decision/engines/typesafe-system-one-engine.ts";
import type { DecisionEvaluation } from "../decision/evaluation.ts";
import type { DecisionProgram } from "../decision/program.ts";
import type { JevAdapter } from "../system-one/adapter.ts";
import { canonicalDigest } from "./canonical.ts";
import { SteeringCertificateStore } from "./certificate-store.ts";
import {
	CONSEQUENCE_THRESHOLDS,
	computePolicyDigest,
	DEFAULT_STEERING_POLICY,
	PINNED_JEV_MODEL,
	STEERING_POLICY_ID,
	type SteeringPolicyConfig,
} from "./policy.ts";
import { compileDecisionProgramForCheckpoint } from "./programs.ts";
import {
	type SteeringCertificate,
	type SteeringCheckpointRequest,
	type SteeringDirective,
	SteeringProtocolError,
	type SteeringResult,
} from "./types.ts";

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
	readonly decisionEngine?: SemanticDecisionEngine;
	readonly router?: DecisionEngineRouter;
	readonly adapter?: JevAdapter;
	readonly certificates?: SteeringCertificateStore;
	readonly policy?: SteeringPolicyConfig;
	readonly persistentPath?: string;
}

export class SystemOneSteeringPlane {
	readonly certificates: SteeringCertificateStore;
	readonly policy: SteeringPolicyConfig;
	readonly decisionEngine?: SemanticDecisionEngine;
	readonly router?: DecisionEngineRouter;
	private readonly adapter?: JevAdapter;

	constructor(deps: SystemOneSteeringPlaneDeps = {}) {
		this.certificates = deps.certificates ?? new SteeringCertificateStore(deps.persistentPath);
		this.policy = deps.policy ?? DEFAULT_STEERING_POLICY;
		this.adapter = deps.adapter;
		this.router = deps.router;

		if (deps.decisionEngine) {
			this.decisionEngine = deps.decisionEngine;
		} else if (deps.adapter) {
			const model = this.policy.model.id || PINNED_JEV_MODEL;
			this.decisionEngine = new TypeSafeSystemOneDecisionEngine(deps.adapter, model);
		}
	}

	computeDigest(data: unknown): string {
		return canonicalDigest(data);
	}

	/**
	 * Derives a SteeringDirective from the evaluated question pack and answers.
	 * Checks checkpoint pass predicates and rejects missing answers.
	 */
	private composeDirective(
		checkpointId: string,
		answers: Record<string, unknown>,
		_program: DecisionProgram,
	): SteeringDirective {
		const reasonCodes: string[] = [];

		if (checkpointId === "JEV-004") {
			const completionAns = answers.completion_plausible as { noul?: number } | undefined;
			const gapAns = answers.capability_gap_suspected as { noul?: number } | undefined;
			const missingWorkAns = answers.missing_work_class as { choice?: string } | undefined;

			if (completionAns?.noul == null || gapAns?.noul == null || !missingWorkAns?.choice) {
				throw new SteeringProtocolError(
					`Checkpoint ${checkpointId} missing required answers for directive composition`,
					checkpointId,
					answers,
				);
			}

			const completionPlausible = completionAns.noul;
			const gapSuspected = gapAns.noul;
			const missingWork = missingWorkAns.choice;

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
			const needsCapAns = answers.needs_capability as { noul?: number } | undefined;
			const gapRemainsAns = answers.gap_remains as { noul?: number } | undefined;

			if (checkpointId === "JEV-007" && needsCapAns?.noul == null) {
				throw new SteeringProtocolError("Checkpoint JEV-007 missing needs_capability answer", checkpointId);
			}
			if (checkpointId === "JEV-008" && gapRemainsAns?.noul == null) {
				throw new SteeringProtocolError("Checkpoint JEV-008 missing gap_remains answer", checkpointId);
			}

			const needsCap = needsCapAns?.noul ?? 0;
			const gapRemains = gapRemainsAns?.noul ?? 0;

			if (needsCap >= 0.6 || gapRemains >= 0.6) {
				return { action: "synthesize_capability", reasonCodes: ["capability_gap_proven"] };
			}
			return { action: "continue_current_work", reasonCodes: ["existing_capability_adequate"] };
		}

		if (checkpointId === "JEV-010") {
			const adaptationAns = answers.adaptation_class as { choice?: string } | undefined;
			if (!adaptationAns?.choice) {
				throw new SteeringProtocolError("Checkpoint JEV-010 missing adaptation_class answer", checkpointId);
			}
			const adaptationClass = adaptationAns.choice;
			return {
				action: "synthesize_capability",
				reasonCodes: [`adaptation_level_${adaptationClass}`],
				metadata: { adaptationClass },
			};
		}

		if (checkpointId === "JEV-013" || checkpointId === "JEV-014") {
			const fulfilledAns = answers.spec_fulfilled as { noul?: number } | undefined;
			if (checkpointId === "JEV-013" && fulfilledAns?.noul == null) {
				throw new SteeringProtocolError("Checkpoint JEV-013 missing spec_fulfilled answer", checkpointId);
			}
			const fulfilled = fulfilledAns?.noul ?? 0;
			if (fulfilled >= 0.7) {
				return { action: "activate_capability", reasonCodes: ["pre_activation_verified"] };
			}
			return { action: "repair_capability", reasonCodes: ["spec_not_fulfilled"] };
		}

		if (checkpointId === "JEV-024") {
			const completionAns = answers.completion_plausible as { noul?: number } | undefined;
			if (completionAns?.noul == null) {
				throw new SteeringProtocolError("Checkpoint JEV-024 missing completion_plausible answer", checkpointId);
			}
			if (completionAns.noul >= 0.75) {
				return { action: "completion_candidate", reasonCodes: ["completion_plausible"] };
			}
			return { action: "continue_current_work", reasonCodes: ["work_remaining"] };
		}

		if (checkpointId === "JEV-040") {
			const lowestAns = answers.lowest_adequate_adaptation as { choice?: string } | undefined;
			if (!lowestAns?.choice) {
				throw new SteeringProtocolError(
					"Checkpoint JEV-040 missing lowest_adequate_adaptation answer",
					checkpointId,
				);
			}
			const lowest = lowestAns.choice;
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
			const dispositionAns = answers.recommended_disposition as { choice?: string } | undefined;
			if (checkpointId === "JEV-042" && !dispositionAns?.choice) {
				throw new SteeringProtocolError("Checkpoint JEV-042 missing recommended_disposition answer", checkpointId);
			}
			const disposition = dispositionAns?.choice ?? "unique";
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
	 * Implements PH-001..PH-012, PH-020..PH-028.
	 */
	async evaluate(request: SteeringCheckpointRequest): Promise<SteeringResult> {
		const stateDigest = canonicalDigest(request.state);
		const program = compileDecisionProgramForCheckpoint(request.checkpointId, request.state);
		const programDigest = canonicalDigest(program);
		const policyDigest = computePolicyDigest(this.policy);

		const model = this.policy.model.id || PINNED_JEV_MODEL;
		const provider = this.policy.model.provider || "typesafe";
		const consequence = request.consequence ?? "medium";
		const thresholds = CONSEQUENCE_THRESHOLDS[consequence];

		// Check if a fresh certificate already exists in cache with full key binding
		const existing = this.certificates.findCurrent({
			objectiveId: request.objectiveId,
			checkpointId: request.checkpointId,
			stateDigest,
			evidenceRevision: request.evidenceRevision,
			policyDigest,
			programDigest,
			provider,
			model,
		});
		if (existing) {
			const directive = this.composeDirective(request.checkpointId, existing.answers, program);
			return { certificate: existing, directive };
		}

		let evaluation: DecisionEvaluation;

		if (this.router) {
			try {
				evaluation = await this.router.evaluateOrFallback(program, request.state, { consequence });
			} catch (err) {
				if (this.policy.mode === "system_one_required") {
					throw new SystemOneSteeringUnavailableError(
						`Decision router unavailable for mandatory checkpoint ${request.checkpointId}: ${String(err)}`,
					);
				}
				throw err;
			}
		} else if (this.decisionEngine) {
			try {
				evaluation = await this.decisionEngine.evaluate(program, request.state, { consequence });
			} catch (err) {
				if (this.policy.mode === "system_one_required") {
					throw new SystemOneSteeringUnavailableError(
						`System One steering engine unavailable for mandatory checkpoint ${request.checkpointId}: ${String(err)}`,
					);
				}
				throw err;
			}
		} else {
			if (this.policy.mode === "system_one_required") {
				throw new SystemOneSteeringUnavailableError(
					`Decision engine missing for mandatory checkpoint ${request.checkpointId} in system_one_required mode.`,
				);
			}
			throw new SystemOneSteeringUnavailableError(
				`No decision engine configured for checkpoint ${request.checkpointId}.`,
			);
		}

		if (!evaluation?.results || Object.keys(evaluation.results).length === 0) {
			throw new SteeringProtocolError(
				`Empty evaluation response from decision engine for checkpoint ${request.checkpointId}`,
				request.checkpointId,
			);
		}

		// Map normalized results to answers
		const answers: Record<string, unknown> = {};
		const confidences: number[] = [];

		for (const d of program.decisions) {
			const result = evaluation.results[d.id];
			if (!result) {
				throw new SteeringProtocolError(
					`Missing required decision result for '${d.id}' in checkpoint ${request.checkpointId}`,
					request.checkpointId,
				);
			}

			if (result.kind === "boolean") {
				answers[d.id] = {
					type: "noul",
					noul: result.probabilityTrue,
					value: result.value,
					confidence: result.confidence.value,
				};
				confidences.push(result.confidence.value);
			} else if (result.kind === "choice") {
				answers[d.id] = {
					type: "choice",
					choice: result.selected,
					distribution: result.distribution,
					probabilities: result.distribution,
					margin: result.margin,
					confidence: result.confidence.value,
				};
				confidences.push(result.confidence.value);
			} else if (result.kind === "score") {
				answers[d.id] = {
					type: "score",
					score: result.value,
					value: result.value,
					distribution: result.distribution,
					probabilities: result.distribution,
					confidence: result.confidence.value,
				};
				confidences.push(result.confidence.value);
			} else if (result.kind === "set") {
				answers[d.id] = {
					type: "set",
					selected: result.selected,
					memberships: result.memberships,
					confidence: result.confidence.value,
				};
				confidences.push(result.confidence.value);
			}
		}

		// PH-006, PH-007: Weakest-link confidence across required judgments. No global _confidence!
		const actionConfidence = confidences.length > 0 ? Math.min(...confidences) : 0.0;
		if (actionConfidence < thresholds.minimumConfidence) {
			throw new SteeringConfidenceTooLowError(request.checkpointId, actionConfidence, thresholds.minimumConfidence);
		}

		const directive = this.composeDirective(request.checkpointId, answers, program);

		const certificate: SteeringCertificate = {
			schema_version: "1.0",
			certificate_id: `SCERT-${request.checkpointId}-${Date.now()}-${randomUUID().slice(0, 8)}`,
			objective_id: request.objectiveId,
			task_id: request.taskId ?? null,
			work_unit_id: request.workUnitId ?? null,
			checkpoint_id: request.checkpointId,
			state_digest: stateDigest,
			evidence_revision: request.evidenceRevision,
			policy: {
				id: STEERING_POLICY_ID,
				version: this.policy.version,
				digest: policyDigest,
			},
			question_pack: {
				id: program.id,
				version: program.version,
				digest: programDigest,
			},
			engine: {
				provider,
				model,
			},
			answers,
			directive: directive.action,
			action_confidence: actionConfidence,
			policy_result: "accepted",
			parent_certificate_ids: request.parentCertificateIds ? [...request.parentCertificateIds] : undefined,
			usage: evaluation.audit as Record<string, unknown> | undefined,
			created_at: new Date().toISOString(),
		};

		// PH-021, PH-022: Atomic fail-closed persistence
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
