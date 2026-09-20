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
	readonly source: string;
	readonly command?: string;
	readonly capabilityId?: string;
	readonly revision?: string;
	readonly checksum?: string;
	readonly scriptContent?: string;
	readonly signal?: AbortSignal;
}

export interface AcquisitionDecision {
	readonly disposition: AcquisitionDisposition;
	readonly chosenRoute?: string;
	readonly record: ExternalAcquisitionRecord;
	readonly summaryEvent?: string;
	readonly allowed: boolean;
	readonly rewritten: boolean;
	readonly denied: boolean;
}
