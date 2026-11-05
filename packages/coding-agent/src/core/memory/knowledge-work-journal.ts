/** Retained semantic work on the canonical knowledge connection; never a separate spend ledger. */
import { type SqliteDatabase, withSqliteTransaction } from "../context/sqlite-database.ts";
import { hasMaskableSecretText } from "../security/secret-text.ts";
import { canonicalDigest } from "../steering/canonical.ts";

export const KNOWLEDGE_WORK_SCHEMA = `CREATE TABLE knowledge_work (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL, owner TEXT NOT NULL, window TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('extraction','grounding')), barrier TEXT,
 state TEXT NOT NULL CHECK(state IN ('started','complete','retired')),
 result TEXT CHECK(result IS NULL OR length(result)<=256000), result_digest TEXT,
 outcome TEXT CHECK(outcome IS NULL OR outcome IN ('complete','subdivide','judged','forgotten'))
) STRICT;
CREATE INDEX knowledge_work_owner ON knowledge_work(owner,window,kind);`;

export interface KnowledgeWorkIdentity {
	readonly id: string;
	readonly owner: string;
	readonly window: string;
	readonly kind: "extraction" | "grounding";
}

/** The caller's coverage transaction retires only work whose resumable payload is no longer needed. */
export function retireKnowledgeExtraction(db: SqliteDatabase, owner: string, window: string): void {
	db.prepare(
		"UPDATE knowledge_work SET state='retired',result=NULL WHERE owner=? AND window=? AND kind='extraction' AND state='complete'",
	).run(owner, window);
}

/** Forgetting erases values, never the identity of an unresolved physical request. */
export function eraseKnowledgeWorkValues(db: SqliteDatabase): void {
	db.prepare(
		"UPDATE knowledge_work SET result=NULL,state=CASE WHEN state='started' THEN 'started' ELSE 'retired' END,outcome=CASE WHEN state='started' THEN outcome ELSE 'forgotten' END",
	).run();
}

export interface KnowledgeWorkCache {
	read(id: string): unknown;
	beginBatch(work: readonly KnowledgeWorkIdentity[], requestId: string): void;
	complete(id: string, result: unknown, outcome?: "complete" | "subdivide" | "judged"): void;
	barrier(): string | null;
}

export class KnowledgeWorkJournal implements KnowledgeWorkCache {
	private readonly db: SqliteDatabase;
	constructor(db: SqliteDatabase) {
		this.db = db;
	}
	read(id: string): unknown {
		const row = this.db.prepare("SELECT state,result,result_digest FROM knowledge_work WHERE id=?").get(id);
		if (!row) return undefined;
		if (row.state === "retired") throw new Error("Knowledge work payload was retired; automatic replay is refused");
		if (row.state !== "complete" || typeof row.result !== "string")
			throw new Error("Knowledge work has an unresolved paid attempt; automatic replay is refused");
		const result: unknown = JSON.parse(row.result);
		if (canonicalDigest(result) !== row.result_digest) throw new Error("Knowledge work result integrity failed");
		if (row.result === '{"discarded":true}') throw new Error("Knowledge work result was erased by forgetting");
		return result;
	}
	beginBatch(work: readonly KnowledgeWorkIdentity[], requestId: string): void {
		if (!work.length || work.length > 32 || new Set(work.map((item) => item.id)).size !== work.length)
			throw new Error("Invalid knowledge work batch");
		for (const item of work) {
			if (
				![item.id, item.owner, item.window].every((value) => /^[a-f0-9]{64}$/.test(value)) ||
				(item.kind !== "extraction" && item.kind !== "grounding")
			)
				throw new Error("Invalid knowledge work identity");
		}
		if (!requestId || requestId.length > 200) throw new Error("Invalid knowledge work request identity");
		withSqliteTransaction(
			this.db,
			() => {
				const barrier = this.barrier();
				const insert = this.db.prepare("INSERT INTO knowledge_work VALUES(?,?,?,?,?,?,'started',NULL,NULL,NULL)");
				for (const item of work) insert.run(item.id, requestId, item.owner, item.window, item.kind, barrier);
			},
			"Knowledge work batch admission",
		);
	}
	complete(id: string, result: unknown, outcome: "complete" | "subdivide" | "judged" = "judged"): void {
		const text = JSON.stringify(result);
		if (!text || text.length > 256_000 || hasMaskableSecretText(text))
			throw new Error("Unsafe knowledge work result");
		withSqliteTransaction(
			this.db,
			() => {
				const row = this.db.prepare("SELECT barrier FROM knowledge_work WHERE id=? AND state='started'").get(id);
				if (!row) return;
				if (row.barrier !== this.barrier()) {
					this.db
						.prepare(
							"UPDATE knowledge_work SET state='retired',result=NULL,result_digest=?,outcome='forgotten' WHERE id=?",
						)
						.run(canonicalDigest(result), id);
					return;
				}
				this.db
					.prepare(
						"UPDATE knowledge_work SET state='complete',result=?,result_digest=?,outcome=? WHERE id=? AND state='started'",
					)
					.run(text, canonicalDigest(result), outcome, id);
			},
			"Knowledge work result",
		);
	}
	barrier(): string | null {
		const value = this.db.prepare("SELECT forget_barrier FROM collection_meta WHERE id=1").get()?.forget_barrier;
		if (value !== null && typeof value !== "string") throw new Error("Invalid knowledge work barrier");
		return value;
	}
}
