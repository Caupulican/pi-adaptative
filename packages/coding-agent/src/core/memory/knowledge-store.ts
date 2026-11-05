/** SQLite adapter for the ICM knowledge collection, with paged reads and atomic mutation effects. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { knowledgeDatabaseFile } from "../agent-paths.ts";
import { constructSqliteDatabase, type SqliteDatabase, withSqliteTransaction } from "../context/sqlite-database.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { KNOWLEDGE_COLLECTION_SCHEMA, KnowledgeCollectionJournal } from "./knowledge-collection-journal.ts";
import {
	isKnowledgeCitation,
	isKnowledgeScope,
	isKnowledgeTimestamp,
	KNOWLEDGE_KINDS,
	type KnowledgeCitation,
	type KnowledgeEvidenceFence,
	type KnowledgeKind,
	type KnowledgeListOptions,
	type KnowledgeMutationReceipt,
	type KnowledgeOperation,
	type KnowledgeRecord,
	type KnowledgeRecordSnapshot,
	type KnowledgeScope,
	type KnowledgeSlot,
	type KnowledgeStorePort,
	knowledgeAppliesTo,
	MAX_KNOWLEDGE_CITATIONS,
	MAX_KNOWLEDGE_PAGE_SIZE,
	parseKnowledgeRecord,
	parseKnowledgeSlot,
} from "./knowledge-record.ts";
import { KNOWLEDGE_WINDOW_SCHEMA } from "./knowledge-window-journal.ts";
import { KNOWLEDGE_WORK_SCHEMA, KnowledgeWorkJournal } from "./knowledge-work-journal.ts";
import { MemoryMutationAdmission } from "./memory-mutation-admission.ts";

const SCHEMA_VERSION = 5;
const MAX_QUERY_TERMS = 8;
/**
 * Forgotten identities keep only their digest: the plaintext subject/key is erased, so no later identity judgment can
 * send a forgotten name to a provider. The forget fence replaces name matching for alternate wording; legacy
 * forgotten rows seed it with their own barrier, the most conservative time they retain.
 */
const SCHEMA_V5 = `ALTER TABLE meta ADD COLUMN forget_fence TEXT;
UPDATE meta SET forget_fence=(SELECT max(evidence_after) FROM entries WHERE body IS NULL) WHERE id=1;
UPDATE entries SET identity=NULL WHERE body IS NULL;
PRAGMA user_version=${SCHEMA_VERSION};`;

function terms(text: string): string[] {
	return [
		...new Set(
			text
				.normalize("NFKC")
				.toLowerCase()
				.match(/[\p{L}\p{N}_-]+/gu) ?? [],
		),
	];
}

function requireId(id: string): void {
	if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError("Invalid knowledge identity");
}

function requireVersion(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError("Invalid knowledge revision");
	}
	return value;
}

function decode(row: Record<string, unknown>): KnowledgeRecord {
	if (typeof row.body !== "string" || row.body.length > 64_000) throw new Error("Invalid knowledge row");
	const record = parseKnowledgeRecord(JSON.parse(row.body));
	if (row.id !== record.id || row.revision !== record.revision) throw new Error("Knowledge row identity changed");
	return record;
}

export class KnowledgeStore implements KnowledgeStorePort {
	private readonly db: SqliteDatabase;
	readonly collection: KnowledgeCollectionJournal;
	readonly work: KnowledgeWorkJournal;
	private closed = false;

	private constructor(db: SqliteDatabase, collectionTime?: Pick<TimerPort, "now">) {
		this.db = db;
		this.collection = new KnowledgeCollectionJournal(db, collectionTime);
		this.work = new KnowledgeWorkJournal(db);
	}

