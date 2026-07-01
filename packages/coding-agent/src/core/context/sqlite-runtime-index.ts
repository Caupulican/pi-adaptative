import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ContextItem } from "./context-item.ts";
import type { ContextStore, PolicyDecisionRecord, RetrievalRecord } from "./context-store.ts";
import type { MemoryIndexRecord, MemoryIndexStore } from "./memory-index-store.ts";
import type { PolicyDecision } from "./policy-types.ts";

export const SQLITE_RUNTIME_INDEX_SCHEMA_VERSION = 1;

export const SQLITE_CONTEXT_INDEX_TABLES = [
	"context_items",
	"artifact_metadata",
	"policy_score_cache",
	"policy_decisions",
	"retrieval_records",
	"memory_index",
] as const;

export interface SqliteRuntimeIndexOptions {
	databasePath: string;
	busyTimeoutMs?: number;
}

export interface SqliteContextStore extends ContextStore {
	close(): void;
}

export interface SqliteMemoryIndexStore extends MemoryIndexStore {
	close(): void;
}

function prepareDatabasePath(databasePath: string): void {
	if (databasePath === ":memory:") return;
	mkdirSync(dirname(databasePath), { recursive: true });
}

function openDatabase(options: SqliteRuntimeIndexOptions): DatabaseSync {
	prepareDatabasePath(options.databasePath);
	const database = new DatabaseSync(options.databasePath, {
		enableForeignKeyConstraints: true,
		timeout: options.busyTimeoutMs ?? 5_000,
	});
	database.exec(`
		PRAGMA foreign_keys = ON;
		PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000};
		PRAGMA journal_mode = WAL;
	`);
	migrateSqliteRuntimeIndex(database);
	return database;
}

function currentSchemaVersion(database: DatabaseSync): number {
	const row = database.prepare("PRAGMA user_version").get();
	const value = row?.user_version;
	return typeof value === "number" ? value : 0;
}

