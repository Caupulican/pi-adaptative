/**
 * Expert Selection Service.
 * Central coordinator for the Harness Mixture of Experts (H-MoE) selection plane.
 * Implements reference/expert-selection-service.ts and HMOE-010.
 */

import type { ExpertAdmissionPolicy } from "./admission.ts";
import type { ExpertCapacityService } from "./capacity.ts";
import type { ExpertCatalog } from "./catalog.ts";
import {
	type ExpertCandidateRejection,
	type ExpertSelectionMode,
	type ExpertSelectionPlan,
	type ExpertSelectionTrace,
	NoEligibleExpertError,
	type ScoredExpertCandidate,
	type WorkerCapabilityRequest,
} from "./contracts.ts";
import type { ExpertFeatureBuilder } from "./features.ts";
import type { ExpertOutcomeStore } from "./outcome-store.ts";
import type { ExpertRankingPolicy } from "./ranking.ts";
import { buildSelectionTrace } from "./selection-trace.ts";

export interface ExpertSelectionResult extends ExpertSelectionPlan {
	readonly trace: ExpertSelectionTrace;
}

export class ExpertSelectionService {
	private readonly catalog: ExpertCatalog;
	private readonly admission: ExpertAdmissionPolicy;
	private readonly features: ExpertFeatureBuilder;
	private readonly ranking: ExpertRankingPolicy;
	private readonly capacity: ExpertCapacityService;
	readonly outcomeStore?: ExpertOutcomeStore;

	constructor(
		catalog: ExpertCatalog,
		admission: ExpertAdmissionPolicy,
		features: ExpertFeatureBuilder,
		ranking: ExpertRankingPolicy,
		capacity: ExpertCapacityService,
		outcomeStore?: ExpertOutcomeStore,
	) {
		this.catalog = catalog;
		this.admission = admission;
		this.features = features;
		this.ranking = ranking;
		this.capacity = capacity;
		this.outcomeStore = outcomeStore;
	}

	/**
	 * Selects the optimal materialized expert(s) for a given WorkerCapabilityRequest.
	 */
	async select(
		request: WorkerCapabilityRequest,
		options?: { mode?: ExpertSelectionMode; signal?: AbortSignal },
	): Promise<ExpertSelectionResult> {
		if (options?.signal?.aborted) {
			throw new Error("Expert selection aborted.");
		}

		// 1. Materialize candidates lazily
		const candidates = await this.catalog.materializeCandidates(request);

		// 2. Hard admission filtering
		const admitted = [];
		const rejected: ExpertCandidateRejection[] = [];

		for (const candidate of candidates) {
			const evalResult = this.admission.evaluate(request, candidate);
			if (evalResult.allowed) {
				admitted.push(candidate);
			} else {
				rejected.push({ candidate, reasonCodes: evalResult.reasonCodes });
			}
		}

		// 3. Check for empty eligible set
		if (admitted.length === 0) {
			throw new NoEligibleExpertError(request, rejected);
		}

		// 4. Feature vector scoring
		const scored: ScoredExpertCandidate[] = await Promise.all(
			admitted.map(async (candidate) => ({
				candidate,
				features: await this.features.build(request, candidate),
			})),
		);

		// 5. Ranking and mode selection
		const mode = options?.mode ?? "single";
		const plan = this.ranking.select(request, scored, mode);

		// 6. Capacity reservation
		await this.capacity.reserve(plan.bindings, request);

		// 7. Selection trace building
		const trace = buildSelectionTrace(request, candidates, rejected, scored, plan, this.ranking.version);

		return {
			...plan,
			trace,
		};
	}

	/**
	 * Releases capacity reserved by selected bindings.
	 */
	release(plan: ExpertSelectionPlan): void {
		this.capacity.release(plan.bindings);
	}
}
