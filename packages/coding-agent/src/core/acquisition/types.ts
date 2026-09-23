export type AcquisitionDisposition = "allow" | "rewrite_safe_route" | "deny";

export interface DeterministicFinding {
	readonly id: string;
	readonly level: "deny" | "warn" | "info";
	readonly message: string;
	readonly pattern?: string;
}

export interface ExternalAcquisitionRecord {
	readonly schema_version: "1.0";
	readonly record_id: string;
	readonly objective_id: string;
	readonly capability_id?: string | null;
	readonly source: string;
	readonly revision?: string | null;
	readonly digest?: string | null;
	readonly deterministic_findings: readonly DeterministicFinding[];
	readonly jev_certificate_id?: string | null;
	readonly disposition: AcquisitionDisposition;
	readonly chosen_route?: string | null;
	readonly created_at: string;
}

export interface AcquisitionRequest {
	readonly objectiveId: string;
	/** The owner's request the acquisition serves, for System One's judgment. */
	readonly request?: string;
	readonly source: string;
	readonly command?: string;
	readonly capabilityId?: string;
	readonly revision?: string;
	readonly checksum?: string;
	readonly scriptContent?: string;
	readonly signal?: AbortSignal;
}

/**
 * A safe route resolved to something that can actually be executed. A route label alone is not a
 * route: the caller has to be handed the command it should run instead.
 */
export interface ResolvedSafeRoute {
	readonly route: string;
	/** The exact command to run in place of the rejected one, when one exists. */
	readonly command?: string;
	/** Why this route replaces the request, for the operator and the model. */
	readonly rationale: string;
	/** True when the route is a plan a human or the model must carry out, not a command. */
	readonly requiresManualStep: boolean;
}

export interface AcquisitionDecision {
	readonly disposition: AcquisitionDisposition;
	readonly chosenRoute?: string;
	/** Present whenever the disposition is `rewrite_safe_route`. */
	readonly resolvedRoute?: ResolvedSafeRoute;
	readonly record: ExternalAcquisitionRecord;
	readonly summaryEvent?: string;
	readonly allowed: boolean;
	readonly rewritten: boolean;
	readonly denied: boolean;
}
