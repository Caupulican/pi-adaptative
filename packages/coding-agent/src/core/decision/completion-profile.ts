import type { CompletionAssuranceProfile } from "./policy.ts";

export type RequestedCompletionProfile = CompletionAssuranceProfile | "reviewer";

export type CompletionSteeringMode = "system_one_required" | "system_one_optional";

/**
 * Effective completion profile for an objective.
 * Explicit disablement keeps completion mechanical, with an independently requested root
 * reviewer still available. An enabled required plane retains its gate when unavailable;
 * absence alone must never turn a failed required evaluation into a successful one.
 */
export function resolveEffectiveCompletionProfile(input: {
	readonly requestedProfile?: RequestedCompletionProfile;
	readonly steeringMode?: CompletionSteeringMode;
	readonly systemOneBound: boolean;
	readonly systemOneEnabled?: boolean;
}): CompletionAssuranceProfile {
	const requested = input.requestedProfile === "reviewer" ? "mechanical_plus_reviewer" : input.requestedProfile;
	if (input.systemOneEnabled === false) {
		return requested === "mechanical_plus_reviewer" ? requested : "mechanical";
	}
	if (input.steeringMode === "system_one_required") {
		return "system_one_required";
	}
	if (requested) {
		return requested;
	}
	if (!input.systemOneBound) {
		return "mechanical";
	}
	return "semantic_enhanced";
}