	static open(agentDir: string, collectionTime?: Pick<TimerPort, "now">): KnowledgeStore {
		const databasePath = knowledgeDatabaseFile(agentDir);
		mkdirSync(dirname(databasePath), { recursive: true });
		return constructSqliteDatabase({ databasePath }, (db) => {
			db.exec(
				"PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;",
			);
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			if (
				version !== 0 &&
				version !== 1 &&
				version !== 2 &&
				version !== 3 &&
				version !== 4 &&
				version !== SCHEMA_VERSION
			)
				throw new Error("Unsupported ICM knowledge schema");
			const store = new KnowledgeStore(db, collectionTime);
			if (version !== SCHEMA_VERSION)
				store.transaction(() => {
					const lockedVersion = db.prepare("PRAGMA user_version").get()?.user_version;
					if (lockedVersion === SCHEMA_VERSION) return;
					if (lockedVersion === 4) {
						db.exec(SCHEMA_V5);
						return;
					}
					if (lockedVersion === 3) {
						db.exec(`${KNOWLEDGE_WORK_SCHEMA} ${KNOWLEDGE_WINDOW_SCHEMA} ${SCHEMA_V5}`);
						return;
					}
					if (lockedVersion === 1) {
						db.exec(`ALTER TABLE entries ADD COLUMN identity TEXT;
						UPDATE entries SET identity=json_array(json_extract(body,'$.subject'),json_extract(body,'$.key')) WHERE body IS NOT NULL;
						`);
					}
					if (lockedVersion !== 0 && lockedVersion !== 1 && lockedVersion !== 2)
						throw new Error("ICM knowledge schema changed during initialization");
					if (lockedVersion === 0)
						db.exec(`
					CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0)) STRICT;
					INSERT INTO meta VALUES(1,0);
					CREATE TABLE entries (
					 id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), kind TEXT NOT NULL,
					 project TEXT NOT NULL, role TEXT NOT NULL, audience TEXT NOT NULL,
					 body TEXT CHECK(body IS NULL OR length(body)<=64000), evidence_after TEXT NOT NULL, identity TEXT
					) STRICT;
					CREATE INDEX scope ON entries(audience,project,role,kind,id);
					CREATE TABLE versions (
					 id TEXT NOT NULL REFERENCES entries(id), revision INTEGER NOT NULL,
					 body TEXT NOT NULL CHECK(length(body)<=64000), PRIMARY KEY(id,revision)
					) STRICT, WITHOUT ROWID;
					CREATE TABLE terms (term TEXT NOT NULL, id TEXT NOT NULL REFERENCES entries(id), PRIMARY KEY(term,id)) STRICT, WITHOUT ROWID;
					CREATE INDEX terms_entry ON terms(id);
					CREATE TABLE sources (
					 id TEXT NOT NULL REFERENCES entries(id), session TEXT NOT NULL, source TEXT NOT NULL,
					 PRIMARY KEY(id,session,source)
					) STRICT, WITHOUT ROWID;
					CREATE TABLE forgotten_sources (id TEXT NOT NULL REFERENCES entries(id), session TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(id,session,source)) STRICT, WITHOUT ROWID;
				`);
					db.exec(`CREATE TABLE operation_receipts (
					 operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('remember','forget')),
					 entry_id TEXT NOT NULL REFERENCES entries(id), revision INTEGER NOT NULL CHECK(revision>0)
						) STRICT; ${KNOWLEDGE_COLLECTION_SCHEMA} ${KNOWLEDGE_WORK_SCHEMA} ${KNOWLEDGE_WINDOW_SCHEMA} ${SCHEMA_V5}`);
				});
			return store;
		});
	}

	private transaction<T>(run: () => T): T {
		return withSqliteTransaction(this.db, run, "Knowledge");
	}
	revision(): number {
		return requireVersion(this.db.prepare("SELECT revision FROM meta WHERE id=1").get()?.revision);
	}

	version(id: string): number {
		requireId(id);
		return requireVersion(this.db.prepare("SELECT revision FROM entries WHERE id=?").get(id)?.revision ?? 0);
	}

