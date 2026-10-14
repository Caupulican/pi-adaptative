export type DeliveryTerminalStatus =
	| "complete"
	| "incomplete"
	| "blocked_external"
	| "blocked_by_initial_authority"
	| "owner_required"
	| "budget_exhausted"
	| "cancelled"
	| "unrecoverable"
	| "semantic_gate_unavailable";

export interface DeliveryArtifact {
	readonly path: string;
	readonly description?: string;
	readonly hash?: string;
	readonly sizeBytes?: number;
}

export interface DeliveryVerificationRecord {
	readonly gateId: string;
	readonly status: "passed" | "failed" | "waived";
	readonly required: boolean;
	readonly detail?: string;
}

export type SideEffectReceipt<T> =
	| { readonly state: "attempted"; readonly detail: T }
	| { readonly state: "succeeded"; readonly detail: T }
	| { readonly state: "proven"; readonly detail: T }
	| { readonly state: "failed"; readonly error: string; readonly detail?: T };

export function sideEffectSucceeded<T>(
	receipt: SideEffectReceipt<T> | undefined,
): receipt is Exclude<SideEffectReceipt<T>, { state: "failed" }> {
	return receipt !== undefined && receipt.state !== "failed";
}

export function sideEffectDetail<T>(receipt: SideEffectReceipt<T> | undefined): T | undefined {
	return receipt && receipt.state !== "failed" ? receipt.detail : receipt?.detail;
}

export interface CommitReceipt {
	readonly sha: string;
	readonly message?: string;
}

export interface PushReceipt {
	readonly remote: string;
	readonly ref: string;
	readonly observedSha: string;
}

export interface PublishReceipt {
	readonly publicationId: string;
	readonly packageName?: string;
	readonly version?: string;
	readonly registry?: string;
	readonly integrity?: string;
}

export interface DeployReceipt {
	readonly target: string;
	readonly deploymentId?: string;
}

export interface GithubReleaseReceipt {
	readonly repository?: string;
	readonly tag?: string;
}

export interface DeliverySideEffects {
	readonly commit?: SideEffectReceipt<CommitReceipt>;
	readonly push?: SideEffectReceipt<PushReceipt>;
	readonly deploy?: readonly SideEffectReceipt<DeployReceipt>[];
	readonly tag?: SideEffectReceipt<{ tag: string; targetSha?: string }>;
	readonly publish?: SideEffectReceipt<PublishReceipt>;
	readonly github_release?: SideEffectReceipt<GithubReleaseReceipt>;
}

export interface DeliveryBundle {
	readonly schema_version: "2.0";
	readonly objective_id: string;
	readonly terminal_status: DeliveryTerminalStatus;
	readonly source_revision: string;
	readonly acceptance: Record<string, unknown>;
	readonly verification: readonly DeliveryVerificationRecord[];
	readonly artifacts: readonly DeliveryArtifact[];
	readonly limitations: readonly string[];
	readonly decision_refs?: readonly string[];
	readonly steering_certificate_refs?: readonly string[];
	readonly specialist_refs?: readonly string[];
	readonly capability_refs?: readonly string[];
	readonly responsibility_disposition_refs?: readonly string[];
	readonly waiver_refs?: readonly string[];
	readonly final_commit?: string;
	readonly push_refs?: readonly string[];
	readonly publication_refs?: readonly string[];
	readonly usage?: Record<string, unknown>;
	readonly assurance_profile_requested?: string;
	readonly assurance_profile_used?: string;
	readonly reviewer_refs?: readonly string[];
	readonly failed_gates?: readonly string[];
	readonly required_next_proof?: readonly string[];
	readonly changed_files?: readonly string[];
	readonly diff_digest?: string;
	readonly candidate_snapshot?: {
		readonly repoRoot: string;
		readonly baseRevision: string;
		readonly candidateRevision: string;
		readonly digest: string;
		readonly untrackedPaths: readonly string[];
	};
	readonly side_effects?: DeliverySideEffects;
}

export function buildDeliveryBundle(input: {
	readonly objectiveId: string;
	readonly terminalStatus: DeliveryTerminalStatus;
	readonly sourceRevision: string;
	readonly acceptance?: Record<string, unknown>;
	readonly verification?: readonly DeliveryVerificationRecord[];
	readonly artifacts?: readonly DeliveryArtifact[];
	readonly limitations?: readonly string[];
	readonly decisionRefs?: readonly string[];
	readonly usage?: Record<string, unknown>;
	readonly assuranceProfileRequested?: string;
	readonly assuranceProfileUsed?: string;
	readonly reviewerRefs?: readonly string[];
	readonly failedGates?: readonly string[];
	readonly requiredNextProof?: readonly string[];
	readonly changedFiles?: readonly string[];
	readonly diffDigest?: string;
	readonly candidateSnapshot?: DeliveryBundle["candidate_snapshot"];
	readonly steeringCertificateRefs?: readonly string[];
	readonly specialistRefs?: readonly string[];
	readonly capabilityRefs?: readonly string[];
	readonly responsibilityDispositionRefs?: readonly string[];
	readonly waiverRefs?: readonly string[];
	readonly finalCommit?: string;
	readonly pushRefs?: readonly string[];
	readonly publicationRefs?: readonly string[];
	readonly sideEffects?: DeliverySideEffects;
}): DeliveryBundle {
	return {
		schema_version: "2.0",
		objective_id: input.objectiveId,
		terminal_status: input.terminalStatus,
		source_revision: input.sourceRevision,
		acceptance: input.acceptance ?? {},
		verification: input.verification ?? [],
		artifacts: input.artifacts ?? [],
		limitations: input.limitations ?? [],
		decision_refs: input.decisionRefs,
		...(input.steeringCertificateRefs !== undefined
			? { steering_certificate_refs: input.steeringCertificateRefs }
			: {}),
		...(input.specialistRefs !== undefined ? { specialist_refs: input.specialistRefs } : {}),
		...(input.capabilityRefs !== undefined ? { capability_refs: input.capabilityRefs } : {}),
		...(input.responsibilityDispositionRefs !== undefined
			? { responsibility_disposition_refs: input.responsibilityDispositionRefs }
			: {}),
		...(input.waiverRefs !== undefined ? { waiver_refs: input.waiverRefs } : {}),
		...(input.finalCommit !== undefined ? { final_commit: input.finalCommit } : {}),
		...(input.pushRefs !== undefined ? { push_refs: input.pushRefs } : {}),
		...(input.publicationRefs !== undefined ? { publication_refs: input.publicationRefs } : {}),
		usage: input.usage,
		assurance_profile_requested: input.assuranceProfileRequested,
		assurance_profile_used: input.assuranceProfileUsed,
		reviewer_refs: input.reviewerRefs,
		...(input.failedGates !== undefined ? { failed_gates: input.failedGates } : {}),
		...(input.requiredNextProof !== undefined ? { required_next_proof: input.requiredNextProof } : {}),
		...(input.changedFiles !== undefined ? { changed_files: input.changedFiles } : {}),
		...(input.diffDigest !== undefined ? { diff_digest: input.diffDigest } : {}),
		...(input.candidateSnapshot !== undefined ? { candidate_snapshot: input.candidateSnapshot } : {}),
		...(input.sideEffects !== undefined ? { side_effects: input.sideEffects } : {}),
	};
}
