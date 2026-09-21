/**
 * Expert Feature Vector Builder.
 * Computes explainable, normalized feature scores for admitted candidates.
 * Implements ADMISSION_AND_SELECTION.md and HMOE-040.
 */

import { laneMeetsFitnessBar } from "../model-router/fitness-gate.ts";
import type { ModelAdaptationStore } from "../models/adaptation-store.ts";
import type { FitnessStore } from "../models/fitness-store.ts";
import type {
	ExpertAdequacyClass,
	ExpertCandidate,
	ExpertFeatureVector,
	WorkerCapabilityRequest,
} from "./contracts.ts";
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

		// Probe Fitness (FitnessStore) (HM11-010, HM11-014)
		// `adequacyClass` is the same evidence as a judgment rather than a number: 0.5 means "no
		// probe record" and "a probed half-pass" indistinguishably, and the ranking policy must be
		// able to tell an unprobed expert from one the probes graded as unfit.
		let roleProbeFitness = 0.5;
		let adequacyClass: ExpertAdequacyClass = "unprobed";
		if (this.deps.fitnessStore) {
			const modelRef = `${desc.provider}/${desc.model_id}`;
			let matchingReport: any;
			if (typeof (this.deps.fitnessStore as any).getForHost === "function") {
				const reports = this.deps.fitnessStore.getForHost();
				matchingReport = reports.find(
					(r: any) => r.model === modelRef || r.model === desc.model_id || r.model.endsWith(`/${desc.model_id}`),
				)?.report;
			} else if (typeof (this.deps.fitnessStore as any).getReport === "function") {
				matchingReport =
					(this.deps.fitnessStore as any).getReport(modelRef) ??
					(this.deps.fitnessStore as any).getReport(desc.model_id);
			}

			if (matchingReport) {
				// Every branch selects the request's lane and nothing else; scoring happens once,
				// below. A branch that scored inline would be overwritten here by the lane it left
				// unselected — which is exactly how the judge lane used to be discarded.
				let lane = matchingReport.worker ?? matchingReport.lanes?.worker;
				if (request.work_class === "investigate" || request.work_class === "retrieve") {
					lane = matchingReport.research ?? matchingReport.lanes?.research;
				} else if ((request.work_class as string) === "judge" || request.worker_role === "judge") {
					lane = matchingReport.judge ?? matchingReport.lanes?.judge;
				} else if ((request.work_class as string) === "digest" || request.worker_role === "digest") {
					lane = matchingReport.digest ?? matchingReport.lanes?.digest;
				} else if (request.required_tools && request.required_tools.length > 0) {
					lane = matchingReport.toolCall ?? matchingReport.lanes?.toolCall;
				}

				if (lane && lane.total > 0) {
					// The judge lane counts parsed verdicts; every other lane counts successes.
					const successes = lane.parsed ?? lane.succeeded ?? lane.successes ?? 0;
					roleProbeFitness = Math.max(0.0, Math.min(1.0, successes / lane.total));
					adequacyClass = laneMeetsFitnessBar(successes, lane.total) ? "known_fit" : "known_unfit";
				}
			}
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

		let toolReliability = 0.9;
		let latency = state.estimatedLatencyMs ?? 1000;

		// Read real AdaptationStore profiles (HM11-011, HM11-012, HM11-013)
		if (this.deps.adaptationStore) {
			const modelRef = `${desc.provider}/${desc.model_id}`;
			const store = this.deps.adaptationStore as any;
			const profile =
				(typeof store.get === "function" ? (store.get(desc.model_id) ?? store.get(modelRef)) : undefined) ??
				(typeof store.getProfile === "function"
					? (store.getProfile(desc.provider, desc.model_id) ??
						store.getProfile(desc.model_id) ??
						store.getProfile(modelRef))
					: undefined);

			if (profile) {
				if (profile.toolProbe) {
					const status = typeof profile.toolProbe === "string" ? profile.toolProbe : profile.toolProbe.status;
					const nativeGrade = typeof profile.toolProbe === "object" ? profile.toolProbe.nativeGrade : undefined;
					if (status === "none" || nativeGrade === "absent") {
						toolReliability = 0.2;
					} else if (status === "native") {
						toolReliability = 1.0;
					} else if (status === "text-protocol") {
						toolReliability = 0.8;
					}
				}

				if (profile.capabilityTier?.tier === "strong" || profile.capabilityTier === "strong") {
					capabilityFit = Math.min(capabilityFit, 0.8);
				}

				if (profile.perf?.latencyMultiplier && profile.perf.latencyMultiplier > 0) {
					latency = latency * profile.perf.latencyMultiplier;
				} else if (profile.perf?.meanMs && profile.perf.meanMs > 0) {
					latency = profile.perf.meanMs;
				}
			}
		}

		// 2. Operational Features
		// Cost utility: cheaper is higher utility (0 to 1)
		const cost = state.estimatedCostUsd ?? 0.01;
		const costUtility = Math.max(0.0, Math.min(1.0, 1.0 - cost / 0.1));

		// Latency utility: faster is higher utility
		const latencyUtility = Math.max(0.0, Math.min(1.0, 1.0 - latency / 5000));

		const availability = state.authenticated && !state.quotaExhausted ? 1.0 : 0.0;
		const quotaHeadroom = state.providerHealthy ? 0.9 : 0.2;
		const localResourceFit = desc.runtime_kind !== "remote" ? 0.9 : 0.7;

		// 3. Strategic Features
		const diversityBonus = desc.runtime_kind !== "remote" ? 0.1 : 0.0;
		const privacyBonus = desc.privacy_class === "local_only" ? 0.2 : 0.0;
		const explorationBonus = 0.0;
		// Recorded for the trace; the ranking policy applies it as a class ordering, so totalScore
		// keeps its existing evidence meaning.
		const subscriptionPreferred = request.prefer_subscription && state.subscriptionBacked ? 1.0 : 0.0;

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

		let subAbilityCap = 0.25;
		let subAbilityReason = 0.25;
		let subAbilityCtx = 0.15;
		let subAbilityProbe = 0.15;
		let subAbilityOutcome = 0.2;

		let subOpCost = 0.4;
		let subOpLatency = 0.3;
		let subOpAvail = 0.2;
		let subOpLocal = 0.1;

		if (request.hmoe_preset) {
			switch (request.hmoe_preset) {
				case "quality":
					wAbility = 0.6;
					wReliability = 0.3;
					wOperational = 0.1;
					break;
				case "cost":
					wAbility = 0.25;
					wReliability = 0.15;
					wOperational = 0.6;
					subOpCost = 0.6;
					subOpLatency = 0.2;
					subOpAvail = 0.1;
					subOpLocal = 0.1;
					break;
				case "speed":
					wAbility = 0.25;
					wReliability = 0.15;
					wOperational = 0.6;
					subOpLatency = 0.6;
					subOpCost = 0.2;
					subOpAvail = 0.1;
					subOpLocal = 0.1;
					break;
				case "local-first":
					wAbility = 0.3;
					wReliability = 0.2;
					wOperational = 0.5;
					subOpLocal = 0.5;
					subOpCost = 0.2;
					subOpLatency = 0.2;
					subOpAvail = 0.1;
					break;
				case "subscription-first":
				case "balanced":
					wAbility = 0.4;
					wReliability = 0.3;
					wOperational = 0.3;
					break;
				case "custom":
					break;
			}
		}

		if (request.hmoe_weights) {
			const hw = request.hmoe_weights;
			if (hw.ability !== undefined) wAbility = hw.ability;
			if (hw.operational !== undefined) wOperational = hw.operational;
			if (hw.reliability !== undefined) wReliability = hw.reliability;
			if (hw.capabilityFit !== undefined) subAbilityCap = hw.capabilityFit;
			if (hw.reasoningFit !== undefined) subAbilityReason = hw.reasoningFit;
			if (hw.contextFit !== undefined) subAbilityCtx = hw.contextFit;
			if (hw.probeFit !== undefined) subAbilityProbe = hw.probeFit;
			if (hw.outcomeFit !== undefined) subAbilityOutcome = hw.outcomeFit;
			if (hw.cost !== undefined) subOpCost = hw.cost;
			if (hw.latency !== undefined) subOpLatency = hw.latency;
			if (hw.availability !== undefined) subOpAvail = hw.availability;
			if (hw.localResourceFit !== undefined) subOpLocal = hw.localResourceFit;
		}

		const abilityScore =
			capabilityFit * subAbilityCap +
			reasoningFit * subAbilityReason +
			contextFit * subAbilityCtx +
			roleProbeFitness * subAbilityProbe +
			taskOutcomeFitness * subAbilityOutcome;

		const operationalScore =
			costUtility * subOpCost +
			latencyUtility * subOpLatency +
			availability * subOpAvail +
			localResourceFit * subOpLocal;

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

		const isLocal = desc.runtime_kind === "local" || desc.runtime_kind === "managed-local";
		const localPreferred = request.prefer_local && isLocal ? 1 : 0;

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
			subscriptionPreferred,
			localPreferred,
			adequacyClass,
			totalScore,
		};
	}
}
