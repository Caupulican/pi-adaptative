/** Durable collection ownership and content-free replay proofs, on the knowledge store's connection. */
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { type SqliteDatabase, withSqliteTransaction } from "../context/sqlite-database.ts";
import { hasMaskableSecretText } from "../security/secret-text.ts";
import { canonicalDigest } from "../steering/canonical.ts";
import {
	type KnowledgeAdmissionOperation,
	type KnowledgeChange,
	knowledgeChangeSchema,
	parseKnowledgeChange,
} from "./knowledge-admission.ts";
import { isKnowledgeScope, isKnowledgeTimestamp, type KnowledgeScope } from "./knowledge-record.ts";

export const MAX_COLLECTION_CANDIDATES = 32;
const MAX_MANIFEST_CHARS = 256_000;
const CLAIM_MS = 5 * 60_000;

export interface KnowledgeCollectionSource {
	readonly sourceId: string;
	readonly digest: string;
	readonly createdAt: string;
	readonly scope: KnowledgeScope;
	readonly extractorVersion: string;
}

export interface KnowledgeCollectionClaim {
	readonly source: KnowledgeCollectionSource;
	readonly id: string;
	readonly token: string;
}

export interface KnowledgeCollectionCandidate {
	readonly operationId: string;
	readonly expectedDigest: string;
	readonly outcome: "pending" | "applied" | "rejected";
	readonly change?: KnowledgeChange;
}

export interface KnowledgeCollectionPlan {
	readonly digest: string;
	readonly candidates: readonly KnowledgeCollectionCandidate[];
}

/** A hold resumes only when its dependency fingerprint changes, or its retry time arrives. */
export interface KnowledgeCollectionHold {
	readonly code: string;
	readonly dependency: string;
	readonly retryAt?: number;
}

export const KNOWLEDGE_COLLECTION_SCHEMA = `
CREATE TABLE collection_meta (id INTEGER PRIMARY KEY CHECK(id=1), forget_barrier TEXT) STRICT;
INSERT INTO collection_meta VALUES(1,NULL);
CREATE TABLE collection_sources (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, digest TEXT NOT NULL, scope TEXT NOT NULL, extractor TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','claimed','held','processed')),
 token TEXT, expires INTEGER, manifest TEXT CHECK(manifest IS NULL OR length(manifest)<=2200),
 manifest_digest TEXT, hold_code TEXT, dependency TEXT, retry_at INTEGER
) STRICT;
CREATE TABLE collection_candidates (
 operation_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, digest TEXT NOT NULL,
 body TEXT CHECK(body IS NULL OR length(body)<=64000),
 outcome TEXT NOT NULL CHECK(outcome IN ('pending','applied','rejected','invalidated'))
) STRICT;
CREATE INDEX collection_candidate_source ON collection_candidates(source_id);`;

function requireDigest(value: string): void {
	if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError("Invalid collection digest");
}

function sourceIdentity(source: KnowledgeCollectionSource): string {
	if (
		!source.sourceId ||
		source.sourceId.length > 200 ||
		!source.extractorVersion ||
		source.extractorVersion.length > 80 ||
		!isKnowledgeScope(source.scope) ||
		!isKnowledgeTimestamp(source.createdAt)
	)
		throw new TypeError("Invalid collection source");
	// Extraction versions may revisit a source, but exact candidate effects retain the same identity.
	requireDigest(source.digest);
	return canonicalDigest(source);
}

function timestamp(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error("Invalid collection timestamp");
	return value;
}

/** Shared by extraction versions, so revisiting a source cannot rebind an operation to another job. */
function candidateSourceIdentity(source: KnowledgeCollectionSource): string {
	return canonicalDigest({ source: source.sourceId, original: source.digest, scope: source.scope });
}

export class KnowledgeCollectionJournal {
	private readonly db: SqliteDatabase;
	constructor(db: SqliteDatabase) {
		this.db = db;
	}

