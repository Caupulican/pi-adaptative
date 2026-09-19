export type DeliveryTerminalStatus =
	| "complete"
	| "blocked_external"
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
	readonly usage?: Record<string, unknown>;
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
		usage: input.usage,
	};
}
