export type ExpertIndependenceLevel =
	| "none"
	| "fresh_context"
	| "distinct_profile"
	| "distinct_model"
	| "distinct_family"
	| "distinct_provider";

export type HmoePreset = "balanced" | "quality" | "subscription-first" | "cost" | "speed" | "local-first" | "custom";

export type HmoeTeamStrategy = "single" | "primary_critic" | "independent_verifier" | "adaptive_team";

export type HmoeIndependence = ExpertIndependenceLevel;

export type HmoePreference = "prefer_subscription" | "prefer_local" | "neutral";

export interface HmoeWeights {
	ability?: number;
	reliability?: number;
	operational?: number;
	capabilityFit?: number;
	reasoningFit?: number;
	contextFit?: number;
	probeFit?: number;
	outcomeFit?: number;
	cost?: number;
	latency?: number;
	availability?: number;
	localResourceFit?: number;
	diversity?: number;
	privacy?: number;
}