	operationReceipt(operation: KnowledgeOperation): KnowledgeMutationReceipt | undefined {
		requireId(operation.id);
		requireId(operation.digest);
		const row = this.db
			.prepare("SELECT digest,action,entry_id,revision FROM operation_receipts WHERE operation_id=?")
			.get(operation.id);
		if (!row) return undefined;
		if (row.digest !== operation.digest) throw new Error("Knowledge operation identity has a different payload");
		if ((row.action !== "remember" && row.action !== "forget") || typeof row.entry_id !== "string")
			throw new Error("Invalid knowledge operation receipt");
		requireId(row.entry_id);
		const revision = requireVersion(row.revision);
		if (revision < 1) throw new Error("Invalid knowledge operation receipt revision");
		return { action: row.action, id: row.entry_id, revision };
	}

	private recordOperation(
		receipt: KnowledgeMutationReceipt,
		operation?: KnowledgeOperation,
	): KnowledgeMutationReceipt {
		if (operation)
			this.db
				.prepare("INSERT INTO operation_receipts VALUES(?,?,?,?,?)")
				.run(operation.id, operation.digest, receipt.action, receipt.id, receipt.revision);
		return receipt;
	}

	private mutate(
		assertCurrent: () => void,
		signal: AbortSignal | undefined,
		operation: KnowledgeOperation | undefined,
		write: (admission: MemoryMutationAdmission) => KnowledgeMutationReceipt,
	): KnowledgeMutationReceipt {
		const admission = new MemoryMutationAdmission(signal);
		return this.transaction(() => {
			admission.assertPending();
			const replay = operation && this.operationReceipt(operation);
			if (replay) return replay;
			assertCurrent();
			return write(admission);
		});
	}

	/** Revision and all category pages describe one database snapshot, including concurrent writers. */
	snapshot(scope: KnowledgeScope, at: string): KnowledgeRecordSnapshot {
		if (!isKnowledgeScope(scope) || !isKnowledgeTimestamp(at))
			throw new TypeError("Invalid knowledge snapshot scope or time");
		return withSqliteTransaction(
			this.db,
			() => {
				const revision = this.revision();
				const records: KnowledgeRecord[] = [];
				const possiblyMore: KnowledgeKind[] = [];
				for (const kind of KNOWLEDGE_KINDS) {
					// Select current, specific, explicit and recent facts before bounding the page. Hash order alone
					// could permanently hide the useful records even if the projection ranked its subset afterward.
					const page = this.db
						.prepare(`
						SELECT id,revision,body FROM entries
						WHERE body IS NOT NULL AND audience=? AND (project='' OR project=?) AND (role='' OR role=?)
						AND kind=? AND json_extract(body,'$.validFrom')<=?
						AND (json_extract(body,'$.validUntil') IS NULL OR json_extract(body,'$.validUntil')>?)
						ORDER BY (json_extract(body,'$.basis')='explicit') DESC, (project<>'') DESC, (role<>'') DESC,
						json_extract(body,'$.lastEvidencedAt') DESC, id LIMIT ?
					`)
						.all(scope.audience, scope.project, scope.role, kind, at, at, MAX_KNOWLEDGE_PAGE_SIZE)
						.map(decode);
					records.push(...page);
					if (
						page.some(
							(record) =>
								!knowledgeAppliesTo(record.scope, scope) ||
								record.kind !== kind ||
								record.validFrom > at ||
								(record.validUntil !== undefined && record.validUntil <= at),
						)
					)
						throw new Error("Knowledge snapshot index does not match its records");
					if (page.length === MAX_KNOWLEDGE_PAGE_SIZE) possiblyMore.push(kind);
				}
				const refreshAt = this.db
					.prepare(`
					WITH scoped AS (
						SELECT json_extract(body,'$.validFrom') AS start, json_extract(body,'$.validUntil') AS stop
						FROM entries WHERE body IS NOT NULL AND audience=? AND (project='' OR project=?) AND (role='' OR role=?)
					), boundaries AS (SELECT start AS at FROM scoped UNION ALL SELECT stop AS at FROM scoped)
					SELECT min(at) AS at FROM boundaries WHERE at>?
				`)
					.get(scope.audience, scope.project, scope.role, at)?.at;
				if (refreshAt !== null && !isKnowledgeTimestamp(refreshAt))
					throw new Error("Invalid knowledge validity boundary");
				return { revision, records, possiblyMore, ...(refreshAt === null ? {} : { refreshAt }) };
			},
			"Knowledge snapshot",
			"read",
		);
	}

