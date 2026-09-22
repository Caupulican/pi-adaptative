/**
 * Expert Hard Admission Policy.
 * Implements ADMISSION_AND_SELECTION.md, STRICT_RULES.md (Rules 9-18), and HMOE-029.
 */

import type { WorkerRole } from "../orchestration/contracts.ts";
import type { WorkerModelPinPolicy } from "../orchestration/worker-model-pins.ts";
import { resolveWorkerModelPin } from "../orchestration/worker-model-pins.ts";
import type { CandidateAdmissionEvaluation, ExpertCandidate, WorkerCapabilityRequest } from "./contracts.ts";

export interface ExpertAdmissionPolicyDeps {
	modelPinPolicy?: WorkerModelPinPolicy;
}

export class ExpertAdmissionPolicy {
	private readonly deps: ExpertAdmissionPolicyDeps;

	constructor(deps: ExpertAdmissionPolicyDeps = {}) {
		this.deps = deps;
	}

	/**
	 * Evaluates hard admission filters for a candidate expert against the capability request.
	 * Returns allowed: boolean and list of rejection reason codes.
	 */
	evaluate(request: WorkerCapabilityRequest, candidate: ExpertCandidate): CandidateAdmissionEvaluation {
		const reasons: string[] = [];
		const desc = candidate.descriptor;
		const state = candidate.state;

		// 1. Authentication
		if (!state.authenticated) {
			reasons.push("auth_missing");
		}

		// 2. Quota & Provider Exhaustion
		if (state.quotaExhausted || !state.providerHealthy) {
			reasons.push("quota_exhausted");
		}

		// 3. Excluded Experts / Models / Providers
		if (request.excluded_expert_ids?.includes(desc.expert_id)) {
			reasons.push("expert_excluded");
		}

		const modelRef = `${desc.provider}/${desc.model_id}`;
		if (request.excluded_model_refs?.includes(desc.model_id) || request.excluded_model_refs?.includes(modelRef)) {
			reasons.push("model_excluded");
		}

		if (request.excluded_providers?.includes(desc.provider)) {
			reasons.push("provider_denied");
		}

		// 3b. Operator pool boundary (hard): an automatic route may never leave the customized pool.
		if (request.allowed_model_refs && !request.allowed_model_refs.includes(modelRef)) {
			reasons.push("model_not_in_pool");
		}

		// 4. Privacy and Locality Constraints
		if (request.local_only && desc.runtime_kind === "remote") {
			reasons.push("privacy_violation");
		}
		if (request.remote_allowed === false && desc.runtime_kind === "remote") {
			reasons.push("privacy_violation");
		}

		// 5. Context Window Capacity
		if (
			request.minimum_context_window !== undefined &&
			request.minimum_context_window !== null &&
			request.minimum_context_window > 0
		) {
			if (!desc.context_window || desc.context_window < request.minimum_context_window) {
				reasons.push("context_insufficient");
			}
		}

		// 6. Cost Hard Ceiling
		if (request.max_cost_usd !== undefined && request.max_cost_usd !== null && state.estimatedCostUsd !== undefined) {
			if (state.estimatedCostUsd > request.max_cost_usd) {
				reasons.push("cost_hard_limit");
			}
		}

		// 7. Required Capabilities & Tools
		if (request.required_capabilities && request.required_capabilities.length > 0) {
			for (const cap of request.required_capabilities) {
				if (cap === "reasoning" && desc.thinking_level === "off") {
					reasons.push("thinking_unsupported");
				} else if (cap === "image_input" && candidate.card?.image !== true) {
					reasons.push("image_input_unsupported");
				} else if (cap.startsWith("tier:")) {
					const requiredTier = cap.slice("tier:".length);
					if (desc.capability_tier && desc.capability_tier !== requiredTier) {
						reasons.push("tier_unsupported");
					}
				}
			}
		}

		if (request.required_tools && request.required_tools.length > 0) {
			const availableTools = new Set(desc.tool_names ?? []);
			const missing = request.required_tools.some((t) => !availableTools.has(t));
			if (missing) {
				reasons.push("tools_insufficient");
			}
		}

		// 8. Local Resource Constraints
		if (desc.runtime_kind !== "remote" && state.localResourcesInsufficient) {
			reasons.push("local_resource_insufficient");
		}

		// 9. Owner Model Pins (Hard constraint)
		if (this.deps.modelPinPolicy) {
			const pin = resolveWorkerModelPin(this.deps.modelPinPolicy, desc.role as WorkerRole);
			if (pin) {
				const pinModelId = pin.binding.modelId;
				const pinProvider = pin.binding.provider;
				if (pinModelId !== desc.model_id || (pinProvider && pinProvider !== desc.provider)) {
					reasons.push("owner_pin_mismatch");
				}
				if (pin.binding.thinkingLevel && pin.binding.thinkingLevel !== desc.thinking_level) {
					reasons.push("owner_pin_mismatch");
				}
			}
		}

		// 10. Independence Requirements
		if (request.independence_level && request.independence_level !== "none") {
			if (request.independence_level === "distinct_provider") {
				if (request.excluded_providers?.includes(desc.provider)) {
					reasons.push("independence_violation");
				}
			} else if (
				request.independence_level === "distinct_model" ||
				request.independence_level === "distinct_family"
			) {
				if (
					request.excluded_model_refs?.includes(desc.model_id) ||
					request.excluded_model_refs?.includes(modelRef)
				) {
					reasons.push("independence_violation");
				}
			} else if (request.independence_level === "distinct_profile") {
				if (request.excluded_expert_ids?.includes(desc.expert_id)) {
					reasons.push("independence_violation");
				}
			}
		}

		return {
			allowed: reasons.length === 0,
			reasonCodes: reasons,
		};
	}
}
