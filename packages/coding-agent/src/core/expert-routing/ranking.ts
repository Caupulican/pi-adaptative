/**
 * Expert Ranking & Team Selection Policy.
 * Implements TOPK_AND_TEAMS.md, ADMISSION_AND_SELECTION.md, and HMOE-050 through HMOE-055.
 */

import { randomUUID } from "node:crypto";
import {
	EXPERT_ROUTING_SCHEMA_VERSION,
	type ExpertAdequacyClass,
	type ExpertBinding,
	type ExpertSelectionMode,
	type ExpertSelectionPlan,
	NoEligibleExpertError,
	type ScoredExpertCandidate,
	type WorkerCapabilityRequest,
} from "./contracts.ts";
import { defaultModelFamilyResolver, type ModelFamilyResolver, TeamIndependenceValidator } from "./independence.ts";

export const EXPERT_RANKING_POLICY_VERSION = "1.2" as const;

const ADEQUACY_RANK: Record<ExpertAdequacyClass, number> = { known_fit: 2, unprobed: 1, known_unfit: 0 };

/**
 * Rank of a vector's adequacy class. A vector carrying no class at all is ranked as `unprobed`,
 * which is what "no probe evidence recorded" means — never as fit, and never as unfit.
 */
function adequacyRank(features: { adequacyClass?: ExpertAdequacyClass }): number {
	return features.adequacyClass ? ADEQUACY_RANK[features.adequacyClass] : ADEQUACY_RANK.unprobed;
}

export class ExpertRankingPolicy {
	readonly version: string = EXPERT_RANKING_POLICY_VERSION;
	private readonly validator: TeamIndependenceValidator;
	private readonly modelFamilyResolver: ModelFamilyResolver;

	constructor(deps?: {
		validator?: TeamIndependenceValidator;
		modelFamilyResolver?: ModelFamilyResolver;
	}) {
		this.modelFamilyResolver = deps?.modelFamilyResolver ?? defaultModelFamilyResolver;
		this.validator = deps?.validator ?? new TeamIndependenceValidator(this.modelFamilyResolver);
	}

	/**
	 * Ranks scored candidates and materializes bindings according to the selection mode.
	 */
	select(
		request: WorkerCapabilityRequest,
		candidates: readonly ScoredExpertCandidate[],
		mode: ExpertSelectionMode = "single",
		options?: { traceId?: string; priorBindings?: readonly ExpertBinding[] },
	): ExpertSelectionPlan {
		if (candidates.length === 0) {
			throw new Error("Cannot rank empty candidate list.");
		}

		const traceId = options?.traceId ?? randomUUID();
		// Ordering after hard admission (every candidate here is already admitted): adequacy class
		// first, so a known-unfit expert never outranks a known-fit one; then the subscription
		// preference WITHIN a class; then the existing evidence score. Who pays is a preference
		// among adequate experts, never authority over adequacy.
		const sorted = [...candidates].sort((a, b) => {
			const adequacyDelta = adequacyRank(b.features) - adequacyRank(a.features);
			if (adequacyDelta !== 0) return adequacyDelta;
			if (request.prefer_subscription) {
				const classDelta = (b.features.subscriptionPreferred ?? 0) - (a.features.subscriptionPreferred ?? 0);
				if (classDelta !== 0) return classDelta;
			}
			return b.features.totalScore - a.features.totalScore;
		});
		const independence = request.independence_level ?? "none";

		const toBinding = (sc: ScoredExpertCandidate): ExpertBinding => {
			const desc = sc.candidate.descriptor;
			const state = sc.candidate.state;
			return {
				schema_version: EXPERT_ROUTING_SCHEMA_VERSION,
				selection_id: randomUUID(),
				request_id: request.request_id,
				expert_id: desc.expert_id,
				provider: desc.provider,
				model_id: desc.model_id,
				thinking_level: desc.thinking_level,
				role: desc.role,
				selection_trace_id: traceId,
				exploration: false,
				expected_cost_usd: state.estimatedCostUsd ?? null,
				expected_latency_ms: state.estimatedLatencyMs ?? null,
			};
		};

		let selectedCandidates: ScoredExpertCandidate[] = [];

		const findCandidate = (
			candidates: ScoredExpertCandidate[],
			existing: ScoredExpertCandidate[],
		): ScoredExpertCandidate | undefined => {
			return candidates.find((c) => {
				const testBindings = [...existing, c].map(toBinding);
				return this.validator.validate(testBindings, independence, {
					priorBindings: options?.priorBindings,
					modelFamilyResolver: this.modelFamilyResolver,
				}).valid;
			});
		};

		switch (mode) {
			case "single": {
				selectedCandidates = [sorted[0]];
				break;
			}
			case "parallel_scouts": {
				const primary = sorted[0];
				selectedCandidates = [primary];

				const secondary = findCandidate(sorted.slice(1), [primary]);
				if (secondary) {
					selectedCandidates.push(secondary);
				} else if (independence !== "none" && independence !== "fresh_context") {
					throw new NoEligibleExpertError(request, [
						{
							candidate: sorted[0].candidate,
							reasonCodes: [`insufficient_diversity_for_${independence}`],
						},
					]);
				}
				break;
			}
			case "primary_critic": {
				const primary = sorted[0];
				selectedCandidates = [primary];

				const critic = findCandidate(sorted.slice(1), [primary]);
				if (critic) {
					selectedCandidates.push(critic);
				} else if (independence !== "none" && independence !== "fresh_context") {
					throw new NoEligibleExpertError(request, [
						{
							candidate: sorted[0].candidate,
							reasonCodes: [`no_independent_critic_for_${independence}`],
						},
					]);
				}
				break;
			}
			case "independent_verifier": {
				const verifierCand = findCandidate(sorted, []);
				if (!verifierCand) {
					throw new NoEligibleExpertError(request, [
						{
							candidate: sorted[0].candidate,
							reasonCodes: [`independence_violation_for_${independence}`],
						},
					]);
				}
				selectedCandidates = [verifierCand];
				break;
			}
			case "committee": {
				selectedCandidates = [sorted[0]];
				for (const cand of sorted.slice(1)) {
					if (selectedCandidates.length >= 3) break;
					const match = findCandidate([cand], selectedCandidates);
					if (match) {
						selectedCandidates.push(match);
					}
				}
				break;
			}
			default: {
				selectedCandidates = [sorted[0]];
				break;
			}
		}

		const bindings: ExpertBinding[] = selectedCandidates.map(toBinding);

		// Final validation of team bindings
		const finalCheck = this.validator.validate(bindings, independence, {
			priorBindings: options?.priorBindings,
			modelFamilyResolver: this.modelFamilyResolver,
		});
		if (!finalCheck.valid) {
			throw new NoEligibleExpertError(request, [
				{
					candidate: selectedCandidates[0].candidate,
					reasonCodes: [finalCheck.reason ?? "team_independence_violation"],
				},
			]);
		}

		return {
			primary: bindings[0],
			team: bindings,
			bindings,
			mode,
			traceId,
			exploration: false,
			ownerPinApplied: false,
		};
	}
}