	get(id: string): KnowledgeRecord | undefined {
		requireId(id);
		const row = this.db.prepare("SELECT id,revision,body FROM entries WHERE id=? AND body IS NOT NULL").get(id);
		return row && decode(row);
	}

	slots(scope: KnowledgeScope, kind: KnowledgeKind, after?: string): KnowledgeSlot[] {
		if (!isKnowledgeScope(scope) || !KNOWLEDGE_KINDS.includes(kind))
			throw new TypeError("Invalid knowledge slot scope");
		if (after !== undefined) requireId(after);
		return this.db
			.prepare(`SELECT id,revision,identity FROM entries
			WHERE body IS NOT NULL AND audience=? AND project=? AND role=? AND kind=? AND id>? ORDER BY id LIMIT ?`)
			.all(scope.audience, scope.project, scope.role, kind, after ?? "", MAX_KNOWLEDGE_PAGE_SIZE)
			.map((row) => {
				if (typeof row.identity !== "string" || row.identity.length > 4_000)
					throw new Error("A live knowledge slot has no identity");
				const names: unknown = JSON.parse(row.identity);
				if (!Array.isArray(names) || names.length !== 2) throw new Error("Invalid knowledge slot names");
				return parseKnowledgeSlot({
					id: row.id,
					revision: row.revision,
					kind,
					scope,
					subject: names[0],
					key: names[1],
				});
			});
	}

	evidenceFence(id: string): KnowledgeEvidenceFence | undefined {
		requireId(id);
		const row = this.db
			.prepare("SELECT revision,evidence_after,body IS NULL AS forgotten FROM entries WHERE id=?")
			.get(id);
		if (!row) return undefined;
		if (!isKnowledgeTimestamp(row.evidence_after)) throw new Error("Invalid knowledge evidence barrier");
		return {
			revision: requireVersion(row.revision),
			evidenceAfter: row.evidence_after,
			forgotten: row.forgotten === 1,
		};
	}

	forgetFence(): string | undefined {
		const value = this.db.prepare("SELECT forget_fence FROM meta WHERE id=1").get()?.forget_fence;
		if (value === null || value === undefined) return undefined;
		if (!isKnowledgeTimestamp(value)) throw new Error("Invalid knowledge forget fence");
		return value;
	}

