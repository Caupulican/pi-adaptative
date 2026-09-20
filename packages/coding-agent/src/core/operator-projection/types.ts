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