	/** The active branch supplies the source; this journal never discovers another branch's inputs. */
	claim(source: KnowledgeCollectionSource, dependency: string): KnowledgeCollectionClaim | undefined {
		const id = sourceIdentity(source);
		requireDigest(dependency);
		return withSqliteTransaction(
			this.db,
			() => {
				this.db
					.prepare(`INSERT OR IGNORE INTO collection_sources(id,source,digest,scope,extractor,status)
				VALUES(?,?,?,?,?,'pending')`)
					.run(id, source.sourceId, source.digest, JSON.stringify(source.scope), source.extractorVersion);
				const row = this.db
					.prepare("SELECT status,expires,dependency,retry_at FROM collection_sources WHERE id=?")
					.get(id)!;
				const now = Date.now();
				if (
					row.status === "processed" ||
					(row.status === "claimed" && timestamp(row.expires) > now) ||
					(row.status === "held" &&
						row.dependency === dependency &&
						(row.retry_at === null || timestamp(row.retry_at) > now))
				)
					return undefined;
				const token = randomUUID();
				this.db
					.prepare(
						"UPDATE collection_sources SET status='claimed',token=?,expires=?,hold_code=NULL,dependency=NULL,retry_at=NULL WHERE id=?",
					)
					.run(token, now + CLAIM_MS, id);
				return { id, token, source: structuredClone(source) };
			},
			"Knowledge collection claim",
		);
	}

	/** Also called inside the knowledge mutation transaction. */
	assertCurrent(claim: KnowledgeCollectionClaim): void {
		if (claim.id !== sourceIdentity(claim.source)) throw new Error("Collection source identity changed");
		const row = this.db.prepare("SELECT status,token,expires FROM collection_sources WHERE id=?").get(claim.id);
		if (row?.status !== "claimed" || row.token !== claim.token || timestamp(row.expires) <= Date.now())
			throw new Error("Knowledge collection claim is no longer current");
	}

	renew(claim: KnowledgeCollectionClaim): void {
		this.mutate(claim, () => {
			this.db.prepare("UPDATE collection_sources SET expires=? WHERE id=?").run(Date.now() + CLAIM_MS, claim.id);
		});
	}

	/** Undefined means extraction is needed. After forgetting, old sources keep proposal bodies transient. */
	read(claim: KnowledgeCollectionClaim): KnowledgeCollectionPlan | undefined {
		this.assertCurrent(claim);
		const row = this.db.prepare("SELECT manifest,manifest_digest FROM collection_sources WHERE id=?").get(claim.id)!;
		if (row.manifest === null) return undefined;
		if (typeof row.manifest !== "string" || row.manifest.length > 2_200)
			throw new Error("Invalid collection manifest");
		const ids: unknown = JSON.parse(row.manifest);
		if (
			!Array.isArray(ids) ||
			ids.length > MAX_COLLECTION_CANDIDATES ||
			new Set(ids).size !== ids.length ||
			!ids.every((id): id is string => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) ||
			canonicalDigest(ids) !== row.manifest_digest
		)
			throw new Error("Collection manifest integrity failed");
		const candidates: KnowledgeCollectionCandidate[] = [];
		for (const id of ids) {
			const candidate = this.db
				.prepare("SELECT digest,body,outcome FROM collection_candidates WHERE source_id=? AND operation_id=?")
				.get(candidateSourceIdentity(claim.source), id);
			if (!candidate || typeof candidate.digest !== "string") throw new Error("Missing collection candidate");
			requireDigest(candidate.digest);
			const applied = this.hasReceipt(id, candidate.digest);
			if (candidate.outcome === "applied" && !applied)
				throw new Error("Applied collection candidate has no receipt");
			if (applied || candidate.outcome === "rejected") {
				candidates.push({
					operationId: id,
					expectedDigest: candidate.digest,
					outcome: applied ? "applied" : "rejected",
				});
				continue;
			}
			if (candidate.body === null) return undefined;
			if (candidate.outcome !== "pending" || typeof candidate.body !== "string" || candidate.body.length > 64_000)
				throw new Error("Invalid collection candidate state");
			const change: unknown = JSON.parse(candidate.body);
			if (
				!Value.Check(knowledgeChangeSchema, change) ||
				canonicalDigest({ change, scope: claim.source.scope }) !== candidate.digest
			)
				throw new Error("Collection candidate integrity failed");
			candidates.push({ operationId: id, expectedDigest: candidate.digest, outcome: "pending", change });
		}
		return { digest: row.manifest_digest as string, candidates };
	}

