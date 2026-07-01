import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextItem } from "../src/core/context/context-item.ts";
import type { PolicyDecisionRecord, RetrievalRecord } from "../src/core/context/context-store.ts";
import type { MemoryIndexRecord } from "../src/core/context/memory-index-store.ts";
import type { PolicyDecision } from "../src/core/context/policy-types.ts";
import {
	createSqliteContextStore,
	createSqliteMemoryIndexStore,
	SQLITE_CONTEXT_INDEX_TABLES,
	SQLITE_RUNTIME_INDEX_SCHEMA_VERSION,
	type SqliteContextStore,
	type SqliteMemoryIndexStore,
} from "../src/core/context/sqlite-runtime-index.ts";
import { CONTEXT_STORAGE_TABLE_AUTHORITY } from "../src/core/context/storage-authority.ts";

interface ClosableStore {
	close(): void;
}

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: "item-1",
		kind: "tool_output",
		retentionClass: "ephemeral",
		source: "tool",
		createdAtTurn: 1,
		lastUsedAtTurn: 2,
		summary: "grep output digest",
		content: "artifact tool-output:abc123",
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

function stringColumn(row: Record<string, unknown>, column: string): string {
	const value = row[column];
	if (typeof value !== "string") throw new Error(`Expected string column ${column}`);
	return value;
}

function numberColumn(row: Record<string, unknown> | undefined, column: string): number {
	const value = row?.[column];
	if (typeof value !== "number") throw new Error(`Expected number column ${column}`);
	return value;
}

describe("SQLite runtime index stores", () => {
	let tempDir: string;
	let databasePath: string;
	let stores: ClosableStore[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sqlite-runtime-index-"));
		databasePath = join(tempDir, "nested", "context.sqlite");
		stores = [];
	});

	afterEach(() => {
		for (const store of stores.reverse()) store.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function track<T extends ClosableStore>(store: T): T {
		stores.push(store);
		return store;
	}

	function openContextStore(): SqliteContextStore {
		return track(createSqliteContextStore({ databasePath }));
	}

	function openMemoryStore(): SqliteMemoryIndexStore {
		return track(createSqliteMemoryIndexStore({ databasePath }));
	}

	it("creates all authority-declared runtime-index tables under schema version 1", () => {
		openContextStore();
		const database = new DatabaseSync(databasePath);
		try {
			const rows = database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all();
			const actualTables = rows.map((row) => stringColumn(row, "name"));
			const authorityTables = CONTEXT_STORAGE_TABLE_AUTHORITY.map((table) => table.table).sort();

			expect([...SQLITE_CONTEXT_INDEX_TABLES].sort()).toEqual(authorityTables);
			expect(actualTables).toEqual(authorityTables);
			expect(numberColumn(database.prepare("PRAGMA user_version").get(), "user_version")).toBe(
				SQLITE_RUNTIME_INDEX_SCHEMA_VERSION,
			);
		} finally {
			database[Symbol.dispose]();
		}
	});

	it("creates the parent database directory explicitly", () => {
		expect(existsSync(dirname(databasePath))).toBe(false);
		openContextStore();
		expect(existsSync(dirname(databasePath))).toBe(true);
	});

	it("persists context items across store instances without storing transcript or artifact payloads", () => {
		const item = makeItem({ id: "item-a", createdAtTurn: 3, summary: "stored metadata only" });
		const first = openContextStore();
		first.upsertItem(item);
		first.close();

		const second = openContextStore();
		expect(second.getItem("item-a")).toEqual(item);
		expect(second.listItems()).toEqual([item]);

		second.removeItem("item-a");
		expect(second.getItem("item-a")).toBeUndefined();
		expect(second.listItems()).toEqual([]);
	});

	it("persists and filters policy decisions and retrieval telemetry", () => {
		const decisionA: PolicyDecisionRecord = {
			id: "decision-a",
			contextItemId: "item-a",
			decision: makePolicyDecision(),
			recordedAtTurn: 2,
		};
		const decisionB: PolicyDecisionRecord = {
			id: "decision-b",
			contextItemId: "item-b",
			decision: makePolicyDecision({ selectedAction: "drop_from_prompt", applied: true }),
			recordedAtTurn: 3,
		};
		const retrieval: RetrievalRecord = {
			id: "retrieval-a",
			contextItemId: "item-a",
			requestedAtTurn: 4,
			sliceKind: "preview",
			resultSummary: "previewed artifact ref abc123",
		};

		const first = openContextStore();
		first.recordPolicyDecision(decisionA);
		first.recordPolicyDecision(decisionB);
		first.recordRetrieval(retrieval);
		first.close();

		const second = openContextStore();
		expect(second.listPolicyDecisions()).toEqual([decisionA, decisionB]);
		expect(second.listPolicyDecisions("item-a")).toEqual([decisionA]);
		expect(second.listRetrievals()).toEqual([retrieval]);
		expect(second.listRetrievals("item-a")).toEqual([retrieval]);
		expect(second.listRetrievals("item-b")).toEqual([]);
	});

	it("persists memory-index records, filters by scope, and marks stale without provider calls", () => {
		const projectRecord: MemoryIndexRecord = {
			ref: { providerId: "pi-okf", itemId: "project-decision", scope: "project", kind: "design_decision" },
			title: "Context output packing",
			summary: "Large grep/find output is artifact-backed.",
			indexedAtTurn: 5,
			stale: false,
		};
		const userRecord: MemoryIndexRecord = {
			ref: { providerId: "pi-okf", itemId: "user-preference", scope: "user", kind: "user_preference" },
			summary: "User wants settings-menu exposure for user-facing settings.",
			indexedAtTurn: 6,
			stale: false,
		};

		const first = openMemoryStore();
		first.upsert(projectRecord);
		first.upsert(userRecord);
		first.close();

		const second = openMemoryStore();
		expect(second.list("project")).toEqual([projectRecord]);
		expect(second.list()).toEqual([projectRecord, userRecord]);
		second.markStale("pi-okf", "project-decision");
		second.close();

		const third = openMemoryStore();
		expect(third.get("pi-okf", "project-decision")).toEqual({ ...projectRecord, stale: true });
		third.remove("pi-okf", "project-decision");
		expect(third.get("pi-okf", "project-decision")).toBeUndefined();
	});

	it("refuses to open a database with a newer schema version", () => {
		mkdirSync(dirname(databasePath), { recursive: true });
		const database = new DatabaseSync(databasePath);
		try {
			database.exec("PRAGMA user_version = 999;");
		} finally {
			database[Symbol.dispose]();
		}

		expect(() => createSqliteContextStore({ databasePath })).toThrow(
			/Unsupported Pi context runtime-index schema version 999/,
		);
	});

	it("ignores malformed JSON rows instead of fabricating context items", () => {
		const first = openContextStore();
		first.close();

		const database = new DatabaseSync(databasePath);
		try {
			database
				.prepare(`
					INSERT INTO context_items (
						id, kind, retention_class, source, created_at_turn, token_estimate, byte_estimate, payload_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.run("bad", "tool_output", "ephemeral", "tool", 1, 1, 1, "{not json");
		} finally {
			database[Symbol.dispose]();
		}

		const second = openContextStore();
		expect(second.getItem("bad")).toBeUndefined();
		expect(second.listItems()).toEqual([]);
	});
});
