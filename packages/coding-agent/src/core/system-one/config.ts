/**
 * System One Reference Configuration and Thresholds.
 * Normative reference: jev_harness_reference_config.yaml
 */

export interface SystemOneStateBudget {
	readonly target_tokens: number;
	readonly soft_limit_tokens: number;
	readonly hard_limit_tokens: number;
	readonly api_state_plus_longest_question_limit_tokens: number;
	readonly api_total_request_limit_tokens: number;
}

export interface SystemOneChoiceThresholds {
	readonly normal_auto_confidence: number;
	readonly hard_gate_auto_confidence: number;
	readonly review_floor: number;
	readonly min_top2_margin_normal: number;
	readonly min_top2_margin_hard: number;
}

export interface SystemOneNoulRequiredTrueThresholds {
	readonly hard_pass: number;
	readonly soft_pass: number;
	readonly ambiguous_low: number;
	readonly ambiguous_high: number;
	readonly hard_fail: number;
}

export interface SystemOneNoulRequiredFalseThresholds {
	readonly hard_pass_max: number;
	readonly soft_pass_max: number;
	readonly ambiguous_low: number;
	readonly ambiguous_high: number;
	readonly hard_fail_min: number;
}

export interface SystemOneScoreThresholds {
	readonly require_confidence_for_hard_gate: number;
}

export interface SystemOneThresholds {
	readonly choice: SystemOneChoiceThresholds;
	readonly noul_required_true: SystemOneNoulRequiredTrueThresholds;
	readonly noul_required_false: SystemOneNoulRequiredFalseThresholds;
	readonly score: SystemOneScoreThresholds;
}

export interface SystemOneLifecycleConfig {
	readonly max_completion_attempts_before_forced_replan: number;
	readonly max_same_strategy_failures: number;
	readonly recent_action_window: number;
	readonly validation_after_every_repo_mutation: boolean;
	readonly validation_after_failed_tool: boolean;
	readonly completion_cold_review: boolean;
}

export interface SystemOneFailurePolicy {
	readonly jev_unavailable_read_only: "allow_with_audit" | "block";
	readonly jev_unavailable_repo_mutation: "block_and_retry" | "block";
	readonly jev_unavailable_external_side_effect: "block";
	readonly invalid_response: "block_and_retry" | "block";
	readonly rate_limit_exhausted: "degrade_read_only_or_escalate" | "block";
}

export interface SystemOneTrustPolicy {
	readonly worker_can_modify_questions: false;
	readonly worker_can_modify_thresholds: false;
	readonly worker_can_build_validator_state: false;
	readonly worker_can_mark_complete: false;
	readonly jev_can_authorize_tools: false;
	readonly jev_can_override_deterministic_failure: false;
}

export interface SystemOneSecurityConfig {
	readonly redact_secrets_before_remote_validation: boolean;
	readonly repository_text_is_untrusted: boolean;
	readonly external_text_is_untrusted: boolean;
	readonly store_raw_jev_state: boolean;
	readonly store_state_hash: boolean;
	readonly store_question_hash: boolean;
	readonly store_model_version: boolean;
}

export interface SystemOneConfig {
	readonly enabled: boolean;
	readonly provider: "typesafe" | "openrouter";
	readonly model: {
		readonly production: string;
		readonly preview: string;
		readonly pin_required: boolean;
	};
	readonly language: string;
	readonly state_budget: SystemOneStateBudget;
	readonly thresholds: SystemOneThresholds;
	readonly lifecycle: SystemOneLifecycleConfig;
	readonly failure_policy: SystemOneFailurePolicy;
	readonly trust: SystemOneTrustPolicy;
	readonly security: SystemOneSecurityConfig;
}

export const DEFAULT_SYSTEM_ONE_CONFIG: SystemOneConfig = Object.freeze({
	enabled: true,
	provider: "typesafe",
	model: Object.freeze({
		production: "jev-1.13.0",
		preview: "jev-preview",
		pin_required: true,
	}),
	language: "en",

	state_budget: Object.freeze({
		target_tokens: 12000,
		soft_limit_tokens: 20000,
		hard_limit_tokens: 28000,
		api_state_plus_longest_question_limit_tokens: 32000,
		api_total_request_limit_tokens: 64000,
	}),

	thresholds: Object.freeze({
		choice: Object.freeze({
			normal_auto_confidence: 0.88,
			hard_gate_auto_confidence: 0.93,
			review_floor: 0.65,
			min_top2_margin_normal: 0.15,
			min_top2_margin_hard: 0.2,
		}),
		noul_required_true: Object.freeze({
			hard_pass: 0.93,
			soft_pass: 0.85,
			ambiguous_low: 0.3,
			ambiguous_high: 0.7,
			hard_fail: 0.2,
		}),
		noul_required_false: Object.freeze({
			hard_pass_max: 0.07,
			soft_pass_max: 0.15,
			ambiguous_low: 0.3,
			ambiguous_high: 0.7,
			hard_fail_min: 0.8,
		}),
		score: Object.freeze({
			require_confidence_for_hard_gate: 0.88,
		}),
	}),

	lifecycle: Object.freeze({
		max_completion_attempts_before_forced_replan: 3,
		max_same_strategy_failures: 2,
		recent_action_window: 8,
		validation_after_every_repo_mutation: true,
		validation_after_failed_tool: true,
		completion_cold_review: true,
	}),

	failure_policy: Object.freeze({
		jev_unavailable_read_only: "allow_with_audit",
		jev_unavailable_repo_mutation: "block_and_retry",
		jev_unavailable_external_side_effect: "block",
		invalid_response: "block_and_retry",
		rate_limit_exhausted: "degrade_read_only_or_escalate",
	}),

	trust: Object.freeze({
		worker_can_modify_questions: false,
		worker_can_modify_thresholds: false,
		worker_can_build_validator_state: false,
		worker_can_mark_complete: false,
		jev_can_authorize_tools: false,
		jev_can_override_deterministic_failure: false,
	}),

	security: Object.freeze({
		redact_secrets_before_remote_validation: true,
		repository_text_is_untrusted: true,
		external_text_is_untrusted: true,
		store_raw_jev_state: false,
		store_state_hash: true,
		store_question_hash: true,
		store_model_version: true,
	}),
});

export const OPENROUTER_SYSTEM_ONE_CONFIG: SystemOneConfig = Object.freeze({
	...DEFAULT_SYSTEM_ONE_CONFIG,
	provider: "openrouter",
	model: Object.freeze({
		production: "typesafe/jev-1.13",
		preview: "typesafe/jev-latest",
		pin_required: true,
	}),
});

export function createSystemOneConfig(options?: {
	enabled?: boolean;
	provider?: "typesafe" | "openrouter";
	productionModel?: string;
	previewModel?: string;
	pinRequired?: boolean;
}): SystemOneConfig {
	const provider = options?.provider ?? "typesafe";
	const base = provider === "openrouter" ? OPENROUTER_SYSTEM_ONE_CONFIG : DEFAULT_SYSTEM_ONE_CONFIG;
	return Object.freeze({
		...base,
		enabled: options?.enabled ?? base.enabled,
		provider,
		model: Object.freeze({
			production: options?.productionModel ?? base.model.production,
			preview: options?.previewModel ?? base.model.preview,
			pin_required: options?.pinRequired ?? base.model.pin_required,
		}),
	});
}
