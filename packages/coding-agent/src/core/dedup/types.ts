/**
 * Semantic Responsibility Deduplication types.
 * Normative reference: URN urn:pi:dedup:* schemas and policy/semantic-dedup-policy.yaml.
 */

export type ResponsibilityRecordStatus = "active" | "superseded" | "retired" | "candidate";

export interface ResponsibilityRecord {
	readonly schema_version: "1.0";
	readonly responsibility_id: string;
	readonly statement: string;
	readonly owner_locations: readonly string[];
	readonly requirement_ids?: readonly string[];
	readonly inputs?: readonly string[];
	readonly outputs?: readonly string[];
	readonly side_effects?: readonly string[];
	readonly invariants?: readonly string[];
	readonly source_revision: string;
	readonly source_digest?: string | null;
	readonly evidence_refs: readonly string[];
	readonly uniqueness_certificate_id?: string | null;
	readonly supersedes?: readonly string[];
	readonly status: ResponsibilityRecordStatus;
}

export type DispositionOutcome =
	| "unique"
	| "reuse_existing"
	| "extend_existing"
	| "extract_shared"
	| "separate_required"
	| "insufficient_evidence";

export interface ResponsibilityDisposition {
	readonly schema_version: "1.0";
	readonly disposition_id: string;
	readonly objective_id: string;
	readonly task_id?: string | null;
	readonly proposed_responsibility: string;
	readonly candidate_ids: readonly string[];
	readonly outcome: DispositionOutcome;
	readonly target_responsibility_id?: string | null;
	readonly certificate_refs: readonly string[];
	readonly waiver_id?: string | null;
}

export interface IntentionalDuplicationWaiver {
	readonly schema_version: "1.0";
	readonly waiver_id: string;
	readonly objective_id: string;
	readonly responsibility_scope: string;
	readonly allowed_locations?: readonly string[];
	readonly reason: string;
	readonly source: "user_objective" | "owner_policy";
	readonly expires_with_objective: boolean;
}

export interface ResponsibilityStatement {
	readonly statement: string;
	readonly requirementIds?: readonly string[];
	readonly targetLocation: string;
	readonly inputs?: readonly string[];
	readonly outputs?: readonly string[];
	readonly sideEffects?: readonly string[];
	readonly invariants?: readonly string[];
}

export interface ResponsibilityCandidate {
	readonly id: string;
	readonly statement: string;
	readonly locations: readonly string[];
	readonly matchMethod:
		| "responsibility_registry"
		| "textual_clone"
		| "symbol_reference"
		| "dependency_api_signature"
		| "structural_fingerprint"
		| "repo_search";
	readonly score: number;
	readonly compact: Record<string, unknown>;
}

export interface PostMutationDedupVerdict {
	readonly unintentionalDuplicate: boolean;
	readonly duplicateResponsibilityId?: string;
	readonly existingOwnerLocation?: string;
	readonly certificateId: string;
	readonly reason: string;
}
