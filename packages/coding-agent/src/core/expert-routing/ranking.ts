/**
 * Expert Ranking & Team Selection Policy.
 * Implements TOPK_AND_TEAMS.md, ADMISSION_AND_SELECTION.md, and HMOE-050 through HMOE-055.
 */

import { randomUUID } from "node:crypto";
import {
	EXPERT_ROUTING_SCHEMA_VERSION,
	type ExpertBinding,
	type ExpertSelectionMode,
	type ExpertSelectionPlan,
	type ScoredExpertCandidate,
	type WorkerCapabilityRequest,
} from "./contracts.ts";

export const EXPERT_RANKING_POLICY_VERSION = "1.0" as const;

export class ExpertRankingPolicy {
	readonly version: string = EXPERT_RANKING_POLICY_VERSION;

	/**
	 * Ranks scored candidates and materializes bindings according to the selection mode.
	 */
	select(
		request: WorkerCapabilityRequest,
		candidates: readonly ScoredExpertCandidate[],
		mode: ExpertSelectionMode = "single",
		options?: { traceId?: string },
	): ExpertSelectionPlan {
		if (candidates.length === 0) {
			throw new Error("Cannot rank empty candidate list.");
		}

		const traceId = options?.traceId ?? randomUUID();

		// Sort candidates by total score descending
		const sorted = [...candidates].sort((a, b) => b.features.totalScore - a.features.totalScore);

		let selectedCandidates: ScoredExpertCandidate[] = [];

		switch (mode) {
			case "single": {
				selectedCandidates = [sorted[0]];
				break;
			}
			case "parallel_scouts": {
				// Select up to 2 distinct models/experts for read-only scouting
				const primary = sorted[0];
				selectedCandidates = [primary];
				const secondary = sorted
					.slice(1)
					.find((c) => c.candidate.descriptor.model_id !== primary.candidate.descriptor.model_id);
				if (secondary) {
					selectedCandidates.push(secondary);
				} else if (sorted.length > 1) {
					selectedCandidates.push(sorted[1]);
				}
				break;
			}
			case "primary_critic": {
				// Select top primary and top independent critic
				const primary = sorted[0];
				selectedCandidates = [primary];
				const critic = sorted
					.slice(1)
					.find((c) => c.candidate.descriptor.model_id !== primary.candidate.descriptor.model_id);
				if (critic) {
					selectedCandidates.push(critic);
				} else if (sorted.length > 1) {
					selectedCandidates.push(sorted[1]);
				}
				break;
			}
			case "independent_verifier": {
				// Select highest scoring expert that satisfies requested independence level
				selectedCandidates = [sorted[0]];
				break;
			}
			case "committee": {
				// Max 3 candidates (committee ceiling rule 33)
				selectedCandidates = sorted.slice(0, Math.min(3, sorted.length));
				break;
			}
			default: {
				selectedCandidates = [sorted[0]];
				break;
			}
		}

		const bindings: ExpertBinding[] = selectedCandidates.map((sc) => {
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
		});

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
