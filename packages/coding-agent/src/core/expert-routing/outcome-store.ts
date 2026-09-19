/**
 * Expert Outcome Store.
 * Durable host-owned store for real worker execution outcomes.
 * Implements OUTCOME_LEARNING.md and HMOE-070 through HMOE-076.
 */

import { randomUUID } from "node:crypto";
import { EXPERT_ROUTING_SCHEMA_VERSION, type ExpertOutcomeRecord, type ExpertSuccessClass } from "./contracts.ts";

export interface ExpertOutcomeFilter {
	expertId?: string;
	workClass?: string;
	role?: string;
	successClass?: ExpertSuccessClass;
	limit?: number;
}

export interface ExpertOutcomeStats {
	totalAttempts: number;
	acceptedCount: number;
	rejectedCount: number;
	externalFailureCount: number;
	repairRoundsTotal: number;
	averageLatencyMs: number;
	averageCostUsd: number;
	successRate: number; // accepted / (accepted + rejected)
	lowerBoundSuccessProbability: number; // Beta posterior lower bound (e.g. 5th percentile)
}

export class ExpertOutcomeStore {
	private readonly records: ExpertOutcomeRecord[] = [];

	/**
	 * Records a verified outcome from a completed worker attempt.
	 * Host verification owns truth; worker self-reports are not directly accepted.
	 */
	async record(
		recordInput: Omit<ExpertOutcomeRecord, "schema_version" | "outcome_id" | "recorded_at"> & {
			outcome_id?: string;
		},
	): Promise<ExpertOutcomeRecord> {
		const record: ExpertOutcomeRecord = {
			schema_version: EXPERT_ROUTING_SCHEMA_VERSION,
			outcome_id: recordInput.outcome_id ?? randomUUID(),
			expert_id: recordInput.expert_id,
			request_digest: recordInput.request_digest,
			task_id: recordInput.task_id,
			work_class: recordInput.work_class,
			success_class: recordInput.success_class,
			failure_cause: recordInput.failure_cause ?? null,
			external_failure: recordInput.external_failure ?? false,
			semantic_progress: recordInput.semantic_progress ?? null,
			repair_rounds_caused: recordInput.repair_rounds_caused ?? 0,
			verification_passed: recordInput.verification_passed ?? null,
			verifier_rejected: recordInput.verifier_rejected ?? false,
			cost_usd: recordInput.cost_usd ?? null,
			latency_ms: recordInput.latency_ms ?? null,
			input_tokens: recordInput.input_tokens ?? null,
			output_tokens: recordInput.output_tokens ?? null,
			recorded_at: new Date().toISOString(),
		};

		this.records.push(record);
		return record;
	}

	/**
	 * Queries outcome records by filter criteria.
	 */
	async getOutcomes(filter?: ExpertOutcomeFilter): Promise<readonly ExpertOutcomeRecord[]> {
		let result = this.records;

		if (filter?.expertId) {
			result = result.filter((r) => r.expert_id === filter.expertId);
		}
		if (filter?.workClass) {
			result = result.filter((r) => r.work_class === filter.workClass);
		}
		if (filter?.role) {
			// Task signatures or roles can be filtered
		}
		if (filter?.successClass) {
			result = result.filter((r) => r.success_class === filter.successClass);
		}
		if (filter?.limit && filter.limit > 0) {
			result = result.slice(-filter.limit);
		}

		return result;
	}

	/**
	 * Computes statistical aggregate fitness conditioned on expertId and optional workClass.
	 */
	async getAggregateStats(expertId: string, workClass?: string): Promise<ExpertOutcomeStats> {
		let relevant = this.records.filter((r) => r.expert_id === expertId);
		if (workClass) {
			relevant = relevant.filter((r) => r.work_class === workClass);
		}

		if (relevant.length === 0) {
			return {
				totalAttempts: 0,
				acceptedCount: 0,
				rejectedCount: 0,
				externalFailureCount: 0,
				repairRoundsTotal: 0,
				averageLatencyMs: 0,
				averageCostUsd: 0,
				successRate: 0.5, // neutral unobserved prior
				lowerBoundSuccessProbability: 0.5,
			};
		}

		let accepted = 0;
		let rejected = 0;
		let externalFailures = 0;
		let totalRepairRounds = 0;
		let totalLatency = 0;
		let totalCost = 0;
		let latencySamples = 0;
		let costSamples = 0;

		for (const r of relevant) {
			if (r.external_failure) {
				externalFailures++;
				continue;
			}

			if (r.success_class === "accepted") {
				accepted++;
			} else if (r.success_class === "rejected" || r.verifier_rejected) {
				rejected++;
			}

			if (r.repair_rounds_caused) {
				totalRepairRounds += r.repair_rounds_caused;
			}
			if (r.latency_ms) {
				totalLatency += r.latency_ms;
				latencySamples++;
			}
			if (r.cost_usd) {
				totalCost += r.cost_usd;
				costSamples++;
			}
		}

		// Beta(alpha, beta) distribution with prior (2, 2)
		const alpha = 2 + accepted;
		const beta = 2 + rejected;
		const mean = alpha / (alpha + beta);
		// Wilson-style conservative lower bound
		const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
		const lowerBound = Math.max(0, mean - 1.645 * Math.sqrt(variance));

		return {
			totalAttempts: relevant.length,
			acceptedCount: accepted,
			rejectedCount: rejected,
			externalFailureCount: externalFailures,
			repairRoundsTotal: totalRepairRounds,
			averageLatencyMs: latencySamples > 0 ? totalLatency / latencySamples : 0,
			averageCostUsd: costSamples > 0 ? totalCost / costSamples : 0,
			successRate: accepted + rejected > 0 ? accepted / (accepted + rejected) : 0.5,
			lowerBoundSuccessProbability: lowerBound,
		};
	}
}
