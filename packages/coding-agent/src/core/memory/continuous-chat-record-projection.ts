import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { constructSqliteDatabase, type SqliteDatabase, withSqliteTransaction } from "../context/sqlite-database.ts";
import { isNonNegativeSafeInteger } from "../util/value-guards.ts";
import type { ContinuousChatRecord } from "./continuous-chat-contracts.ts";
import {
	isLegacyParentProjectionCandidate,
	legacyParentProjectionFamily,
	type ParentProjectionDecision,
	type ParentProjectionState,
} from "./continuous-chat-parent-projection-contract.ts";

interface ProjectionMeta {
	identity: string;
	revision: number;
	derivedRevision: number;
	indexedThrough: number;
}
interface ProjectionGroupRow {
	sessionId: string;
	entryId: string;
	firstId: number;
	recordCount: number;
	state: ParentProjectionState;
}

function projectionState(value: unknown): ParentProjectionState {
	if (value !== "unreviewed" && value !== "unchanged" && value !== "superseded" && value !== "quarantined")
		throw new Error("Invalid stored projection state.");
	return value;
}

/** Immutable source bytes remain authoritative; this index owns only visible projection and its rebuild frontier. */
export class ContinuousChatRecordProjection {
	private readonly db: SqliteDatabase;
	private readonly path: string;
	private readonly fileIdentity: { dev: number; ino: number };
	constructor(path: string, allowCreate: boolean, writable = true) {
		this.path = path;
		this.db = constructSqliteDatabase({ databasePath: path }, (db) => {
			db.exec("PRAGMA busy_timeout=5000; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;");
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			if (version !== 1 && !(version === 0 && allowCreate))
				throw new Error("Unsupported continuous-chat projection schema.");
			if (writable) db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
			if (version === 0) {
				withSqliteTransaction(
					db,
					() => {
						db.exec(`
			CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), derived_revision INTEGER NOT NULL CHECK(derived_revision>=0), indexed_through INTEGER NOT NULL CHECK(indexed_through>=0)) STRICT;
			CREATE TABLE IF NOT EXISTS source_groups(session_id TEXT NOT NULL, entry_id TEXT NOT NULL, first_id INTEGER NOT NULL CHECK(first_id>=0), record_count INTEGER NOT NULL CHECK(record_count>0), candidate INTEGER NOT NULL CHECK(candidate IN(0,1)), state TEXT NOT NULL CHECK(state IN('unreviewed','unchanged','superseded','quarantined')), PRIMARY KEY(session_id,entry_id)) STRICT, WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS source_records(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, entry_id TEXT NOT NULL) STRICT;
			CREATE INDEX IF NOT EXISTS source_members ON source_records(session_id,entry_id,id);
			CREATE TABLE IF NOT EXISTS frontier(cutoff INTEGER PRIMARY KEY, revision INTEGER NOT NULL) STRICT;
			CREATE TABLE IF NOT EXISTS replayed(session_id TEXT PRIMARY KEY) STRICT, WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS unavailable(session_id TEXT PRIMARY KEY, reason TEXT NOT NULL) STRICT, WITHOUT ROWID;
			PRAGMA user_version=1;`);
						db.prepare("INSERT INTO meta VALUES(1,?,0,0,0)").run(randomUUID());
					},
					"continuous-chat projection initialization",
				);
			}
			if (!writable) db.exec("PRAGMA query_only=ON;");
			return db;
		});
		const stat = statSync(path);
		this.fileIdentity = { dev: stat.dev, ino: stat.ino };
	}
	close(): void {
		this.db[Symbol.dispose]();
	}
	meta(): ProjectionMeta {
		const file = statSync(this.path);
		if (file.dev !== this.fileIdentity.dev || file.ino !== this.fileIdentity.ino)
			throw new Error("Continuous-chat projection authority was replaced.");
		const row = this.db
			.prepare("SELECT identity,revision,derived_revision,indexed_through FROM meta WHERE id=1")
			.get();
		if (
			!row ||
			![row.revision, row.derived_revision, row.indexed_through].every(
				(n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
			)
		)
			throw new Error("Invalid continuous-chat projection metadata.");
		if (
			typeof row.identity !== "string" ||
			!/^[a-f0-9-]{36}$/.test(row.identity) ||
			(row.derived_revision as number) > (row.revision as number)
		)
			throw new Error("Invalid continuous-chat projection identity.");
		return {
			identity: row.identity,
			revision: row.revision as number,
			derivedRevision: row.derived_revision as number,
			indexedThrough: row.indexed_through as number,
		};
	}
	private advance(cutoff: number): void {
		const revision = this.meta().revision + 1;
		if (!Number.isSafeInteger(revision)) throw new Error("Continuous-chat projection revision overflow.");
		this.db.prepare("DELETE FROM frontier WHERE cutoff>=?").run(cutoff);
		this.db.prepare("INSERT INTO frontier VALUES(?,?)").run(cutoff, revision);
		this.db.prepare("UPDATE meta SET revision=? WHERE id=1").run(revision);
	}
	index(records: readonly ContinuousChatRecord[]): void {
		withSqliteTransaction(
			this.db,
			() => {
				let next = this.meta().indexedThrough;
				let cutoff = Number.POSITIVE_INFINITY;
				for (const record of records) {
					if (record.id !== next++) throw new Error("Continuous-chat projection index is not contiguous.");
					if (!record.source || !legacyParentProjectionFamily(record)) continue;
					const { sessionId, entryId } = record.source;
					const candidate = isLegacyParentProjectionCandidate(record);
					const old = this.db
						.prepare("SELECT first_id,candidate,state FROM source_groups WHERE session_id=? AND entry_id=?")
						.get(sessionId, entryId);
					this.db.prepare("INSERT INTO source_records VALUES(?,?,?)").run(record.id, sessionId, entryId);
					this.db
						.prepare(
							`INSERT INTO source_groups VALUES(?,?,?,1,?,'unreviewed') ON CONFLICT(session_id,entry_id) DO UPDATE SET record_count=record_count+1,candidate=max(candidate,excluded.candidate),first_id=CASE WHEN excluded.candidate=1 AND candidate=0 THEN excluded.first_id ELSE first_id END`,
						)
						.run(sessionId, entryId, record.id, candidate ? 1 : 0);
					if (candidate && (!old || old.candidate === 0) && (!old || old.state === "unreviewed")) {
						const first = this.db
							.prepare("SELECT min(id) AS id FROM source_records WHERE session_id=? AND entry_id=?")
							.get(sessionId, entryId)?.id;
						cutoff = Math.min(cutoff, first as number);
					}
				}
				this.db.prepare("UPDATE meta SET indexed_through=? WHERE id=1").run(next);
				if (Number.isFinite(cutoff)) this.advance(cutoff);
			},
			"continuous-chat projection index",
		);
	}
	project(record: ContinuousChatRecord): ContinuousChatRecord {
		this.meta();
		const row = this.db
			.prepare(
				"SELECT g.state,g.candidate FROM source_records r JOIN source_groups g USING(session_id,entry_id) WHERE r.id=?",
			)
			.get(record.id);
		if (!row) return record;
		projectionState(row.state);
		if (row.candidate !== 0 && row.candidate !== 1) throw new Error("Invalid stored projection candidate.");
		if (row.state === "unchanged" || (row.state === "unreviewed" && row.candidate === 0)) return record;
		const text =
			row.state === "superseded"
				? "[Earlier background record superseded; canonical consumption is recorded separately.]"
				: "[Earlier background record unavailable pending source verification.]";
		return {
			schemaVersion: record.schemaVersion,
			id: record.id,
			kind: "work",
			date: record.date,
			text,
			textBytes: Buffer.byteLength(text),
			sourceKey: record.sourceKey,
			...(record.source ? { source: record.source } : {}),
		};
	}
	groups(sessionId: string, after: string, limit: number): ProjectionGroupRow[] {
		return this.db
			.prepare(
				"SELECT session_id,entry_id,first_id,record_count,state FROM source_groups WHERE session_id=? AND entry_id>? AND state IN('unreviewed','quarantined') ORDER BY entry_id LIMIT ?",
			)
			.all(sessionId, after, limit)
			.map((row) => {
				if (
					typeof row.session_id !== "string" ||
					typeof row.entry_id !== "string" ||
					!isNonNegativeSafeInteger(row.first_id) ||
					!isNonNegativeSafeInteger(row.record_count) ||
					row.record_count === 0
				)
					throw new Error("Invalid stored projection group.");
				return {
					sessionId: row.session_id,
					entryId: row.entry_id,
					firstId: row.first_id,
					recordCount: row.record_count,
					state: projectionState(row.state),
				};
			});
	}
	sessions(after: string, limit: number): string[] {
		return this.db
			.prepare(
				"SELECT session_id FROM (SELECT session_id FROM source_groups WHERE state IN('unreviewed','quarantined') UNION SELECT session_id FROM unavailable) WHERE session_id>? ORDER BY session_id LIMIT ?",
			)
			.all(after, limit)
			.map((row) => String(row.session_id));
	}
	apply(decisions: readonly ParentProjectionDecision[]): void {
		withSqliteTransaction(
			this.db,
			() => {
				let cutoff = Number.POSITIVE_INFINITY;
				for (const decision of decisions) {
					const row = this.db
						.prepare("SELECT state,candidate FROM source_groups WHERE session_id=? AND entry_id=?")
						.get(decision.sessionId, decision.entryId);
					if (!row) throw new Error("Continuous-chat projection source group is unknown.");
					projectionState(row.state);
					if (row.candidate !== 0 && row.candidate !== 1) throw new Error("Invalid stored projection candidate.");
					if (row.state === "superseded" && decision.state !== "superseded")
						throw new Error("Confirmed superseded history cannot be restored.");
					if (!["unchanged", "superseded", "quarantined"].includes(decision.state))
						throw new Error("Invalid continuous-chat projection decision.");
					const before =
						row.state === "superseded"
							? "superseded"
							: row.state === "quarantined" || (row.state === "unreviewed" && row.candidate === 1)
								? "quarantined"
								: "unchanged";
					this.db
						.prepare("UPDATE source_groups SET state=? WHERE session_id=? AND entry_id=?")
						.run(decision.state, decision.sessionId, decision.entryId);
					if (before !== decision.state) {
						const first = this.db
							.prepare("SELECT min(id) AS id FROM source_records WHERE session_id=? AND entry_id=?")
							.get(decision.sessionId, decision.entryId)?.id;
						cutoff = Math.min(cutoff, first as number);
					}
				}
				if (Number.isFinite(cutoff)) this.advance(cutoff);
			},
			"continuous-chat projection decisions",
		);
	}
	requiredRevision(end: number): number {
		const current = this.meta().revision;
		const value =
			this.db.prepare("SELECT revision FROM frontier WHERE cutoff<? ORDER BY cutoff DESC LIMIT 1").get(end)
				?.revision ?? 0;
		if (!isNonNegativeSafeInteger(value) || value > current) throw new Error("Invalid projection frontier revision.");
		return value;
	}
	pendingCutoff(): number | undefined {
		const meta = this.meta();
		if (meta.revision === meta.derivedRevision) return undefined;
		const value = this.db
			.prepare("SELECT min(cutoff) AS cutoff FROM frontier WHERE revision>?")
			.get(meta.derivedRevision)?.cutoff;
		if (typeof value !== "number") throw new Error("Projection revision has no rebuild frontier.");
		return value;
	}
	markDerived(revision: number): void {
		if (this.meta().revision !== revision) throw new Error("Projection changed while derived state was rebuilt.");
		this.db.prepare("UPDATE meta SET derived_revision=? WHERE id=1").run(revision);
	}
	replayed(sessionId: string): boolean {
		return !!this.db.prepare("SELECT 1 FROM replayed WHERE session_id=?").get(sessionId);
	}
	markReplayed(sessionId: string): void {
		withSqliteTransaction(
			this.db,
			() => {
				this.db.prepare("INSERT INTO replayed VALUES(?) ON CONFLICT DO NOTHING").run(sessionId);
				this.db.prepare("DELETE FROM unavailable WHERE session_id=?").run(sessionId);
			},
			"projection replay checkpoint",
		);
	}
	noteUnavailable(sessionId: string, reason: string): void {
		this.db
			.prepare("INSERT INTO unavailable VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET reason=excluded.reason")
			.run(sessionId, reason.slice(0, 1024));
	}
	unavailable(): number {
		return Number(this.db.prepare("SELECT count(*) AS n FROM unavailable").get()?.n ?? 0);
	}
	unresolved(): number {
		return Number(
			this.db
				.prepare(
					"SELECT count(*) AS n FROM source_groups WHERE state='quarantined' OR (state='unreviewed' AND candidate=1)",
				)
				.get()?.n ?? 0,
		);
	}
}
