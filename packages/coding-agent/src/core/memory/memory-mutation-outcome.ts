export interface MemoryMutationEvidence {
	path: string;
	state: "before" | "after" | "unknown";
	/** True only when this operation attempted the commit, not merely found matching bytes. */
	attempted: boolean;
}

/** Storage evidence is separate from whether the requested preference completed. */
export class MemoryMutationOutcomeError extends Error {
	readonly outcome: "partial" | "unknown";
	readonly storageChanged: boolean;
	readonly evidence: readonly MemoryMutationEvidence[];
	readonly evidenceCount: number;

	constructor(
		cause: unknown,
		outcome: "partial" | "unknown",
		storageChanged: boolean,
		evidence: readonly MemoryMutationEvidence[] = [],
	) {
		super(
			`Memory storage outcome is ${outcome}; ${storageChanged ? "confirmed storage effects remain" : "preference completion is unconfirmed"}. Inspect current storage before retrying. ${String(cause).slice(0, 400)}`,
			{ cause },
		);
		this.name = "MemoryMutationOutcomeError";
		this.outcome = outcome;
		this.storageChanged = storageChanged;
		this.evidence = evidence.slice(0, 32).map((entry) => ({ ...entry }));
		this.evidenceCount = evidence.length;
	}
}

export function memoryMutationFailureDetails(error: unknown): Record<string, unknown> {
	if (!(error instanceof MemoryMutationOutcomeError)) return {};
	return {
		partial: true,
		outcomeUnknown: error.outcome === "unknown",
		storageChanged: error.storageChanged,
		storageEvidence: error.evidence,
		storageEvidenceCount: error.evidenceCount,
	};
}