export function migrateSqliteRuntimeIndex(database: DatabaseSync): void {
	const version = currentSchemaVersion(database);
	if (version > SQLITE_RUNTIME_INDEX_SCHEMA_VERSION) {
		throw new Error(
			`Unsupported Pi context runtime-index schema version ${version}; current runtime supports ${SQLITE_RUNTIME_INDEX_SCHEMA_VERSION}`,
		);
	}

	try {
		database.exec(`
			BEGIN IMMEDIATE;

			CREATE TABLE IF NOT EXISTS context_items (
				id TEXT PRIMARY KEY NOT NULL,
				kind TEXT NOT NULL,
				retention_class TEXT NOT NULL,
				source TEXT NOT NULL,
				created_at_turn INTEGER NOT NULL,
				last_used_at_turn INTEGER,
				token_estimate INTEGER NOT NULL,
				byte_estimate INTEGER NOT NULL,
				payload_json TEXT NOT NULL
			) STRICT;

			CREATE TABLE IF NOT EXISTS artifact_metadata (
				id TEXT PRIMARY KEY NOT NULL,
				kind TEXT NOT NULL,
				storage_path TEXT,
				session_entry_id TEXT,
				tool_name TEXT,
				command TEXT,
				path TEXT,
				byte_length INTEGER NOT NULL,
				line_count INTEGER,
				created_at_turn INTEGER NOT NULL,
				reproducible INTEGER NOT NULL CHECK (reproducible IN (0, 1)),
				payload_exists INTEGER NOT NULL DEFAULT 1 CHECK (payload_exists IN (0, 1)),
				payload_json TEXT NOT NULL
			) STRICT;

			CREATE TABLE IF NOT EXISTS policy_score_cache (
				cache_key TEXT PRIMARY KEY NOT NULL,
				created_at_turn INTEGER NOT NULL,
				payload_json TEXT NOT NULL
			) STRICT;

			CREATE TABLE IF NOT EXISTS policy_decisions (
				id TEXT PRIMARY KEY NOT NULL,
				context_item_id TEXT,
				recorded_at_turn INTEGER NOT NULL,
				decision_kind TEXT NOT NULL,
				selected_action TEXT NOT NULL,
				mode TEXT NOT NULL,
				applied INTEGER NOT NULL CHECK (applied IN (0, 1)),
				payload_json TEXT NOT NULL
			) STRICT;

			CREATE INDEX IF NOT EXISTS idx_policy_decisions_context_item_id
				ON policy_decisions(context_item_id, recorded_at_turn);

			CREATE TABLE IF NOT EXISTS retrieval_records (
				id TEXT PRIMARY KEY NOT NULL,
				context_item_id TEXT NOT NULL,
				requested_at_turn INTEGER NOT NULL,
				slice_kind TEXT NOT NULL,
				result_summary TEXT NOT NULL,
				payload_json TEXT NOT NULL
			) STRICT;

			CREATE INDEX IF NOT EXISTS idx_retrieval_records_context_item_id
				ON retrieval_records(context_item_id, requested_at_turn);

			CREATE TABLE IF NOT EXISTS memory_index (
				provider_id TEXT NOT NULL,
				item_id TEXT NOT NULL,
				scope TEXT NOT NULL,
				kind TEXT NOT NULL,
				title TEXT,
				summary TEXT NOT NULL,
				indexed_at_turn INTEGER NOT NULL,
				stale INTEGER NOT NULL CHECK (stale IN (0, 1)),
				payload_json TEXT NOT NULL,
				PRIMARY KEY (provider_id, item_id)
			) STRICT;

			CREATE INDEX IF NOT EXISTS idx_memory_index_scope
				ON memory_index(scope, provider_id, item_id);

			PRAGMA user_version = ${SQLITE_RUNTIME_INDEX_SCHEMA_VERSION};
			COMMIT;
		`);
	} catch (error) {
		if (database.isTransaction) database.exec("ROLLBACK;");
		throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord<T>(json: string, isValid: (value: unknown) => value is T): T | undefined {
	try {
		const parsed: unknown = JSON.parse(json);
		return isValid(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function textColumn(row: Record<string, unknown> | undefined, column: string): string | undefined {
	const value = row?.[column];
	return typeof value === "string" ? value : undefined;
}

function isContextItem(value: unknown): value is ContextItem {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.kind === "string" &&
		typeof value.retentionClass === "string" &&
		typeof value.source === "string" &&
		typeof value.createdAtTurn === "number" &&
		typeof value.tokenEstimate === "number" &&
		typeof value.byteEstimate === "number"
	);
}

function isPolicyDecision(value: unknown): value is PolicyDecision {
	if (!isRecord(value)) return false;
	return (
		typeof value.kind === "string" &&
		typeof value.selectedAction === "string" &&
		typeof value.mode === "string" &&
		typeof value.applied === "boolean" &&
		Array.isArray(value.hardConstraints) &&
		Array.isArray(value.candidates) &&
		Array.isArray(value.selectedReasonCodes) &&
		typeof value.estimatedCostTokens === "number" &&
		typeof value.estimatedSavingsTokens === "number" &&
		typeof value.estimatedReliabilityRisk === "number" &&
		typeof value.cacheImpactTokens === "number" &&
		typeof value.reworkRiskTokens === "number" &&
		Array.isArray(value.artifactRefs) &&
		Array.isArray(value.evidenceRefs)
	);
}

function isPolicyDecisionRecord(value: unknown): value is PolicyDecisionRecord {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		(value.contextItemId === undefined || typeof value.contextItemId === "string") &&
		typeof value.recordedAtTurn === "number" &&
		isPolicyDecision(value.decision)
	);
}

function isRetrievalRecord(value: unknown): value is RetrievalRecord {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.contextItemId === "string" &&
		typeof value.requestedAtTurn === "number" &&
		typeof value.sliceKind === "string" &&
		typeof value.resultSummary === "string"
	);
}

function isMemoryIndexRecord(value: unknown): value is MemoryIndexRecord {
	if (!isRecord(value) || !isRecord(value.ref)) return false;
	return (
		typeof value.ref.providerId === "string" &&
		typeof value.ref.itemId === "string" &&
		typeof value.ref.scope === "string" &&
		typeof value.ref.kind === "string" &&
		(value.title === undefined || typeof value.title === "string") &&
		typeof value.summary === "string" &&
		typeof value.indexedAtTurn === "number" &&
		typeof value.stale === "boolean"
	);
}

function contextItemFromRow(row: Record<string, unknown> | undefined): ContextItem | undefined {
	const payload = textColumn(row, "payload_json");
	return payload === undefined ? undefined : parseJsonRecord(payload, isContextItem);
}

function policyDecisionRecordFromRow(row: Record<string, unknown> | undefined): PolicyDecisionRecord | undefined {
	const payload = textColumn(row, "payload_json");
	return payload === undefined ? undefined : parseJsonRecord(payload, isPolicyDecisionRecord);
}

function retrievalRecordFromRow(row: Record<string, unknown> | undefined): RetrievalRecord | undefined {
	const payload = textColumn(row, "payload_json");
	return payload === undefined ? undefined : parseJsonRecord(payload, isRetrievalRecord);
}

function memoryIndexRecordFromRow(row: Record<string, unknown> | undefined): MemoryIndexRecord | undefined {
	const payload = textColumn(row, "payload_json");
	return payload === undefined ? undefined : parseJsonRecord(payload, isMemoryIndexRecord);
}

export function createSqliteContextStore(options: SqliteRuntimeIndexOptions): SqliteContextStore {
	const database = openDatabase(options);
	const upsertItem = database.prepare(`
		INSERT INTO context_items (
			id, kind, retention_class, source, created_at_turn, last_used_at_turn, token_estimate, byte_estimate, payload_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			kind = excluded.kind,
			retention_class = excluded.retention_class,
			source = excluded.source,
			created_at_turn = excluded.created_at_turn,
			last_used_at_turn = excluded.last_used_at_turn,
			token_estimate = excluded.token_estimate,
			byte_estimate = excluded.byte_estimate,
			payload_json = excluded.payload_json
	`);
	const getItem = database.prepare("SELECT payload_json FROM context_items WHERE id = ?");
	const listItems = database.prepare("SELECT payload_json FROM context_items ORDER BY created_at_turn, id");
	const removeItem = database.prepare("DELETE FROM context_items WHERE id = ?");
	const recordPolicyDecision = database.prepare(`
		INSERT INTO policy_decisions (
			id, context_item_id, recorded_at_turn, decision_kind, selected_action, mode, applied, payload_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const listAllPolicyDecisions = database.prepare(
		"SELECT payload_json FROM policy_decisions ORDER BY recorded_at_turn, id",
	);
	const listPolicyDecisionsByItem = database.prepare(
		"SELECT payload_json FROM policy_decisions WHERE context_item_id = ? ORDER BY recorded_at_turn, id",
	);
	const recordRetrieval = database.prepare(`
		INSERT INTO retrieval_records (
			id, context_item_id, requested_at_turn, slice_kind, result_summary, payload_json
		) VALUES (?, ?, ?, ?, ?, ?)
	`);
	const listAllRetrievals = database.prepare(
		"SELECT payload_json FROM retrieval_records ORDER BY requested_at_turn, id",
	);
	const listRetrievalsByItem = database.prepare(
		"SELECT payload_json FROM retrieval_records WHERE context_item_id = ? ORDER BY requested_at_turn, id",
	);

	return {
		upsertItem(item: ContextItem): void {
			upsertItem.run(
				item.id,
				item.kind,
				item.retentionClass,
				item.source,
				item.createdAtTurn,
				item.lastUsedAtTurn ?? null,
				item.tokenEstimate,
				item.byteEstimate,
				JSON.stringify(item),
			);
		},

		getItem(id: string): ContextItem | undefined {
			return contextItemFromRow(getItem.get(id));
		},

		listItems(): ContextItem[] {
			return listItems.all().flatMap((row) => {
				const item = contextItemFromRow(row);
				return item === undefined ? [] : [item];
			});
		},

		removeItem(id: string): void {
			removeItem.run(id);
		},

		recordPolicyDecision(record: PolicyDecisionRecord): void {
			recordPolicyDecision.run(
				record.id,
				record.contextItemId ?? null,
				record.recordedAtTurn,
				record.decision.kind,
				record.decision.selectedAction,
				record.decision.mode,
				record.decision.applied ? 1 : 0,
				JSON.stringify(record),
			);
		},

		listPolicyDecisions(contextItemId?: string): PolicyDecisionRecord[] {
			const rows =
				contextItemId === undefined ? listAllPolicyDecisions.all() : listPolicyDecisionsByItem.all(contextItemId);
			return rows.flatMap((row) => {
				const record = policyDecisionRecordFromRow(row);
				return record === undefined ? [] : [record];
			});
		},

		recordRetrieval(record: RetrievalRecord): void {
			recordRetrieval.run(
				record.id,
				record.contextItemId,
				record.requestedAtTurn,
				record.sliceKind,
				record.resultSummary,
				JSON.stringify(record),
			);
		},

		listRetrievals(contextItemId?: string): RetrievalRecord[] {
			const rows = contextItemId === undefined ? listAllRetrievals.all() : listRetrievalsByItem.all(contextItemId);
			return rows.flatMap((row) => {
				const record = retrievalRecordFromRow(row);
				return record === undefined ? [] : [record];
			});
		},

		close(): void {
			database[Symbol.dispose]();
		},
	};
}

export function createSqliteMemoryIndexStore(options: SqliteRuntimeIndexOptions): SqliteMemoryIndexStore {
	const database = openDatabase(options);
	const upsert = database.prepare(`
		INSERT INTO memory_index (
			provider_id, item_id, scope, kind, title, summary, indexed_at_turn, stale, payload_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(provider_id, item_id) DO UPDATE SET
			scope = excluded.scope,
			kind = excluded.kind,
			title = excluded.title,
			summary = excluded.summary,
			indexed_at_turn = excluded.indexed_at_turn,
			stale = excluded.stale,
			payload_json = excluded.payload_json
	`);
	const get = database.prepare("SELECT payload_json FROM memory_index WHERE provider_id = ? AND item_id = ?");
	const listAll = database.prepare("SELECT payload_json FROM memory_index ORDER BY provider_id, item_id");
	const listByScope = database.prepare(
		"SELECT payload_json FROM memory_index WHERE scope = ? ORDER BY provider_id, item_id",
	);
	const markStale = database.prepare(
		"UPDATE memory_index SET stale = 1, payload_json = ? WHERE provider_id = ? AND item_id = ?",
	);
	const remove = database.prepare("DELETE FROM memory_index WHERE provider_id = ? AND item_id = ?");

	return {
		upsert(record: MemoryIndexRecord): void {
			upsert.run(
				record.ref.providerId,
				record.ref.itemId,
				record.ref.scope,
				record.ref.kind,
				record.title ?? null,
				record.summary,
				record.indexedAtTurn,
				record.stale ? 1 : 0,
				JSON.stringify(record),
			);
		},

		get(providerId: string, itemId: string): MemoryIndexRecord | undefined {
			return memoryIndexRecordFromRow(get.get(providerId, itemId));
		},

		list(scope?: MemoryIndexRecord["ref"]["scope"]): MemoryIndexRecord[] {
			const rows = scope === undefined ? listAll.all() : listByScope.all(scope);
			return rows.flatMap((row) => {
				const record = memoryIndexRecordFromRow(row);
				return record === undefined ? [] : [record];
			});
		},

		markStale(providerId: string, itemId: string): void {
			const existing = memoryIndexRecordFromRow(get.get(providerId, itemId));
			if (existing === undefined) return;
			markStale.run(JSON.stringify({ ...existing, stale: true }), providerId, itemId);
		},

		remove(providerId: string, itemId: string): void {
			remove.run(providerId, itemId);
		},

		close(): void {
			database[Symbol.dispose]();
		},
	};
}
