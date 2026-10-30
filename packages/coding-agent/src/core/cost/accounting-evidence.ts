import type { Usage } from "@caupulican/pi-ai";

export function accountingProjectionPath(sessionFile: string): string {
	return `${sessionFile}.accounting.json`;
}

/** A captured origin identifies existing work; it never supplies execution authority. */
export interface AccountingOrigin {
	readonly sessionId: string;
	readonly entryId?: string;
	readonly goalId?: string;
	readonly taskId?: string;
	readonly toolCallId?: string;
	readonly operationId?: string;
}

export interface AccountingSourceRevision {
	readonly path: string;
	readonly sha256: string;
	readonly size: number;
}

/** One observed response, before any API-equivalent price projection. */
export interface AccountingUsageComponent {
	readonly operation?: "compaction" | "branch_summary";
	readonly usage: Usage;
	readonly provider?: string;
	readonly model?: string;
	readonly timestamp: string;
	readonly sourceId: string;
}

/** A group either enriches matching receipts or replaces them with a conserved response breakdown. */
export interface AccountingEvidenceGroup {
	/** Exact direct tool-result usage, preserved as recorded and enriched from its retained artifact. */
	readonly directEntries?: readonly {
		readonly entryId: string;
		readonly usage: Usage;
		readonly provider: string;
		readonly model: string;
		readonly costStatus?: "unpriced" | "catalog_priced";
		readonly modelProvenance?: "request-bound";
	}[];
	readonly pendingReports?: readonly {
		readonly reportId: string;
		readonly usage: Usage;
		readonly timestamp: string;
	}[];
	readonly diagnostic?: string;
	readonly reportIds: readonly string[];
	readonly origin?: AccountingOrigin;
	readonly components?: readonly AccountingUsageComponent[];
	/** Cumulative per-attempt clock; origin.operationId identifies the attempt, not this receipt group. */
	readonly activeTime?: { readonly goalId?: string; readonly taskId: string; readonly milliseconds: number };
	readonly evidence: readonly AccountingSourceRevision[];
}
