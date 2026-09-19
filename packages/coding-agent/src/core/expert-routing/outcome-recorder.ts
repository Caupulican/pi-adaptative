/**
 * Expert Outcome Recorder.
 * Ingests host-verified worker execution results and records outcome evidence.
 * Implements reference/outcome-learning.ts, OUTCOME_LEARNING.md, and HMOE-070.
 */

import type { WorkerResultContract } from "../orchestration/contracts.ts";
import type { ExpertBinding, ExpertOutcomeRecord, ExpertSuccessClass, WorkerCapabilityRequest } from "./contracts.ts";
import type { ExpertOutcomeStore } from "./outcome-store.ts";

export interface RecordExpertAttemptInput {
	binding: ExpertBinding;
	request: WorkerCapabilityRequest;
	attemptId?: string;
	role?: string;
	taskSignatureDigest?: string;
	result?: WorkerResultContract;
	verificationPassed?: boolean;
	verifierRejected?: boolean;
	completionChallengeRejected?: boolean;
	repairRoundsCaused?: number;
	semanticProgress?: number;
	failureClassification?: string;
	costUsd?: number;
	latencyMs?: number;
}

export class ExpertOutcomeRecorder {
	private readonly store: ExpertOutcomeStore;

	constructor(store: ExpertOutcomeStore) {
		this.store = store;
	}

	/**
	 * Ingests host-verified worker attempt outcome and persists to the outcome store.
	 */
	async record(input: RecordExpertAttemptInput): Promise<ExpertOutcomeRecord> {
		let successClass: ExpertSuccessClass = "accepted";
		let externalFailure = false;
		let failureCause = input.failureClassification ?? null;

		if (input.verifierRejected || input.completionChallengeRejected) {
			successClass = "rejected";
			failureCause =
				failureCause ?? (input.verifierRejected ? "verifier_rejection" : "completion_challenge_rejected");
		} else if (input.verificationPassed === false) {
			successClass = "rejected";
			failureCause = failureCause ?? "verification_failed";
		} else if (input.result?.status === "failed") {
			const firstError =
				input.result.errors?.[0] ??
				(input.result as unknown as { error?: { code?: string; message?: string } }).error;
			const code = firstError?.code ?? input.result.reasonCode ?? "";
			if (
				code.includes("provider") ||
				code.includes("quota") ||
				code.includes("rate_limit") ||
				code.includes("network")
			) {
				successClass = "environment_failure";
				externalFailure = true;
				failureCause = code || "external_provider_failure";
			} else if (code.includes("contract")) {
				successClass = "worker_contract_failure";
				failureCause = code;
			} else {
				successClass = "rejected";
				failureCause = firstError?.message ?? input.result.summary ?? "worker_attempt_failed";
			}
		}

		return await this.store.record({
			expert_id: input.binding.expert_id,
			selection_id: input.binding.selection_id,
			selection_trace_id: input.binding.selection_trace_id,
			attempt_id: input.attemptId ?? input.request.task_id,
			request_digest: input.request.request_id,
			task_id: input.request.task_id,
			work_class: input.request.work_class,
			role: input.role ?? input.request.worker_role,
			task_signature_digest: input.taskSignatureDigest ?? null,
			success_class: successClass,
			failure_cause: failureCause,
			external_failure: externalFailure,
			semantic_progress: input.semanticProgress ?? null,
			repair_rounds_caused: input.repairRoundsCaused ?? 0,
			verification_passed: input.verificationPassed ?? null,
			verifier_rejected: Boolean(input.verifierRejected),
			cost_usd: input.costUsd ?? input.binding.expected_cost_usd ?? null,
			latency_ms: input.latencyMs ?? input.binding.expected_latency_ms ?? null,
			input_tokens: input.result?.usage?.inputTokens ?? null,
			output_tokens: input.result?.usage?.outputTokens ?? null,
		});
	}
}
