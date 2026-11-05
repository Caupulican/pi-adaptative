/** SQLite adapter for the ICM knowledge collection, with paged reads and atomic mutation effects. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { knowledgeDatabaseFile } from "../agent-paths.ts";
import { constructSqliteDatabase, type SqliteDatabase, withSqliteTransaction } from "../context/sqlite-database.ts";
import {
	isKnowledgeScope,
	isKnowledgeTimestamp,
	KNOWLEDGE_KINDS,
	type KnowledgeKind,
	type KnowledgeRecord,
	type KnowledgeRecordSnapshot,
	type KnowledgeScope,
	type KnowledgeStorePort,
	knowledgeAppliesTo,
	MAX_KNOWLEDGE_PAGE_SIZE,
	parseKnowledgeRecord,
} from "./knowledge-record.ts";
import { MemoryMutationAdmission } from "./memory-mutation-admission.ts";

const SCHEMA_VERSION = 1;
const MAX_QUERY_TERMS = 8;

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
	private closed = false;

	private constructor(db: SqliteDatabase) {
		this.db = db;
	}

	static open(agentDir: string): KnowledgeStore {
		const databasePath = knowledgeDatabaseFile(agentDir);
		mkdirSync(dirname(databasePath), { recursive: true });
		return constructSqliteDatabase({ databasePath }, (db) => {
			db.exec(
				"PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;",
			);
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			if (version !== 0 && version !== SCHEMA_VERSION) throw new Error("Unsupported ICM knowledge schema");
			const store = new KnowledgeStore(db);
			if (version === 0)
				store.transaction(() => {
					const lockedVersion = db.prepare("PRAGMA user_version").get()?.user_version;
					if (lockedVersion === SCHEMA_VERSION) return;
					if (lockedVersion !== 0) throw new Error("ICM knowledge schema changed during initialization");
					db.exec(`
					CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0)) STRICT;
					INSERT INTO meta VALUES(1,0);
					CREATE TABLE entries (
					 id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), kind TEXT NOT NULL,
					 project TEXT NOT NULL, role TEXT NOT NULL, audience TEXT NOT NULL,
					 body TEXT CHECK(body IS NULL OR length(body)<=64000), evidence_after TEXT NOT NULL
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
					PRAGMA user_version=${SCHEMA_VERSION};
				`);
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

	/** Revision and all category pages describe one database snapshot, including concurrent writers. */
	snapshot(scope: KnowledgeScope): KnowledgeRecordSnapshot {
		return withSqliteTransaction(
			this.db,
			() => {
				const revision = this.revision();
				const records: KnowledgeRecord[] = [];
				const possiblyMore: KnowledgeKind[] = [];
				for (const kind of KNOWLEDGE_KINDS) {
					const page = this.list(scope, { kind, limit: MAX_KNOWLEDGE_PAGE_SIZE });
					records.push(...page);
					if (page.length === MAX_KNOWLEDGE_PAGE_SIZE) possiblyMore.push(kind);
				}
				return { revision, records, possiblyMore };
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

	list(
		scope: KnowledgeScope,
		options: { query?: string; kind?: KnowledgeKind; after?: string; limit?: number } = {},
	): KnowledgeRecord[] {
		if (!isKnowledgeScope(scope)) throw new TypeError("Invalid knowledge scope");
		const limit = options.limit ?? 20;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_KNOWLEDGE_PAGE_SIZE)
			throw new RangeError("Invalid knowledge page size");
		if (options.after !== undefined) requireId(options.after);
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
					!knowledgeAppliesTo(record.scope, scope) || (options.kind !== undefined && record.kind !== options.kind),
			)
		) {
			throw new Error("Knowledge scope index does not match its records");
		}
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

	put(input: KnowledgeRecord, expectedRevision: number, assertCurrent: () => void, signal?: AbortSignal): void {
		const record = parseKnowledgeRecord(input);
		requireVersion(expectedRevision);
		if (record.revision !== expectedRevision + 1) throw new Error("Knowledge revision must advance exactly once");
		const admission = new MemoryMutationAdmission(signal);
		this.transaction(() => {
			admission.assertPending();
			assertCurrent();
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
					`INSERT INTO entries VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body,evidence_after=excluded.evidence_after`,
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
				);
			this.db.prepare("INSERT INTO versions VALUES(?,?,?)").run(record.id, record.revision, body);
			this.db.prepare("DELETE FROM terms WHERE id=?").run(record.id);
			const addTerm = this.db.prepare("INSERT INTO terms VALUES(?,?)");
			for (const term of terms(`${record.subject} ${record.key} ${record.text}`)) addTerm.run(term, record.id);
			const addSource = this.db.prepare("INSERT OR IGNORE INTO sources VALUES(?,?,?)");
			for (const citation of record.citations) addSource.run(record.id, citation.sessionId, citation.sourceId);
			this.db.prepare("UPDATE meta SET revision=revision+1 WHERE id=1").run();
		});
	}

	forget(id: string, expectedRevision: number, assertCurrent: () => void, signal?: AbortSignal): void {
		requireId(id);
		requireVersion(expectedRevision);
		const admission = new MemoryMutationAdmission(signal);
		this.transaction(() => {
			admission.assertPending();
			assertCurrent();
			if (expectedRevision === 0 || this.version(id) !== expectedRevision || !this.get(id))
				throw new Error("Knowledge changed before forgetting");
			requireVersion(expectedRevision + 1);
			requireVersion(this.revision() + 1);
			const current = this.get(id)!;
			const now = new Date().toISOString();
			const barrier = now > current.lastEvidencedAt ? now : current.lastEvidencedAt;
			admission.begin();
			this.db
				.prepare("INSERT OR IGNORE INTO forgotten_sources SELECT id,session,source FROM sources WHERE id=?")
				.run(id);
			this.db
				.prepare("UPDATE entries SET revision=revision+1,body=NULL,evidence_after=? WHERE id=?")
				.run(barrier, id);
			this.db.prepare("DELETE FROM versions WHERE id=?").run(id);
			this.db.prepare("DELETE FROM terms WHERE id=?").run(id);
			this.db.prepare("DELETE FROM sources WHERE id=?").run(id);
			this.db.prepare("UPDATE meta SET revision=revision+1 WHERE id=1").run();
		});
	}

	close(): void {
		if (this.closed) return;
		this.db[Symbol.dispose]();
		this.closed = true;
	}
}
