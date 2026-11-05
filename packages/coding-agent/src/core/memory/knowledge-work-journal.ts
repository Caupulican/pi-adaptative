/**
 * Retained semantic work on the canonical knowledge connection; never a separate spend ledger.
 *
 * `started`: a physical request was admitted and no usable result was retained; automatic replay is refused, even after
 * its charge settles, because the provider may have produced a result nobody received (an abort, an ended process).
 * Only the caller that saw its own request end in a received, measured failure releases the cell: that outcome is
 * known, so trying again is not a replay of an unknown one.
 * `complete`: the typed result is retained and reused without another request.
 * `retired`: a content-free identity whose value is no longer retained (its owner finished with it, or forgetting
 * erased it). Work that is needed again is new paid work, bounded by the caller's existing spending owner.
 */
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

/**
 * Forgetting erases retained extraction payloads, which may quote forgotten content. Grounding verdicts are
 * content-free and keyed by their exact candidate, target revision and policy; the store's forgetting rules
 * still refuse forgotten evidence at commit. Unresolved physical requests keep their identity.
 */
export function eraseKnowledgeWorkValues(db: SqliteDatabase): void {
	db.prepare(
		"UPDATE knowledge_work SET result=NULL,state='retired',outcome='forgotten' WHERE kind='extraction' AND state='complete'",
	).run();
}

/** A paid attempt whose outcome is unknown: it is never replayed automatically. */
export class KnowledgeWorkUnresolved extends Error {}

export interface KnowledgeWorkCache {
	read(id: string): unknown;
	beginBatch(work: readonly KnowledgeWorkIdentity[], requestId: string): void;
	complete(id: string, result: unknown, outcome?: "complete" | "subdivide" | "judged"): void;
	/**
	 * The caller's own request ended, not aborted, without a retained result: the cell is released only when that
	 * response was received and measured. Never call it for an aborted request.
	 */
	settle(id: string): void;
	/** Resolves a started request whose result must not be retained; it can be requested again later. */
	discard(id: string, outcome?: "forgotten" | null): void;
	barrier(): string | null;
	/** Results this process retained so far; a caller compares two readings to learn whether its work progressed. */
	retainedCount(): number;
}

export class KnowledgeWorkJournal implements KnowledgeWorkCache {
	private readonly db: SqliteDatabase;
	private readonly hasUsageReceipt: (requestId: string) => boolean;
	private retained = 0;
	constructor(db: SqliteDatabase, hasUsageReceipt: (requestId: string) => boolean = () => false) {
		this.db = db;
		this.hasUsageReceipt = hasUsageReceipt;
	}
	read(id: string): unknown {
		const row = this.db.prepare("SELECT state,result,result_digest FROM knowledge_work WHERE id=?").get(id);
		if (!row || row.state === "retired") return undefined;
		if (row.state === "started")
			throw new KnowledgeWorkUnresolved(
				"Knowledge work has an unresolved paid attempt; automatic replay is refused",
			);
		if (typeof row.result !== "string") throw new Error("Knowledge work result is missing");
		const result: unknown = JSON.parse(row.result);
		if (canonicalDigest(result) !== row.result_digest) throw new Error("Knowledge work result integrity failed");
		return result;
	}
	/** All identities begin together or none does; only retired identities may begin again. */
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
				const existing = this.db.prepare("SELECT state,kind FROM knowledge_work WHERE id=?");
				const insert = this.db.prepare(
					"INSERT OR REPLACE INTO knowledge_work VALUES(?,?,?,?,?,?,'started',NULL,NULL,NULL)",
				);
				for (const item of work) {
					const row = existing.get(item.id);
					if (row && (row.state !== "retired" || row.kind !== item.kind))
						throw new Error("Knowledge work already has a retained or unresolved attempt");
					insert.run(item.id, requestId, item.owner, item.window, item.kind, barrier);
				}
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
				const row = this.db
					.prepare("SELECT kind,barrier FROM knowledge_work WHERE id=? AND state='started'")
					.get(id);
				if (!row) return;
				// An extraction begun before a forget may quote what was forgotten; it is not retained.
				if (row.kind === "extraction" && row.barrier !== this.barrier()) {
					this.discard(id, "forgotten");
					return;
				}
				this.db
					.prepare(
						"UPDATE knowledge_work SET state='complete',result=?,result_digest=?,outcome=? WHERE id=? AND state='started'",
					)
					.run(text, canonicalDigest(result), outcome, id);
				// The started row was read in this transaction, so the update retained this result.
				this.retained++;
			},
			"Knowledge work result",
		);
	}
	settle(id: string): void {
		const row = this.db.prepare("SELECT state,request_id FROM knowledge_work WHERE id=?").get(id);
		if (row?.state === "started" && typeof row.request_id === "string" && this.hasUsageReceipt(row.request_id))
			this.discard(id);
	}
	/** Retires a started cell: `forgotten` when a forget fenced its result, no outcome when its request ended without one. */
	discard(id: string, outcome: "forgotten" | null = null): void {
		this.db
			.prepare(
				"UPDATE knowledge_work SET state='retired',result=NULL,result_digest=NULL,outcome=? WHERE id=? AND state='started'",
			)
			.run(outcome, id);
	}
	retainedCount(): number {
		return this.retained;
	}
	barrier(): string | null {
		const value = this.db.prepare("SELECT forget_barrier FROM collection_meta WHERE id=1").get()?.forget_barrier;
		if (value !== null && typeof value !== "string") throw new Error("Invalid knowledge work barrier");
		return value;
	}
}
