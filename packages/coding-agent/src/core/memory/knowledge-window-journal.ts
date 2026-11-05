/** Source coverage checkpoints, sharing the collection claim and canonical knowledge transaction. */
import { type SqliteDatabase, withSqliteTransaction } from "../context/sqlite-database.ts";
import type { OwnerEvidenceRecord } from "../learning/owner-evidence-ledger.ts";
import {
	nextOwnerEvidenceWindow,
	type OwnerEvidenceWindow,
	ownerEvidenceWindow,
	splitOwnerEvidenceWindow,
} from "../learning/owner-evidence-window.ts";
import type { KnowledgeCollectionClaim } from "./knowledge-collection-journal.ts";
import { retireKnowledgeExtraction } from "./knowledge-work-journal.ts";

export const KNOWLEDGE_WINDOW_SCHEMA = `CREATE TABLE collection_windows (
 id TEXT NOT NULL, source_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','split','done','held')),
 manifest TEXT, manifest_digest TEXT, PRIMARY KEY(source_id,id)
) STRICT;
CREATE INDEX collection_window_source ON collection_windows(source_id,start);`;

export class KnowledgeWindowJournal {
	private readonly db: SqliteDatabase;
	private readonly assertClaim: (claim: KnowledgeCollectionClaim) => void;
	constructor(db: SqliteDatabase, assertClaim: (claim: KnowledgeCollectionClaim) => void) {
		this.db = db;
		this.assertClaim = assertClaim;
	}
	next(claim: KnowledgeCollectionClaim, source: OwnerEvidenceRecord): OwnerEvidenceWindow | undefined {
		return withSqliteTransaction(
			this.db,
			() => {
				this.assertClaim(claim);
				const row = this.db
					.prepare(
						"SELECT id,start,end FROM collection_windows WHERE source_id=? AND state='pending' ORDER BY start LIMIT 1",
					)
					.get(claim.id);
				if (row) {
					if (typeof row.start !== "number" || typeof row.end !== "number")
						throw new Error("Invalid source coverage bounds");
					const window = ownerEvidenceWindow(source, row.start, row.end);
					if (window.id !== row.id || window.sourceDigest !== claim.source.digest)
						throw new Error("Source coverage identity changed");
					return window;
				}
				const end =
					this.db.prepare("SELECT max(end) AS end FROM collection_windows WHERE source_id=?").get(claim.id)?.end ??
					0;
				if (typeof end !== "number") throw new Error("Invalid source coverage endpoint");
				const window = nextOwnerEvidenceWindow(source, end);
				if (window) {
					this.insert(claim, window);
					return window;
				}
				const held = this.db
					.prepare(
						"SELECT id,start,end,manifest,manifest_digest FROM collection_windows WHERE source_id=? AND state='held' ORDER BY start LIMIT 1",
					)
					.get(claim.id);
				if (!held) return undefined;
				if (typeof held.start !== "number" || typeof held.end !== "number")
					throw new Error("Invalid held source bounds");
				this.db
					.prepare("UPDATE collection_sources SET manifest=?,manifest_digest=? WHERE id=?")
					.run(held.manifest, held.manifest_digest, claim.id);
				this.db
					.prepare("UPDATE collection_windows SET state='pending' WHERE source_id=? AND id=?")
					.run(claim.id, held.id);
				return ownerEvidenceWindow(source, held.start, held.end);
			},
			"Knowledge source coverage",
		);
	}
	split(claim: KnowledgeCollectionClaim, source: OwnerEvidenceRecord, window: OwnerEvidenceWindow): void {
		withSqliteTransaction(
			this.db,
			() => {
				this.assertClaim(claim);
				const children = splitOwnerEvidenceWindow(source, window);
				this.db
					.prepare("UPDATE collection_windows SET state='split' WHERE id=? AND source_id=? AND state='pending'")
					.run(window.id, claim.id);
				for (const child of children) this.insert(claim, child);
				retireKnowledgeExtraction(this.db, claim.id, window.id);
			},
			"Knowledge source subdivision",
		);
	}
	complete(claim: KnowledgeCollectionClaim, window: OwnerEvidenceWindow): void {
		withSqliteTransaction(
			this.db,
			() => {
				this.assertClaim(claim);
				this.db
					.prepare("UPDATE collection_windows SET state='done' WHERE id=? AND source_id=? AND state='pending'")
					.run(window.id, claim.id);
				this.db
					.prepare("UPDATE collection_sources SET manifest=NULL,manifest_digest=NULL WHERE id=?")
					.run(claim.id);
				retireKnowledgeExtraction(this.db, claim.id, window.id);
			},
			"Knowledge source checkpoint",
		);
	}
	suspend(claim: KnowledgeCollectionClaim, window: OwnerEvidenceWindow): void {
		withSqliteTransaction(
			this.db,
			() => {
				this.assertClaim(claim);
				this.db
					.prepare(
						"UPDATE collection_windows SET state='held',manifest=(SELECT manifest FROM collection_sources WHERE id=?),manifest_digest=(SELECT manifest_digest FROM collection_sources WHERE id=?) WHERE source_id=? AND id=?",
					)
					.run(claim.id, claim.id, claim.id, window.id);
				this.db
					.prepare("UPDATE collection_sources SET manifest=NULL,manifest_digest=NULL WHERE id=?")
					.run(claim.id);
			},
			"Knowledge held window",
		);
	}
	finish(claim: KnowledgeCollectionClaim, sourceChars: number): void {
		withSqliteTransaction(
			this.db,
			() => {
				this.assertClaim(claim);
				const row = this.db
					.prepare(
						"SELECT count(*) AS count,sum(end-start) AS chars FROM collection_windows WHERE source_id=? AND state='done'",
					)
					.get(claim.id)!;
				const pending = this.db
					.prepare("SELECT 1 FROM collection_windows WHERE source_id=? AND state IN ('pending','held') LIMIT 1")
					.get(claim.id);
				if (pending || row.chars !== sourceChars || !row.count)
					throw new Error("Original source coverage is incomplete");
				this.db
					.prepare("UPDATE collection_sources SET status='processed',token=NULL,expires=NULL WHERE id=?")
					.run(claim.id);
			},
			"Knowledge source completion",
		);
	}
	private insert(claim: KnowledgeCollectionClaim, window: OwnerEvidenceWindow): void {
		if (window.sourceDigest !== claim.source.digest) throw new Error("Source window digest changed");
		this.db
			.prepare("INSERT OR IGNORE INTO collection_windows VALUES(?,?,?,?,'pending',NULL,NULL)")
			.run(window.id, claim.id, window.coreStart, window.coreEnd);
	}
}
