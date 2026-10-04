/** Roles a freshly probed model can be assigned to, mapped to their settings by the caller. */
export type FitnessRole =
	| "curator"
	| "executor"
	| "scout"
	| "router-cheap"
	| "router-medium"
	| "router-expensive"
	| "learning"
	| "none";
