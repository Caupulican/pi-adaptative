import { describe, expect, it } from "vitest";
import type { ContextItem } from "../src/core/context/context-item.ts";
import {
	createInMemoryContextStore,
	type PolicyDecisionRecord,
	type RetrievalRecord,
} from "../src/core/context/context-store.ts";
import { createInMemoryMemoryIndexStore, type MemoryIndexRecord } from "../src/core/context/memory-index-store.ts";
import type { PolicyDecision } from "../src/core/context/policy-types.ts";
import { CONTEXT_STORAGE_TABLE_AUTHORITY, type StorageAuthorityClass } from "../src/core/context/storage-authority.ts";

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: "item-1",
		kind: "tool_output",
		retentionClass: "ephemeral",
		source: "tool",
		createdAtTurn: 1,
		tokenEstimate: 10,
		byteEstimate: 40,
		...overrides,
	};
}

function makePolicyDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
	return {
		kind: "context_retention",
		selectedAction: "pack_to_artifact",
		mode: "shadow",
		applied: false,
		hardConstraints: [],
		candidates: [],
		selectedReasonCodes: ["saving_above_margin"],
		estimatedCostTokens: 10,
		estimatedSavingsTokens: 100,
		estimatedReliabilityRisk: 0.01,
		cacheImpactTokens: 0,
		reworkRiskTokens: 1,
		artifactRefs: [],
		evidenceRefs: [],
		...overrides,
	};
}

describe("ContextStore: context item metadata", () => {
	it("upserts and retrieves items by id", () => {
		const store = createInMemoryContextStore();
		const item = makeItem();
		store.upsertItem(item);
		expect(store.getItem("item-1")).toEqual(item);
	});

	it("lists all items", () => {
		const store = createInMemoryContextStore();
		store.upsertItem(makeItem({ id: "a" }));
		store.upsertItem(makeItem({ id: "b" }));
		expect(
			store
				.listItems()
				.map((item) => item.id)
				.sort(),
		).toEqual(["a", "b"]);
	});

	it("overwrites an item on repeated upsert with the same id", () => {
		const store = createInMemoryContextStore();
		store.upsertItem(makeItem({ id: "a", summary: "first" }));
		store.upsertItem(makeItem({ id: "a", summary: "second" }));
		expect(store.listItems()).toHaveLength(1);
		expect(store.getItem("a")?.summary).toBe("second");
	});

	it("removes an item; removing from the index never implies the transcript/artifact evidence was deleted", () => {
		const store = createInMemoryContextStore();
		store.upsertItem(makeItem({ id: "a" }));
		store.removeItem("a");
		// The index no longer knows about "a" -- but this store never held the canonical
		// transcript/artifact payload in the first place, so removing the index row cannot
		// be the thing that deletes evidence; that's a structural guarantee of this
		// abstraction, not something removeItem could violate even if called.
		expect(store.getItem("a")).toBeUndefined();
		expect(store.listItems()).toEqual([]);
	});

	it("returns undefined, never a fabricated item, for an unknown id", () => {
		const store = createInMemoryContextStore();
		expect(store.getItem("missing")).toBeUndefined();
	});
});

describe("ContextStore: policy decision and retrieval telemetry", () => {
	it("records and lists policy decisions, optionally filtered by context item", () => {
		const store = createInMemoryContextStore();
		const recordA: PolicyDecisionRecord = {
			id: "decision-1",
			contextItemId: "item-a",
			decision: makePolicyDecision(),
			recordedAtTurn: 1,
		};
		const recordB: PolicyDecisionRecord = {
			id: "decision-2",
			contextItemId: "item-b",
			decision: makePolicyDecision({ selectedAction: "drop_from_prompt" }),
			recordedAtTurn: 2,
		};
		store.recordPolicyDecision(recordA);
		store.recordPolicyDecision(recordB);

		expect(store.listPolicyDecisions()).toHaveLength(2);
		expect(store.listPolicyDecisions("item-a")).toEqual([recordA]);
	});

	it("records and lists retrieval records, optionally filtered by context item", () => {
		const store = createInMemoryContextStore();
		const record: RetrievalRecord = {
			id: "retrieval-1",
			contextItemId: "item-a",
			requestedAtTurn: 5,
			sliceKind: "lines_around_error",
			resultSummary: "3 lines around first error in build-context.test.ts",
		};
		store.recordRetrieval(record);

		expect(store.listRetrievals()).toEqual([record]);
		expect(store.listRetrievals("item-a")).toEqual([record]);
		expect(store.listRetrievals("item-nonexistent")).toEqual([]);
	});
});

