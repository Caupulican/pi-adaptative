import type { CompletionAssuranceProfile } from "./policy.ts";

export type RequestedCompletionProfile = CompletionAssuranceProfile | "reviewer";

export type CompletionSteeringMode = "system_one_required" | "system_one_optional";

/**
 * Effective completion profile for an objective.
 * An active `system_one_required` steering mode wins over every weaker requested profile.
 * Optional steering keeps an explicit profile. With no semantic plane and no request, the
 * profile stays mechanical.
 */
export function resolveEffectiveCompletionProfile(input: {
	readonly requestedProfile?: RequestedCompletionProfile;
	readonly steeringMode?: CompletionSteeringMode;
	readonly systemOneBound: boolean;
}): CompletionAssuranceProfile {
	if (input.steeringMode === "system_one_required") {
		return "system_one_required";
	}
	const requested = input.requestedProfile === "reviewer" ? "mechanical_plus_reviewer" : input.requestedProfile;
	if (requested) {
		return requested;
	}
	if (!input.systemOneBound) {
		return "mechanical";
	}
	return "semantic_enhanced";
}