	/** A current complete plan is immutable. Re-extraction restores only a missing/transient plan. */
	install(claim: KnowledgeCollectionClaim, changes: readonly KnowledgeChange[]): KnowledgeCollectionPlan {
		if (
			changes.length > MAX_COLLECTION_CANDIDATES ||
			!changes.every((change) => Value.Check(knowledgeChangeSchema, change))
		)
			throw new Error("Invalid collection candidates");
		const validated = changes.map(parseKnowledgeChange);
		if (validated.some((change) => !change.evidence.some((citation) => citation.source === claim.source.sourceId)))
			throw new Error("A collection candidate must cite its claimed source");
		const text = JSON.stringify(validated);
		if (text.length > MAX_MANIFEST_CHARS || hasMaskableSecretText(text))
			throw new Error("Unsafe collection manifest");
		return this.mutate(claim, () => {
			if (this.read(claim)) throw new Error("Collection already has an immutable plan");
			const barrier = this.db.prepare("SELECT forget_barrier FROM collection_meta WHERE id=1").get()?.forget_barrier;
			if (barrier !== null && !isKnowledgeTimestamp(barrier))
				throw new Error("Invalid collection forgetting barrier");
			const candidates: KnowledgeCollectionCandidate[] = validated.map((input) => {
				const change = structuredClone(input);
				// Old evidence introduced through a newer source must not re-persist forgotten values.
				const retainBody =
					barrier === null ||
					(claim.source.createdAt > barrier &&
						change.evidence.every((citation) => citation.source === claim.source.sourceId));
				const expectedDigest = canonicalDigest({ change, scope: claim.source.scope });
				const operationId = canonicalDigest({
					source: candidateSourceIdentity(claim.source),
					candidate: expectedDigest,
				});
				const previous = this.db
					.prepare("SELECT outcome FROM collection_candidates WHERE operation_id=?")
					.get(operationId);
				const outcome = this.hasReceipt(operationId, expectedDigest)
					? "applied"
					: previous?.outcome === "rejected"
						? "rejected"
						: "pending";
				this.db
					.prepare(`INSERT INTO collection_candidates VALUES(?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET
					source_id=excluded.source_id,body=excluded.body,outcome=excluded.outcome`)
					.run(
						operationId,
						candidateSourceIdentity(claim.source),
						expectedDigest,
						retainBody && outcome === "pending" ? JSON.stringify(change) : null,
						outcome,
					);
				return { operationId, expectedDigest, outcome, ...(outcome === "pending" ? { change } : {}) };
			});
			const ids = candidates.map((candidate) => candidate.operationId);
			if (new Set(ids).size !== ids.length) throw new Error("Duplicate collection candidate");
			const digest = canonicalDigest(ids);
			this.db
				.prepare("UPDATE collection_sources SET manifest=?,manifest_digest=? WHERE id=?")
				.run(JSON.stringify(ids), digest, claim.id);
			return { digest, candidates };
		});
	}

	operation(
		claim: KnowledgeCollectionClaim,
		plan: KnowledgeCollectionPlan,
		index: number,
	): KnowledgeAdmissionOperation {
		const candidate = plan.candidates[index];
		if (!candidate?.change || candidate.outcome !== "pending") throw new Error("Collection has no pending candidate");
		const assertClaimCurrent = () => {
			this.assertCurrent(claim);
			const current = this.db.prepare("SELECT manifest_digest FROM collection_sources WHERE id=?").get(claim.id);
			const stored = this.db
				.prepare("SELECT digest FROM collection_candidates WHERE source_id=? AND operation_id=?")
				.get(candidateSourceIdentity(claim.source), candidate.operationId);
			if (
				stored?.digest !== candidate.expectedDigest ||
				current?.manifest_digest !== plan.digest ||
				canonicalDigest(plan.candidates.map((item) => item.operationId)) !== plan.digest
			)
				throw new Error("Collection plan changed during admission");
		};
		assertClaimCurrent();
		return { operationId: candidate.operationId, expectedDigest: candidate.expectedDigest, assertClaimCurrent };
	}