describe("MemoryIndexStore: no external provider writes/queries", () => {
	it("exposes only index CRUD methods -- no search/fetch/write/network capability", () => {
		const store = createInMemoryMemoryIndexStore();
		expect(Object.keys(store).sort()).toEqual(["get", "list", "markStale", "remove", "upsert"]);
	});

	it("upserts and retrieves by (providerId, itemId)", () => {
		const store = createInMemoryMemoryIndexStore();
		const record: MemoryIndexRecord = {
			ref: { providerId: "pi-okf", itemId: "mem-1", scope: "project", kind: "design_decision" },
			summary: "Context output packing uses artifact refs.",
			indexedAtTurn: 1,
			stale: false,
		};
		store.upsert(record);
		expect(store.get("pi-okf", "mem-1")).toEqual(record);
		expect(store.get("pi-okf", "unknown")).toBeUndefined();
	});

	it("lists filtered by scope without querying any provider", () => {
		const store = createInMemoryMemoryIndexStore();
		store.upsert({
			ref: { providerId: "pi-okf", itemId: "mem-1", scope: "project", kind: "design_decision" },
			summary: "project-scoped",
			indexedAtTurn: 1,
			stale: false,
		});
		store.upsert({
			ref: { providerId: "pi-okf", itemId: "mem-2", scope: "user", kind: "user_preference" },
			summary: "user-scoped",
			indexedAtTurn: 1,
			stale: false,
		});

		expect(store.list("project")).toHaveLength(1);
		expect(store.list()).toHaveLength(2);
	});

	it("marks a record stale without deleting it", () => {
		const store = createInMemoryMemoryIndexStore();
		store.upsert({
			ref: { providerId: "pi-okf", itemId: "mem-1", scope: "project", kind: "design_decision" },
			summary: "project-scoped",
			indexedAtTurn: 1,
			stale: false,
		});
		store.markStale("pi-okf", "mem-1");
		expect(store.get("pi-okf", "mem-1")?.stale).toBe(true);
	});

	it("removes a record", () => {
		const store = createInMemoryMemoryIndexStore();
		store.upsert({
			ref: { providerId: "pi-okf", itemId: "mem-1", scope: "project", kind: "design_decision" },
			summary: "project-scoped",
			indexedAtTurn: 1,
			stale: false,
		});
		store.remove("pi-okf", "mem-1");
		expect(store.get("pi-okf", "mem-1")).toBeUndefined();
	});
});

describe("storage authority classes for future SQLite tables", () => {
	it("declares every table with a valid, closed authority class and non-empty notes", () => {
		const validClasses: StorageAuthorityClass[] = [
			"derived_rebuildable",
			"runtime_cache_disposable",
			"append_only_telemetry",
			"canonical_local_state",
		];
		for (const table of CONTEXT_STORAGE_TABLE_AUTHORITY) {
			expect(validClasses).toContain(table.authorityClass);
			expect(table.notes.length).toBeGreaterThan(0);
			expect(table.table.length).toBeGreaterThan(0);
		}
	});

	it("does not let cleanup/audit safety hinge only on disposable or purely-derived tables", () => {
		// Per memory-architecture.md: cleanup and prompt safety must not depend only on
		// disposable/derived rows. The artifact metadata table (which underpins the
		// cleanup-reachability guard) must therefore not be classified as disposable or
		// bare derived_rebuildable.
		const artifactTable = CONTEXT_STORAGE_TABLE_AUTHORITY.find((table) => table.table === "artifact_metadata");
		expect(artifactTable).toBeDefined();
		expect(artifactTable?.authorityClass).not.toBe("runtime_cache_disposable");
		expect(artifactTable?.authorityClass).not.toBe("derived_rebuildable");
	});

	it("covers at least one table per authority class", () => {
		const seen = new Set(CONTEXT_STORAGE_TABLE_AUTHORITY.map((table) => table.authorityClass));
		expect(seen.has("derived_rebuildable")).toBe(true);
		expect(seen.has("runtime_cache_disposable")).toBe(true);
		expect(seen.has("append_only_telemetry")).toBe(true);
		expect(seen.has("canonical_local_state")).toBe(true);
	});
});
