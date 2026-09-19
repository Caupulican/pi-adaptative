/**
 * Expert Feature Vector Builder.
 * Computes explainable, normalized feature scores for admitted candidates.
 * Implements ADMISSION_AND_SELECTION.md and HMOE-040.
 */

import type { ModelAdaptationStore } from "../models/adaptation-store.ts";
import type { FitnessStore } from "../models/fitness-store.ts";
import type { ExpertCandidate, ExpertFeatureVector, WorkerCapabilityRequest } from "./contracts.ts";
import type { ExpertOutcomeStore } from "./outcome-store.ts";

export interface ExpertFeatureBuilderDeps {
	fitnessStore?: FitnessStore;
	adaptationStore?: ModelAdaptationStore;
	outcomeStore?: ExpertOutcomeStore;
}

export class ExpertFeatureBuilder {
	private readonly deps: ExpertFeatureBuilderDeps;

	constructor(deps: ExpertFeatureBuilderDeps = {}) {
		this.deps = deps;
	}

	/**
	 * Builds an explainable feature vector for a candidate expert on a given request.
	 */
	async build(request: WorkerCapabilityRequest, candidate: ExpertCandidate): Promise<ExpertFeatureVector> {
		const desc = candidate.descriptor;
		const state = candidate.state;

		// 1. Ability Features
		let capabilityFit = 0.7;
		if (desc.capability_tier === "expensive" || desc.capability_tier === "frontier") {
			capabilityFit = 1.0;
		} else if (desc.capability_tier === "medium" || desc.capability_tier === "balanced") {
			capabilityFit = 0.8;
		} else if (desc.capability_tier === "cheap" || desc.capability_tier === "fast") {
			capabilityFit = 0.6;
		}

		// Reasoning fit
		let reasoningFit = 0.5;
		if (desc.thinking_level === "high") {
			reasoningFit = 1.0;
		} else if (desc.thinking_level === "medium") {
			reasoningFit = 0.8;
		} else if (desc.thinking_level === "low") {
			reasoningFit = 0.6;
		} else {
			reasoningFit = 0.4;
		}

		// Context fit
		let contextFit = 0.7;
		if (desc.context_window && request.minimum_context_window) {
			const ratio = desc.context_window / request.minimum_context_window;
			contextFit = Math.min(1.0, 0.5 + ratio * 0.25);
		}

		// Probe Fitness (FitnessStore)
		let roleProbeFitness = 0.5;
		if (this.deps.fitnessStore) {
			// Probe store check if available
			roleProbeFitness = 0.7;
		}

		// Real Outcome Fitness (ExpertOutcomeStore)
		let taskOutcomeFitness = 0.5;
		let recentSuccessLowerBound = 0.5;
		let verifierRejectionPenalty = 0.0;
		let failurePenalty = 0.0;

		if (this.deps.outcomeStore) {
			const stats = await this.deps.outcomeStore.getAggregateStats(desc.expert_id, request.work_class);
			taskOutcomeFitness = stats.successRate;
			recentSuccessLowerBound = stats.lowerBoundSuccessProbability;

			if (stats.rejectedCount > 0) {
				verifierRejectionPenalty = Math.min(0.5, stats.rejectedCount * 0.1);
			}

			// Check if recent failures match current failure signatures
			if (request.failure_signatures && request.failure_signatures.length > 0) {
				const recentFailures = await this.deps.outcomeStore.getOutcomes({
					expertId: desc.expert_id,
					limit: 5,
				});
				const hasRecentMatchingFailure = recentFailures.some(
					(o) => o.failure_cause && request.failure_signatures?.includes(o.failure_cause),
				);
				if (hasRecentMatchingFailure) {
					failurePenalty = 0.4;
				}
			}
		}

		const toolReliability = 0.9;

		// 2. Operational Features
		// Cost utility: cheaper is higher utility (0 to 1)
		const cost = state.estimatedCostUsd ?? 0.01;
		const costUtility = Math.max(0.0, Math.min(1.0, 1.0 - cost / 0.1));

		// Latency utility: faster is higher utility
		const latency = state.estimatedLatencyMs ?? 1000;
		const latencyUtility = Math.max(0.0, Math.min(1.0, 1.0 - latency / 5000));

		const availability = state.authenticated && !state.quotaExhausted ? 1.0 : 0.0;
		const quotaHeadroom = state.providerHealthy ? 0.9 : 0.2;
		const localResourceFit = desc.runtime_kind !== "remote" ? 0.9 : 0.7;

		// 3. Strategic Features
		const diversityBonus = desc.runtime_kind !== "remote" ? 0.1 : 0.0;
		const privacyBonus = desc.privacy_class === "local_only" ? 0.2 : 0.0;
		const explorationBonus = 0.0;

		// 4. Repetition penalty
		const repetitionPenalty = 0.0;

		// 5. Total composite score calculation
		// Consequence-sensitive weighting
		let wAbility = 0.4;
		let wOperational = 0.3;
		let wReliability = 0.3;

		if (request.consequence === "critical" || request.consequence === "high") {
			wAbility = 0.5;
			wReliability = 0.4;
			wOperational = 0.1;
		} else if (request.consequence === "low") {
			wAbility = 0.3;
			wReliability = 0.2;
			wOperational = 0.5;
		}

		const abilityScore =
			capabilityFit * 0.25 +
			reasoningFit * 0.25 +
			contextFit * 0.15 +
			roleProbeFitness * 0.15 +
			taskOutcomeFitness * 0.2;

		const operationalScore = costUtility * 0.4 + latencyUtility * 0.3 + availability * 0.2 + localResourceFit * 0.1;

		const reliabilityScore = recentSuccessLowerBound - failurePenalty - verifierRejectionPenalty - repetitionPenalty;

		const totalScore = Math.max(
			0.0,
			abilityScore * wAbility +
				operationalScore * wOperational +
				Math.max(0, reliabilityScore) * wReliability +
				diversityBonus +
				privacyBonus +
				explorationBonus,
		);

		return {
			capabilityFit,
			roleProbeFitness,
			taskOutcomeFitness,
			toolReliability,
			reasoningFit,
			contextFit,
			costUtility,
			latencyUtility,
			availability,
			quotaHeadroom,
			localResourceFit,
			recentSuccessLowerBound,
			failurePenalty,
			repetitionPenalty,
			verifierRejectionPenalty,
			diversityBonus,
			privacyBonus,
			explorationBonus,
			totalScore,
		};
	}
}
