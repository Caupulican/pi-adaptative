import { type CandidateSnapshot, captureCandidateSnapshot } from "../system-one/candidate-snapshot.ts";
import { buildCompletionProof } from "../system-one/completion-proof.ts";
/**
 * Completion Coordinator.
 * Single owner for objective completion gating, assurance profiles, and delivery bundle creation.
 * Conforms to COMPLETION_COORDINATOR.md, DELIVERY_CONTRACT.md, and FINAL_PATCH_SPEC v2.1.
 */

import { execSync } from "node:child_process";
import type { CompletionAssuranceProfile } from "../decision/policy.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import {
	buildDeliveryBundle,
	type DeliveryArtifact,
	type DeliveryBundle,
	type DeliveryVerificationRecord,
} from "./delivery-bundle.ts";

export type CompletionVerdict = "complete" | "not_complete" | "semantic_gate_unavailable";

export type SemanticEnhancedFallbackPolicy = "mechanical" | "mechanical_plus_reviewer" | "hold_semantic_gate";

export interface IndependentReviewerVerdict {
	readonly passed: boolean;
	readonly reviewerRef: string;
	readonly reasoning?: string;
	readonly blockingIssues?: readonly string[];
}

export interface CompletionEvaluationContext {
	readonly runtime: TaskRuntimeProjection;
	readonly getExecutionState?: () => import("../system-one/types.ts").ExecutionState;
	readonly getSourceRevision?: (objectiveId: string) => Promise<string> | string;
	readonly getArtifacts?: (objectiveId: string) => Promise<readonly DeliveryArtifact[]> | readonly DeliveryArtifact[];
	readonly getLimitations?: (objectiveId: string) => Promise<readonly string[]> | readonly string[];
	readonly cwd?: string;
	readonly repoRoot?: string;
	readonly candidateSnapshot?: CandidateSnapshot;
	readonly reviewer?: {
		review(input: {
			objectiveId: string;
			sourceRevision: string;
			acceptanceMatrix: Record<string, unknown>;
		}): Promise<IndependentReviewerVerdict> | IndependentReviewerVerdict;
	};
	readonly semanticEvaluator?: {
		evaluateCompletion(
			objectiveId: string,
			options?: { signal?: AbortSignal },
		): Promise<{
			passed: boolean;
			decisionRef?: string;
			failedGates?: readonly string[];
		}>;
	};
	readonly hasCalibratedEngine?: () => boolean;
	readonly fallbackPolicy?: SemanticEnhancedFallbackPolicy;
}

export interface CompletionEvaluationResult {
	readonly verdict: CompletionVerdict;
	readonly assuranceProfileRequested: CompletionAssuranceProfile;
	readonly assuranceProfileUsed?: CompletionAssuranceProfile;
	readonly deterministicGateRecords: readonly DeliveryVerificationRecord[];
	readonly reviewerRefs?: readonly string[];
	readonly semanticRefs?: readonly string[];
	readonly failedGates: readonly string[];
	readonly requiredNextProof: readonly string[];
	readonly fallbackChain: readonly string[];
	readonly deliveryBundle?: DeliveryBundle;
	readonly candidateSnapshot?: CandidateSnapshot;
}

