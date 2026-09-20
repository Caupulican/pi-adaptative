export type OperatorPhase = "understand" | "plan" | "build" | "adapt" | "verify" | "deliver" | "blocked" | "done";

export type OperatorHealth = "normal" | "attention" | "blocked" | "complete";

export interface ActiveActor {
	readonly id: string;
	readonly kind: "root" | "specialist" | "worker" | "verifier" | "capability";
	readonly label: string;
	readonly elapsedMs?: number;
}

export interface AdaptationProjection {
	readonly kind: "specialist" | "capability" | "runtime" | "expert";
	readonly label: string;
	readonly state: "planning" | "building" | "verifying" | "active";
}

export interface ProofProgress {
	readonly satisfied: number;
	readonly total: number;
	readonly failing: number;
	readonly pending: number;
}

export interface OperatorContextInfo {
	readonly percent?: number;
	readonly compacted?: boolean;
}

/** Who owns the next objective transition: the semantic plane, the root loop, or the operator. */
export type OperatorControlOwner = "system_one" | "root" | "user";

/** What that owner is doing with control right now. */
export type OperatorControlState = "deciding" | "executing" | "observing" | "verifying" | "awaiting_user";

/**
 * Control is a reason-coded runtime fact, never a narration: `owner` is who decides what happens
 * next, `state` is what that owner is doing with it, and `reasonCode` is the runtime code the
 * decision came from. Deliberately independent of `active_actors`, which says who is executing now.
 */
export interface OperatorControlProjection {
	readonly owner: OperatorControlOwner;
	readonly state: OperatorControlState;
	/** The continuation/derivation reason code control was resolved from. */
	readonly reasonCode?: string | null;
	/** The open human-input request id, set only while the operator owns control. */
	readonly clarificationRequestId?: string | null;
	/** Bounded text of what the owner has to resolve; set only while control is blocked on them. */
	readonly blocker?: string | null;
}

export interface OperatorProjection {
	readonly schema_version: "1.0";
	readonly objective_id: string;
	readonly title: string;
	readonly phase: OperatorPhase;
	readonly phase_index: number;
	readonly phase_count: number;
	readonly current_action: string;
	readonly why: string;
	readonly next_action?: string | null;
	readonly health: OperatorHealth;
	readonly control: OperatorControlProjection;
	readonly active_actors: readonly ActiveActor[];
	readonly adaptation?: AdaptationProjection | null;
	readonly proof: ProofProgress;
	readonly context?: OperatorContextInfo | null;
}

export interface OperatorEvent {
	readonly id: string;
	readonly timestamp: string;
	readonly severity: "info" | "success" | "warning" | "failure";
	readonly category:
		| "plan"
		| "worker"
		| "adaptation"
		| "verification"
		| "rule"
		| "dedup"
		| "compaction"
		| "acquisition"
		| "delivery";
	readonly title: string;
	readonly detail?: string;
	readonly debugRefs?: readonly string[];
}