	/** Applied effects may be acknowledged after forgetting invalidated this claim, without touching a successor. */
	acknowledge(
		claim: KnowledgeCollectionClaim,
		operation: KnowledgeAdmissionOperation,
		outcome: "applied" | "rejected",
	): void {
		withSqliteTransaction(
			this.db,
			() => {
				const row = this.db
					.prepare("SELECT digest FROM collection_candidates WHERE source_id=? AND operation_id=?")
					.get(candidateSourceIdentity(claim.source), operation.operationId);
				if (row?.digest !== operation.expectedDigest)
					throw new Error("Collection acknowledgement has no matching candidate");
				if (outcome === "applied") {
					if (!this.hasReceipt(operation.operationId, operation.expectedDigest))
						throw new Error("Collection effect has no durable receipt");
				} else if (outcome === "rejected") {
					operation.assertClaimCurrent();
					if (this.hasReceipt(operation.operationId, operation.expectedDigest))
						throw new Error("An applied collection operation cannot be rejected");
				} else throw new Error("Invalid collection outcome");
				this.db
					.prepare("UPDATE collection_candidates SET outcome=?,body=NULL WHERE operation_id=?")
					.run(outcome, operation.operationId);
			},
			"Knowledge collection acknowledgement",
		);
	}

	finish(claim: KnowledgeCollectionClaim): void {
		this.mutate(claim, () => {
			const plan = this.read(claim);
			if (!plan || plan.candidates.some((candidate) => candidate.outcome === "pending"))
				throw new Error("Collection cannot finish with unreviewed candidates");
			for (const candidate of plan.candidates)
				this.db
					.prepare("UPDATE collection_candidates SET body=NULL,outcome=? WHERE operation_id=?")
					.run(candidate.outcome, candidate.operationId);
			this.db
				.prepare("UPDATE collection_sources SET status='processed',token=NULL,expires=NULL WHERE id=?")
				.run(claim.id);
		});
	}

	hold(claim: KnowledgeCollectionClaim, hold: KnowledgeCollectionHold): void {
		if (!hold.code || hold.code.length > 80) throw new TypeError("Invalid collection hold");
		requireDigest(hold.dependency);
		if (hold.retryAt !== undefined) timestamp(hold.retryAt);
		this.mutate(claim, () => {
			this.db
				.prepare(
					"UPDATE collection_sources SET status='held',token=NULL,expires=NULL,hold_code=?,dependency=?,retry_at=? WHERE id=?",
				)
				.run(hold.code, hold.dependency, hold.retryAt ?? null, claim.id);
		});
	}

	/** Idempotent cancellation never releases a successor's claim. */
	release(claim: KnowledgeCollectionClaim): void {
		this.db
			.prepare(
				"UPDATE collection_sources SET status='pending',token=NULL,expires=NULL WHERE id=? AND status='claimed' AND token=?",
			)
			.run(claim.id, claim.token);
	}

	/** Called inside forgetting's transaction, after its effect receipt is inserted. */
	discardPendingValues(barrier: string): void {
		if (!isKnowledgeTimestamp(barrier)) throw new Error("Invalid forgetting barrier");
		this.db
			.prepare("UPDATE collection_meta SET forget_barrier=max(coalesce(forget_barrier,''),?) WHERE id=1")
			.run(barrier);
		this.db
			.prepare(`UPDATE collection_candidates SET body=NULL,outcome=CASE
			WHEN EXISTS(SELECT 1 FROM operation_receipts r WHERE r.operation_id=collection_candidates.operation_id AND r.digest=collection_candidates.digest) THEN 'applied'
			WHEN outcome='rejected' THEN 'rejected' ELSE 'invalidated' END`)
			.run();
		this.db
			.prepare(`UPDATE collection_sources SET status='pending',token=NULL,expires=NULL,
			manifest=NULL,manifest_digest=NULL,hold_code=NULL,dependency=NULL,retry_at=NULL WHERE status<>'processed'`)
			.run();
	}

	private hasReceipt(id: string, digest: string): boolean {
		const row = this.db.prepare("SELECT digest FROM operation_receipts WHERE operation_id=?").get(id);
		if (row && row.digest !== digest) throw new Error("Collection operation payload changed");
		return row !== undefined;
	}

	private mutate<T>(claim: KnowledgeCollectionClaim, action: () => T): T {
		return withSqliteTransaction(
			this.db,
			() => {
				this.assertCurrent(claim);
				return action();
			},
			"Knowledge collection progress",
		);
	}
}