	list(scope: KnowledgeScope, options: KnowledgeListOptions = {}): KnowledgeRecord[] {
		if (!isKnowledgeScope(scope)) throw new TypeError("Invalid knowledge scope");
		const limit = options.limit ?? 20;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_KNOWLEDGE_PAGE_SIZE)
			throw new RangeError("Invalid knowledge page size");
		if (options.after !== undefined) requireId(options.after);
		if (options.reach !== undefined && options.reach !== "global" && options.reach !== "project")
			throw new TypeError("Invalid knowledge reach");
		if ((options.query?.length ?? 0) > 1_000) throw new RangeError("Knowledge query is too long");
		const words = terms(options.query ?? "");
		if (words.length > MAX_QUERY_TERMS)
			throw new RangeError("Knowledge query has too many terms; narrow it to eight terms");
		const search = words.length
			? `JOIN terms t ON t.id=e.id WHERE t.term IN (${words.map(() => "?").join(",")}) AND`
			: "WHERE";
		const records = this.db
			.prepare(`
			SELECT e.id,e.revision,e.body FROM entries e ${search}
			e.audience=? AND e.project IN('',?) AND e.role IN('',?) AND e.body IS NOT NULL
			AND e.id>? ${options.kind === undefined ? "" : "AND e.kind=?"}
			${options.reach === undefined ? "" : options.reach === "global" ? "AND e.project=''" : "AND e.project<>''"}
			GROUP BY e.id ${words.length ? "HAVING count(DISTINCT t.term)=?" : ""}
			ORDER BY e.id LIMIT ?
		`)
			.all(
				...words,
				scope.audience,
				scope.project,
				scope.role,
				options.after ?? "",
				...(options.kind === undefined ? [] : [options.kind]),
				...(words.length ? [words.length] : []),
				limit,
			)
			.map(decode);
		if (
			records.some(
				(record) =>
					!knowledgeAppliesTo(record.scope, scope) ||
					(options.kind !== undefined && record.kind !== options.kind) ||
					(options.reach !== undefined && (record.scope.project === "") !== (options.reach === "global")),
			)
		) {
			throw new Error("Knowledge scope index does not match its records");
		}
		return records;
	}

	resolve(scope: KnowledgeScope, prefix: string): KnowledgeRecord[] {
		if (!isKnowledgeScope(scope)) throw new TypeError("Invalid knowledge scope");
		if (!/^[a-f0-9]{8,64}$/.test(prefix)) throw new TypeError("Invalid knowledge identity prefix");
		// Hex identities sort below "g", so this range is exactly the identities that start with the prefix.
		const records = this.db
			.prepare(`SELECT id,revision,body FROM entries WHERE id>=? AND id<? AND body IS NOT NULL
			AND audience=? AND project IN('',?) AND role IN('',?) ORDER BY id LIMIT 2`)
			.all(prefix, `${prefix}g`, scope.audience, scope.project, scope.role)
			.map(decode);
		if (records.some((record) => !record.id.startsWith(prefix) || !knowledgeAppliesTo(record.scope, scope)))
			throw new Error("Knowledge identity index does not match its records");
		return records;
	}

	history(id: string, beforeRevision = Number.MAX_SAFE_INTEGER): KnowledgeRecord[] {
		requireId(id);
		requireVersion(beforeRevision);
		return this.db
			.prepare("SELECT id,revision,body FROM versions WHERE id=? AND revision<? ORDER BY revision DESC LIMIT ?")
			.all(id, beforeRevision, MAX_KNOWLEDGE_PAGE_SIZE)
			.map(decode);
	}

	isSourceForgotten(id: string, sessionId: string, sourceId: string): boolean {
		requireId(id);
		return (
			this.db
				.prepare("SELECT 1 FROM forgotten_sources WHERE id=? AND session=? AND source=?")
				.get(id, sessionId, sourceId) !== undefined
		);
	}

	put(
		input: KnowledgeRecord,
		expectedRevision: number,
		assertCurrent: () => void,
		signal?: AbortSignal,
		operation?: KnowledgeOperation,
	): KnowledgeMutationReceipt {
		const record = parseKnowledgeRecord(input);
		requireVersion(expectedRevision);
		if (record.revision !== expectedRevision + 1) throw new Error("Knowledge revision must advance exactly once");
		return this.mutate(assertCurrent, signal, operation, (admission) => {
			if (this.version(record.id) !== expectedRevision) throw new Error("Knowledge changed before commit");
			const previous = this.get(record.id);
			const fence = this.db.prepare("SELECT evidence_after FROM entries WHERE id=?").get(record.id)?.evidence_after;
			if (fence !== undefined && !isKnowledgeTimestamp(fence)) throw new Error("Invalid knowledge evidence barrier");
			if (fence !== undefined && record.citations.some((citation) => citation.at <= fence))
				throw new Error("Knowledge evidence is not newer than the accepted value");
			if (expectedRevision > 0 && previous === undefined && record.basis !== "explicit")
				throw new Error("Relearning forgotten knowledge requires new explicit owner evidence");
			if (previous?.basis === "explicit" && record.basis !== "explicit")
				throw new Error("Inferred knowledge cannot replace an explicit fact");
			if (
				record.citations.some((citation) =>
					this.isSourceForgotten(record.id, citation.sessionId, citation.sourceId),
				)
			) {
				throw new Error("Forgotten evidence cannot be learned again");
			}
			requireVersion(this.revision() + 1);
			const body = JSON.stringify(record);
			admission.begin();
			this.db
				.prepare(
					`INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body,evidence_after=excluded.evidence_after,identity=excluded.identity`,
				)
				.run(
					record.id,
					record.revision,
					record.kind,
					record.scope.project,
					record.scope.role,
					record.scope.audience,
					body,
					record.lastEvidencedAt,
					JSON.stringify([record.subject, record.key]),
				);
			this.db.prepare("INSERT INTO versions VALUES(?,?,?)").run(record.id, record.revision, body);
			this.db.prepare("DELETE FROM terms WHERE id=?").run(record.id);
			const addTerm = this.db.prepare("INSERT INTO terms VALUES(?,?)");
			for (const term of terms(`${record.subject} ${record.key} ${record.text}`)) addTerm.run(term, record.id);
			const addSource = this.db.prepare("INSERT OR IGNORE INTO sources VALUES(?,?,?)");
			for (const citation of record.citations) addSource.run(record.id, citation.sessionId, citation.sourceId);
			this.db.prepare("UPDATE meta SET revision=revision+1 WHERE id=1").run();
			return this.recordOperation({ action: "remember", id: record.id, revision: record.revision }, operation);
		});
	}

	forget(
		id: string,
		expectedRevision: number,
		citations: readonly KnowledgeCitation[],
		assertCurrent: () => void,
		signal?: AbortSignal,
		operation?: KnowledgeOperation,
	): KnowledgeMutationReceipt {
		requireId(id);
		requireVersion(expectedRevision);
		if (citations.length < 1 || citations.length > MAX_KNOWLEDGE_CITATIONS || !citations.every(isKnowledgeCitation))
			throw new TypeError("Forgetting requires bounded original owner evidence");
		return this.mutate(assertCurrent, signal, operation, (admission) => {
			if (expectedRevision === 0 || this.version(id) !== expectedRevision || !this.get(id))
				throw new Error("Knowledge changed before forgetting");
			requireVersion(expectedRevision + 1);
			requireVersion(this.revision() + 1);
			const current = this.get(id)!;
			if (citations.some((citation) => citation.at <= current.lastEvidencedAt))
				throw new Error("The request to forget is older than the current knowledge");
			const now = new Date().toISOString();
			const barrier = [now, current.lastEvidencedAt, ...citations.map((citation) => citation.at)].sort().at(-1)!;
			admission.begin();
			this.db
				.prepare("INSERT OR IGNORE INTO forgotten_sources SELECT id,session,source FROM sources WHERE id=?")
				.run(id);
			for (const citation of citations)
				this.db
					.prepare("INSERT OR IGNORE INTO forgotten_sources VALUES(?,?,?)")
					.run(id, citation.sessionId, citation.sourceId);
			this.db
				.prepare("UPDATE entries SET revision=revision+1,body=NULL,evidence_after=?,identity=NULL WHERE id=?")
				.run(barrier, id);
			// Evidence the owner gave before asking to forget never teaches knowledge again, under any wording.
			const requested = citations.map((citation) => citation.at).sort()[0]!;
			this.db.prepare("UPDATE meta SET forget_fence=max(coalesce(forget_fence,''),?) WHERE id=1").run(requested);
			this.db.prepare("DELETE FROM versions WHERE id=?").run(id);
			this.db.prepare("DELETE FROM terms WHERE id=?").run(id);
			this.db.prepare("DELETE FROM sources WHERE id=?").run(id);
			this.db.prepare("UPDATE meta SET revision=revision+1 WHERE id=1").run();
			const receipt = this.recordOperation({ action: "forget", id, revision: expectedRevision + 1 }, operation);
			this.collection.discardPendingValues(barrier);
			return receipt;
		});
	}

	close(): void {
		if (this.closed) return;
		this.db[Symbol.dispose]();
		this.closed = true;
	}
}
