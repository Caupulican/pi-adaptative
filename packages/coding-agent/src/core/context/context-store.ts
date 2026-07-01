/**
 * Context store abstraction (Phase 2): the operational index for context item metadata,
 * retention/policy decisions, and retrieval records. Per memory-architecture.md, this is
 * an index/state/cache layer, not the sole audit source — transcript and artifacts remain
 * canonical. An in-memory implementation is provided for tests; SQLite waits on the Phase
 * M0 storage-authority/location/concurrency decisions.
 *
 * Nothing here is wired into session persistence or prompt construction yet.
 */

import type { ContextItem } from "./context-item.ts";
import type { PolicyDecision } from "./policy-types.ts";

export type RetrievalSliceKind =
	| "metadata"
	| "preview"
	| "lines_around_error"
	| "file_range"
	| "search_sample"
	| "transcript_slice"
	| "full_artifact";

export interface RetrievalRecord {
	id: string;
	contextItemId: string;
	requestedAtTurn: number;
	sliceKind: RetrievalSliceKind;
	resultSummary: string;
}

export interface PolicyDecisionRecord {
	id: string;
	contextItemId?: string;
	decision: PolicyDecision;
	recordedAtTurn: number;
}

export interface ContextStore {
	upsertItem(item: ContextItem): void;
	getItem(id: string): ContextItem | undefined;
	listItems(): ContextItem[];
	removeItem(id: string): void;

	recordPolicyDecision(record: PolicyDecisionRecord): void;
	listPolicyDecisions(contextItemId?: string): PolicyDecisionRecord[];

	recordRetrieval(record: RetrievalRecord): void;
	listRetrievals(contextItemId?: string): RetrievalRecord[];
}

export function createInMemoryContextStore(): ContextStore {
	const items = new Map<string, ContextItem>();
	const policyDecisions: PolicyDecisionRecord[] = [];
	const retrievals: RetrievalRecord[] = [];

	return {
		upsertItem(item: ContextItem): void {
			items.set(item.id, item);
		},

		getItem(id: string): ContextItem | undefined {
			return items.get(id);
		},

		listItems(): ContextItem[] {
			return Array.from(items.values());
		},

		removeItem(id: string): void {
			items.delete(id);
		},

		recordPolicyDecision(record: PolicyDecisionRecord): void {
			policyDecisions.push(record);
		},

		listPolicyDecisions(contextItemId?: string): PolicyDecisionRecord[] {
			return contextItemId === undefined
				? policyDecisions.slice()
				: policyDecisions.filter((record) => record.contextItemId === contextItemId);
		},

		recordRetrieval(record: RetrievalRecord): void {
			retrievals.push(record);
		},

		listRetrievals(contextItemId?: string): RetrievalRecord[] {
			return contextItemId === undefined
				? retrievals.slice()
				: retrievals.filter((record) => record.contextItemId === contextItemId);
		},
	};
}
