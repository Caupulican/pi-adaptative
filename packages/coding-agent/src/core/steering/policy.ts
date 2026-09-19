/**
 * Steering policy configuration, constants, and evaluation rules.
 * Reference: policy/steering-policy.yaml
 */

import { createHash } from "node:crypto";
import type { SteeringCertificatePolicyRef } from "./types.ts";

export const STEERING_POLICY_VERSION = "1.2" as const;
export const STEERING_POLICY_ID = "pi:steering:policy:1.2" as const;

export const PINNED_JEV_MODEL = "jev-1.13.0" as const;
export const JEV_PROVIDER = "typesafe" as const;

export interface ConsequenceThresholds {
	readonly minimumNoul: number;
	readonly minimumConfidence: number;
	readonly failThreshold: number;
}

export const CONSEQUENCE_THRESHOLDS: Record<"low" | "medium" | "high" | "critical", ConsequenceThresholds> = {
	low: {
		minimumNoul: 0.55,
		minimumConfidence: 0.6,
		failThreshold: 0.7,
	},
	medium: {
		minimumNoul: 0.7,
		minimumConfidence: 0.75,
		failThreshold: 0.6,
	},
	high: {
		minimumNoul: 0.82,
		minimumConfidence: 0.85,
		failThreshold: 0.5,
	},
	critical: {
		minimumNoul: 0.9,
		minimumConfidence: 0.9,
		failThreshold: 0.4,
	},
};

export interface SteeringPolicyConfig {
	readonly version: string;
	readonly mode: "system_one_required" | "system_one_optional";
	readonly model: {
		readonly provider: string;
		readonly id: string;
		readonly pin: boolean;
	};
	readonly interaction: {
		readonly mode: "start_only";
		readonly runtime_approval: "never";
		readonly notification: "terminal_only";
	};
	readonly semantic_transition: {
		readonly certificate_required: boolean;
		readonly fail_open: boolean;
		readonly human_fallback: boolean;
		readonly on_low_confidence: readonly string[];
	};
	readonly specialist_synthesis: {
		readonly default_lifetime: "one_task" | "session" | "project" | "global";
		readonly require_need_certificate: string;
		readonly require_fit_certificate: string;
		readonly require_spec_certificate: string;
		readonly require_dependencies_certificate: string;
		readonly require_materialization_certificate: string;
		readonly require_effectiveness_certificate: string;
		readonly require_retention_certificate: string;
		readonly project_global_promotion_certificate: string;
	};
	readonly semantic_dedup: {
		readonly enabled: boolean;
		readonly default: "block_unintentional";
		readonly explicit_duplication_override: "objective_only";
		readonly pre_implementation_certificate: string;
		readonly disposition_certificate: string;
		readonly post_mutation_certificate: string;
		readonly completion_certificate: string;
		readonly waiver_certificate: string;
		readonly textual_clone_gate_required: boolean;
	};
	readonly completion: {
		readonly primary_certificate: string;
		readonly adversarial_certificate: string;
		readonly delivery_claim_certificate: string;
		readonly release_readiness_certificate: string;
	};
}

export const DEFAULT_STEERING_POLICY: SteeringPolicyConfig = {
	version: STEERING_POLICY_VERSION,
	mode: "system_one_required",
	model: {
		provider: JEV_PROVIDER,
		id: PINNED_JEV_MODEL,
		pin: true,
	},
	interaction: {
		mode: "start_only",
		runtime_approval: "never",
		notification: "terminal_only",
	},
	semantic_transition: {
		certificate_required: true,
		fail_open: false,
		human_fallback: false,
		on_low_confidence: ["gather_more_evidence", "improve_projection", "independent_worker", "reroute", "fail_closed"],
	},
	specialist_synthesis: {
		default_lifetime: "one_task",
		require_need_certificate: "JEV-031",
		require_fit_certificate: "JEV-032",
		require_spec_certificate: "JEV-033",
		require_dependencies_certificate: "JEV-034",
		require_materialization_certificate: "JEV-035",
		require_effectiveness_certificate: "JEV-036",
		require_retention_certificate: "JEV-038",
		project_global_promotion_certificate: "JEV-039",
	},
	semantic_dedup: {
		enabled: true,
		default: "block_unintentional",
		explicit_duplication_override: "objective_only",
		pre_implementation_certificate: "JEV-041",
		disposition_certificate: "JEV-042",
		post_mutation_certificate: "JEV-043",
		completion_certificate: "JEV-044",
		waiver_certificate: "JEV-045",
		textual_clone_gate_required: true,
	},
	completion: {
		primary_certificate: "JEV-025",
		adversarial_certificate: "JEV-026",
		delivery_claim_certificate: "JEV-027",
		release_readiness_certificate: "JEV-028",
	},
};

export function computePolicyDigest(policy: SteeringPolicyConfig = DEFAULT_STEERING_POLICY): string {
	return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

export function getPolicyRef(policy: SteeringPolicyConfig = DEFAULT_STEERING_POLICY): SteeringCertificatePolicyRef {
	return {
		id: STEERING_POLICY_ID,
		version: policy.version,
		digest: computePolicyDigest(policy),
	};
}