function resolveGitRevision(cwd?: string): string {
	if (!cwd) {
		return "HEAD";
	}
	try {
		const out = execSync("git rev-parse HEAD", {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (out.length >= 7) {
			return out;
		}
	} catch {
		// Git not available or not in a git repository
	}
	return "HEAD";
}

export class CompletionCoordinator {
	evaluate(
		objectiveId: string,
		profile: CompletionAssuranceProfile,
		context: CompletionEvaluationContext,
		options?: { signal?: AbortSignal },
	): Promise<CompletionEvaluationResult> {
		return CompletionCoordinator.evaluate(objectiveId, profile, context, options);
	}

	/**
	 * Single implementation entry point for evaluating objective completion.
	 * No other code path may construct terminal complete.
	 */
	static async evaluate(
		objectiveId: string,
		profile: CompletionAssuranceProfile,
		context: CompletionEvaluationContext,
		options?: { signal?: AbortSignal },
	): Promise<CompletionEvaluationResult> {
		options?.signal?.throwIfAborted();

		if (profile === "system_one_required") {
			const isCalibrated = context.hasCalibratedEngine ? context.hasCalibratedEngine() : false;
			if (!isCalibrated || !context.semanticEvaluator) {
				return {
					verdict: "semantic_gate_unavailable",
					assuranceProfileRequested: profile,
					deterministicGateRecords: [],
					failedGates: ["system_one_required_but_unavailable", "semantic_gate_unavailable"],
					requiredNextProof: ["provide_calibrated_decision_engine"],
					fallbackChain: [],
				};
			}
			if (!context.getExecutionState?.()) {
				return {
					verdict: "semantic_gate_unavailable",
					assuranceProfileRequested: profile,
					deterministicGateRecords: [],
					failedGates: ["execution_state_unavailable"],
					requiredNextProof: ["supply_canonical_system_one_execution_state"],
					fallbackChain: [],
				};
			}
		}

		const deterministicGateRecords: DeliveryVerificationRecord[] = [];
		const failedGates: string[] = [];
		const requiredNextProof: string[] = [];
		const fallbackChain: string[] = [];

		const repoRoot = context.repoRoot ?? context.cwd;
		let snapshot = context.candidateSnapshot;
		if (!snapshot && repoRoot) {
			try {
				snapshot = captureCandidateSnapshot(repoRoot);
			} catch (error) {
				if (profile === "system_one_required") {
					return {
						verdict: "semantic_gate_unavailable",
						assuranceProfileRequested: profile,
						deterministicGateRecords,
						failedGates: ["candidate_snapshot_unavailable"],
						requiredNextProof: [error instanceof Error ? error.message : "capture_candidate_snapshot_failed"],
						fallbackChain,
					};
				}
			}
		}

		// 1. Freeze exact candidate revision from the snapshot when present.
		let candidateRevision = snapshot?.candidateRevision ?? "HEAD";
		if (candidateRevision === "HEAD" || !candidateRevision) {
			if (context.getSourceRevision) {
				try {
					candidateRevision = await context.getSourceRevision(objectiveId);
				} catch {
					candidateRevision = "HEAD";
				}
			}
		}
		if (candidateRevision === "HEAD" || !candidateRevision) {
			const resolved = resolveGitRevision(repoRoot);
			if (resolved && resolved !== "HEAD") {
				candidateRevision = resolved;
			}
		}
		if ((candidateRevision === "HEAD" || !candidateRevision) && profile === "system_one_required") {
			return {
				verdict: "semantic_gate_unavailable",
				assuranceProfileRequested: profile,
				deterministicGateRecords,
				failedGates: ["candidate_revision_unavailable"],
				requiredNextProof: ["resolve_exact_candidate_revision"],
				fallbackChain,
			};
		}
		if (candidateRevision === "HEAD" || !candidateRevision) {
			candidateRevision = "unresolved";
		}

		// 2. Evaluate deterministic proof from live System One state when supplied.
		const execState = context.getExecutionState?.();
		if (!execState) {
			const diagnostic = "execution_state_unavailable";
			if (profile === "system_one_required") {
				return {
					verdict: "semantic_gate_unavailable",
					assuranceProfileRequested: profile,
					deterministicGateRecords,
					failedGates: [diagnostic],
					requiredNextProof: ["supply_canonical_system_one_execution_state"],
					fallbackChain,
					candidateSnapshot: snapshot,
				};
			}
		} else if (snapshot) {
			const proof = buildCompletionProof(execState, snapshot);
			for (const gate of proof.gates) {
				deterministicGateRecords.push({
					gateId: gate.id,
					status: gate.status,
					required: gate.required,
					detail: gate.details,
				});
			}
			for (const reason of proof.failed_reasons) {
				failedGates.push(reason.id);
				if (reason.required_next_proof) {
					requiredNextProof.push(reason.required_next_proof);
				}
			}
		}

		const objective = context.runtime.objectives[objectiveId];
		const rawCriteria =
			objective?.objective.acceptanceCriteria ??
			(objective?.objective as { acceptance_criteria?: readonly (string | { id: string })[] })
				?.acceptance_criteria ??
			[];
		const requiredCriteria = rawCriteria.map((c) => (typeof c === "string" ? c : c.id));
		const evidenceList = objective?.evidence ?? [];
		for (const criterion of requiredCriteria) {
			const resolved = evidenceList.some((entry) => {
				const record = entry as { criterionId?: string; requirement_id?: string; evidenceId?: string };
				return record.criterionId === criterion || record.requirement_id === criterion;
			});
			if (!resolved) {
				failedGates.push(`criterion_unresolved:${criterion}`);
				deterministicGateRecords.push({
					gateId: `criterion:${criterion}`,
					status: "failed",
					required: true,
					detail: `No evidence for required criterion ${criterion}`,
				});
			}
		}

		// 4. Verify hard constraints (budget, cancellation)
		if (objective?.objective.status === "cancelled") {
			failedGates.push("objective_cancelled");
			deterministicGateRecords.push({
				gateId: "objective_status",
				status: "failed",
				required: true,
				detail: "Objective was cancelled.",
			});
		}

		// 5. Gather artifacts and limitations
		const artifacts = (await context.getArtifacts?.(objectiveId)) ?? [];
		const limitations = (await context.getLimitations?.(objectiveId)) ?? [];

		// Common mandatory stage check:
		const mandatoryStagePassed = failedGates.length === 0;

		if (!mandatoryStagePassed) {
			// Mandatory gate failure defeats every profile
			return {
				verdict: "not_complete",
				assuranceProfileRequested: profile,
				deterministicGateRecords,
				failedGates,
				requiredNextProof,
				fallbackChain,
				candidateSnapshot: snapshot,
			};
		}

		// Mandatory stage passed. Now evaluate the requested assurance profile:
		switch (profile) {
			case "mechanical": {
				// FIN-061: Mechanical completion profile produces complete DeliveryBundle
				const bundle = buildDeliveryBundle({
					objectiveId,
					terminalStatus: "complete",
					sourceRevision: candidateRevision,
					acceptance: { criteria: requiredCriteria, evidence: evidenceList },
					verification: deterministicGateRecords,
					artifacts,
					limitations,
					assuranceProfileRequested: "mechanical",
					assuranceProfileUsed: "mechanical",
					diffDigest: snapshot?.digest,
				});

				return {
					verdict: "complete",
					assuranceProfileRequested: "mechanical",
					assuranceProfileUsed: "mechanical",
					deterministicGateRecords,
					failedGates: [],
					requiredNextProof: [],
					fallbackChain: [],
					deliveryBundle: bundle,
					candidateSnapshot: snapshot,
				};
			}

			case "mechanical_plus_reviewer": {
				// FIN-062: Fresh independent reasoning reviewer
				if (!context.reviewer) {
					return {
						verdict: "not_complete",
						assuranceProfileRequested: "mechanical_plus_reviewer",
						deterministicGateRecords,
						failedGates: ["reviewer_unavailable"],
						requiredNextProof: ["invoke_independent_reviewer"],
						fallbackChain: [],
					};
				}

				try {
					const review = await context.reviewer.review({
						objectiveId,
						sourceRevision: candidateRevision,
						acceptanceMatrix: { criteria: requiredCriteria, evidence: evidenceList },
					});

					if (!review.passed) {
						return {
							verdict: "not_complete",
							assuranceProfileRequested: "mechanical_plus_reviewer",
							deterministicGateRecords,
							reviewerRefs: [review.reviewerRef],
							failedGates: ["reviewer_rejected", ...(review.blockingIssues ?? [])],
							requiredNextProof: ["address_reviewer_feedback"],
							fallbackChain: [],
						};
					}

					const bundle = buildDeliveryBundle({
						objectiveId,
						terminalStatus: "complete",
						sourceRevision: candidateRevision,
						acceptance: { criteria: requiredCriteria, evidence: evidenceList },
						verification: deterministicGateRecords,
						artifacts,
						limitations,
						assuranceProfileRequested: "mechanical_plus_reviewer",
						assuranceProfileUsed: "mechanical_plus_reviewer",
						reviewerRefs: [review.reviewerRef],
					});

					return {
						verdict: "complete",
						assuranceProfileRequested: "mechanical_plus_reviewer",
						assuranceProfileUsed: "mechanical_plus_reviewer",
						deterministicGateRecords,
						reviewerRefs: [review.reviewerRef],
						failedGates: [],
						requiredNextProof: [],
						fallbackChain: [],
						deliveryBundle: bundle,
					};
				} catch (_err) {
					return {
						verdict: "not_complete",
						assuranceProfileRequested: "mechanical_plus_reviewer",
						deterministicGateRecords,
						failedGates: ["reviewer_exception"],
						requiredNextProof: ["retry_reviewer"],
						fallbackChain: [],
					};
				}
			}

			case "system_one_required": {
				// FIN-064: Requires calibrated compatible engine
				const isCalibrated = context.hasCalibratedEngine ? context.hasCalibratedEngine() : false;
				if (!isCalibrated || !context.semanticEvaluator) {
					return {
						verdict: "semantic_gate_unavailable",
						assuranceProfileRequested: "system_one_required",
						deterministicGateRecords,
						failedGates: ["system_one_required_but_unavailable", "semantic_gate_unavailable"],
						requiredNextProof: ["provide_calibrated_decision_engine"],
						fallbackChain: [],
					};
				}

				try {
					const semanticResult = await context.semanticEvaluator.evaluateCompletion(objectiveId, options);
					if (semanticResult.passed) {
						const bundle = buildDeliveryBundle({
							objectiveId,
							terminalStatus: "complete",
							sourceRevision: candidateRevision,
							acceptance: { criteria: requiredCriteria, evidence: evidenceList },
							verification: deterministicGateRecords,
							artifacts,
							limitations,
							decisionRefs: semanticResult.decisionRef ? [semanticResult.decisionRef] : undefined,
							assuranceProfileRequested: "system_one_required",
							assuranceProfileUsed: "system_one_required",
							diffDigest: snapshot?.digest,
						});

						return {
							verdict: "complete",
							assuranceProfileRequested: "system_one_required",
							assuranceProfileUsed: "system_one_required",
							deterministicGateRecords,
							semanticRefs: semanticResult.decisionRef ? [semanticResult.decisionRef] : [],
							failedGates: [],
							requiredNextProof: [],
							fallbackChain: [],
							deliveryBundle: bundle,
							candidateSnapshot: snapshot,
						};
					}

					return {
						verdict: "not_complete",
						assuranceProfileRequested: "system_one_required",
						deterministicGateRecords,
						failedGates: semanticResult.failedGates
							? [...semanticResult.failedGates]
							: ["semantic_verification_failed"],
						requiredNextProof: ["resolve_semantic_gates"],
						fallbackChain: [],
					};
				} catch (_err) {
					// FIN-066: Semantic exception never directly becomes success
					return {
						verdict: "not_complete",
						assuranceProfileRequested: "system_one_required",
						deterministicGateRecords,
						failedGates: ["semantic_evaluation_exception"],
						requiredNextProof: ["retry_semantic_evaluation"],
						fallbackChain: [],
					};
				}
			}

			default: {
				// FIN-063: Semantic enhanced with explicit gate-backed fallback
				fallbackChain.push("semantic_enhanced");

				let semanticPassed = false;
				let semanticRef: string | undefined;

				if (context.semanticEvaluator) {
					try {
						const semanticResult = await context.semanticEvaluator.evaluateCompletion(objectiveId, options);
						if (semanticResult.passed) {
							semanticPassed = true;
							semanticRef = semanticResult.decisionRef;
						} else {
							failedGates.push(...(semanticResult.failedGates ?? ["semantic_check_failed"]));
						}
					} catch (err) {
						// Exception recorded in fallback chain
						fallbackChain.push(`semantic_exception:${String(err)}`);
					}
				}

				if (semanticPassed) {
					const bundle = buildDeliveryBundle({
						objectiveId,
						terminalStatus: "complete",
						sourceRevision: candidateRevision,
						acceptance: { criteria: requiredCriteria, evidence: evidenceList },
						verification: deterministicGateRecords,
						artifacts,
						limitations,
						decisionRefs: semanticRef ? [semanticRef] : undefined,
						assuranceProfileRequested: "semantic_enhanced",
						assuranceProfileUsed: "semantic_enhanced",
					});

					return {
						verdict: "complete",
						assuranceProfileRequested: "semantic_enhanced",
						assuranceProfileUsed: "semantic_enhanced",
						deterministicGateRecords,
						semanticRefs: semanticRef ? [semanticRef] : [],
						failedGates: [],
						requiredNextProof: [],
						fallbackChain,
						deliveryBundle: bundle,
					};
				}

				// Fallback is explicit policy:
				const fallback = context.fallbackPolicy ?? "mechanical";
				fallbackChain.push(`fallback_to:${fallback}`);

				if (fallback === "hold_semantic_gate") {
					return {
						verdict: "not_complete",
						assuranceProfileRequested: "semantic_enhanced",
						deterministicGateRecords,
						failedGates: failedGates.length > 0 ? failedGates : ["semantic_gate_unmet"],
						requiredNextProof: ["satisfy_semantic_gate"],
						fallbackChain,
					};
				}

				if (fallback === "mechanical_plus_reviewer" && context.reviewer) {
					try {
						const review = await context.reviewer.review({
							objectiveId,
							sourceRevision: candidateRevision,
							acceptanceMatrix: { criteria: requiredCriteria, evidence: evidenceList },
						});
						if (review.passed) {
							const bundle = buildDeliveryBundle({
								objectiveId,
								terminalStatus: "complete",
								sourceRevision: candidateRevision,
								acceptance: { criteria: requiredCriteria, evidence: evidenceList },
								verification: deterministicGateRecords,
								artifacts,
								limitations,
								reviewerRefs: [review.reviewerRef],
								assuranceProfileRequested: "semantic_enhanced",
								assuranceProfileUsed: "mechanical_plus_reviewer",
							});

							return {
								verdict: "complete",
								assuranceProfileRequested: "semantic_enhanced",
								assuranceProfileUsed: "mechanical_plus_reviewer",
								deterministicGateRecords,
								reviewerRefs: [review.reviewerRef],
								failedGates: [],
								requiredNextProof: [],
								fallbackChain,
								deliveryBundle: bundle,
							};
						}
					} catch {
						// Reviewer failed under fallback
					}
					return {
						verdict: "not_complete",
						assuranceProfileRequested: "semantic_enhanced",
						deterministicGateRecords,
						failedGates: ["reviewer_fallback_failed"],
						requiredNextProof: ["resolve_reviewer_failures"],
						fallbackChain,
					};
				}

				if (fallback === "mechanical") {
					// Fallback to mechanical passes deterministic gates
					const bundle = buildDeliveryBundle({
						objectiveId,
						terminalStatus: "complete",
						sourceRevision: candidateRevision,
						acceptance: { criteria: requiredCriteria, evidence: evidenceList },
						verification: deterministicGateRecords,
						artifacts,
						limitations,
						assuranceProfileRequested: "semantic_enhanced",
						assuranceProfileUsed: "mechanical",
					});

					return {
						verdict: "complete",
						assuranceProfileRequested: "semantic_enhanced",
						assuranceProfileUsed: "mechanical",
						deterministicGateRecords,
						failedGates: [],
						requiredNextProof: [],
						fallbackChain,
						deliveryBundle: bundle,
					};
				}

				return {
					verdict: "not_complete",
					assuranceProfileRequested: "semantic_enhanced",
					deterministicGateRecords,
					failedGates: ["unknown_fallback_policy"],
					requiredNextProof: ["configure_valid_fallback"],
					fallbackChain,
				};
			}
		}
	}
}
