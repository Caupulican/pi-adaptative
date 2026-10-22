import { existsSync } from "node:fs";
import { constructSqliteDatabase, type SqliteDatabase, type SqliteStatement } from "../context/sqlite-database.ts";
import { hasOnlyKeys, isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";
import { ContinuousChatCorruptError } from "./continuous-chat-index.ts";
import type { LegacyQueueEntry, LegacyQueueHeader } from "./continuous-chat-queue-import.ts";
import {
	continuousChatNodeFirstMessage,
	continuousChatNodeMessageCount,
	parseContinuousChatNodeCoordinate,
} from "./continuous-chat-tree.ts";
import {
	CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS,
	CONTINUOUS_CHAT_MAX_FAILURE_REASON_CHARACTERS,
	CONTINUOUS_CHAT_MAX_LEAF_STREAK,
	type ContinuousChatWorkAbandonment,
	type ContinuousChatWorkItem,
} from "./continuous-chat-work-queue.ts";

export interface ContinuousChatClaim extends ContinuousChatWorkItem {
	claimId: number;
}

interface SchedulerMeta {
	revision: number;
	generation: number;
	totalMessages: number;
	nextLeaf: number;
	sequence: number;
	leafStreak: number;
	leafRetryNext: boolean;
	parentRetryNext: boolean;
	origin: "fresh" | "legacy-replay-v1";
	sourceDigest: string;
}

export interface ContinuousChatSchedulerSnapshot extends SchedulerMeta {
	running: ContinuousChatClaim[];
	builtLeafPrefix: number;
}

interface WorkRow {
	level: number;
	ordinal: number;
	status: "ready" | "running" | "blocked";
	sequence: number;
	claimId: number;
	attempts: number;
	retryAfter: number;
	reason: string | null;
	lastAction: "release" | "fail" | null;
}

function decodeWork(row: Record<string, unknown> | undefined): WorkRow | undefined {
	if (!row) return undefined;
	const coordinate = parseContinuousChatNodeCoordinate({ level: row.level, ordinal: row.ordinal });
	if (
		!coordinate ||
		row.kind !== (coordinate.level === 0 ? 0 : 1) ||
		!isNonNegativeSafeInteger(row.sequence) ||
		!isNonNegativeSafeInteger(row.claim_id) ||
		!isNonNegativeSafeInteger(row.attempts) ||
		typeof row.retry_after !== "number" ||
		!Number.isSafeInteger(row.retry_after) ||
		row.retry_after < -1 ||
		!["ready", "running", "blocked"].includes(String(row.status)) ||
		(row.reason !== null && typeof row.reason !== "string") ||
		(typeof row.reason === "string" &&
			(!row.reason || Array.from(row.reason).length > CONTINUOUS_CHAT_MAX_FAILURE_REASON_CHARACTERS)) ||
		(row.status === "running" && (row.claim_id === 0 || row.attempts === 0)) ||
		(row.status === "blocked" && (row.last_action !== "fail" || row.reason === null || row.retry_after < 0)) ||
		(row.last_action !== null && row.last_action !== "release" && row.last_action !== "fail")
	)
		throw new Error("Invalid ICM scheduler row");
	return {
		...coordinate,
		status: row.status as WorkRow["status"],
		sequence: row.sequence,
		claimId: row.claim_id,
		attempts: row.attempts,
		retryAfter: row.retry_after,
		reason: row.reason as string | null,
		lastAction: row.last_action as WorkRow["lastAction"],
	};
}

/** SQLite owns deferred work; ordinary queries are bounded independently of backlog size. */
export class ContinuousChatScheduler {
	private readonly db: SqliteDatabase;
	private readonly path: string;
	private readonly statements = new Map<string, SqliteStatement>();

	private constructor(db: SqliteDatabase, path: string) {
		this.db = db;
		this.path = path;
	}

	static open(path: string, create: boolean): ContinuousChatScheduler {
		if (!create && !existsSync(path))
			throw new ContinuousChatCorruptError(path, "Committed scheduler database is missing");
		return constructSqliteDatabase({ databasePath: path }, (db) => {
			db.exec(
				"PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE;",
			);
			const version = db.prepare("PRAGMA user_version").get()?.user_version;
			if ((!create && version !== 1) || (create && version !== 0 && version !== 1))
				throw new ContinuousChatCorruptError(path, "Unsupported ICM scheduler schema");
			if (create)
				db.exec(`
				CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL) STRICT;
				CREATE TABLE IF NOT EXISTS work (
				 level INTEGER NOT NULL, ordinal INTEGER NOT NULL, kind INTEGER NOT NULL CHECK(kind IN(0,1)),
				 status TEXT NOT NULL CHECK(status IN('ready','running','blocked')), sequence INTEGER NOT NULL,
				 claim_id INTEGER NOT NULL, attempts INTEGER NOT NULL, retry_after INTEGER NOT NULL,
				 reason TEXT, last_action TEXT CHECK(last_action IS NULL OR last_action IN('release','fail')),
				 PRIMARY KEY(level,ordinal), CHECK(level>=0 AND level<=52 AND ordinal>=0),
				 CHECK(sequence>=0 AND claim_id>=0 AND attempts>=0 AND retry_after>=-1), CHECK(reason IS NULL OR length(reason)<=512)
				) STRICT, WITHOUT ROWID;
				CREATE INDEX IF NOT EXISTS candidate ON work(kind,status,retry_after,sequence);
				CREATE INDEX IF NOT EXISTS fresh_candidate ON work(kind,status,attempts,sequence);
				CREATE INDEX IF NOT EXISTS active_claim ON work(status,sequence);
				CREATE INDEX IF NOT EXISTS ready_retry ON work(kind,sequence) WHERE status='ready' AND attempts>0;
				CREATE TABLE IF NOT EXISTS legacy_half (level INTEGER NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY(level,ordinal)) STRICT, WITHOUT ROWID;
				PRAGMA user_version=1;
			`);
			return new ContinuousChatScheduler(db, path);
		});
	}

	close(): void {
		this.db[Symbol.dispose]();
	}
	prepareMigrationMove(): void {
		if (this.db.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete")
			throw new Error("Cannot checkpoint provisional scheduler");
	}
	private sql(sql: string): SqliteStatement {
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.db.prepare(sql);
			this.statements.set(sql, statement);
		}
		return statement;
	}
	private transaction<T>(run: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = run();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.db.isTransaction) {
				try {
					this.db.exec("ROLLBACK");
				} catch (rollback) {
					throw new AggregateError([error, rollback], "ICM scheduler transaction and rollback failed");
				}
			}
			throw error;
		}
	}
	private meta(): SchedulerMeta {
		const body = this.sql("SELECT body FROM meta WHERE id=1").get()?.body;
		if (typeof body !== "string") throw new ContinuousChatCorruptError(this.path, "ICM scheduler is not initialized");
		const value: unknown = JSON.parse(body);
		if (
			!isPlainRecord(value) ||
			!hasOnlyKeys(value, [
				"revision",
				"generation",
				"totalMessages",
				"nextLeaf",
				"sequence",
				"leafStreak",
				"leafRetryNext",
				"parentRetryNext",
				"origin",
				"sourceDigest",
			]) ||
			!["revision", "generation", "totalMessages", "nextLeaf", "sequence", "leafStreak"].every((key) =>
				isNonNegativeSafeInteger(value[key]),
			) ||
			typeof value.leafRetryNext !== "boolean" ||
			typeof value.parentRetryNext !== "boolean" ||
			(value.origin !== "fresh" && value.origin !== "legacy-replay-v1") ||
			typeof value.sourceDigest !== "string" ||
			!/^(fresh|[a-f0-9]{64})$/.test(value.sourceDigest) ||
			(value.nextLeaf as number) > (value.totalMessages as number) ||
			(value.leafStreak as number) > CONTINUOUS_CHAT_MAX_LEAF_STREAK
		)
			throw new ContinuousChatCorruptError(this.path, "Invalid scheduler metadata");
		return value as unknown as SchedulerMeta;
	}
	private save(meta: SchedulerMeta): void {
		if (![meta.revision, meta.generation, meta.sequence].every(isNonNegativeSafeInteger))
			throw new RangeError("ICM scheduler counters overflowed");
		this.sql("INSERT INTO meta(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(
			JSON.stringify(meta),
		);
	}
	private row(item: ContinuousChatWorkItem): WorkRow | undefined {
		return decodeWork(this.sql("SELECT * FROM work WHERE level=? AND ordinal=?").get(item.level, item.ordinal));
	}
	private insert(item: ContinuousChatWorkItem, sequence: number): void {
		this.sql(
			"INSERT INTO work(level,ordinal,kind,status,sequence,claim_id,attempts,retry_after,reason,last_action) VALUES(?,?,?,'ready',?,0,0,-1,NULL,NULL) ON CONFLICT(level,ordinal) DO NOTHING",
		).run(item.level, item.ordinal, item.level === 0 ? 0 : 1, sequence);
	}

	/** Only an unpublished database may be reset; caller holds legacy authority until finishImport commits. */
	beginImport(): void {
		this.transaction(() => {
			this.db.exec("DELETE FROM work; DELETE FROM legacy_half; DELETE FROM meta;");
		});
	}
	importBatch(entries: readonly LegacyQueueEntry[], firstSequence: number): void {
		this.transaction(() => {
			for (const [index, entry] of entries.entries()) {
				if (entry.list === "halfBuilt") {
					this.sql("INSERT INTO legacy_half VALUES(?,?)").run(entry.item.level, entry.item.ordinal);
					continue;
				}
				this.sql("INSERT INTO work VALUES(?,?,?,?,?,?,?,?,?,?)").run(
					entry.item.level,
					entry.item.ordinal,
					entry.item.level === 0 ? 0 : 1,
					entry.list === "blocked" ? "blocked" : "ready",
					firstSequence + index,
					0,
					entry.list === "blocked" || entry.list === "running" ? 1 : 0,
					entry.blocked?.retryAfterGeneration ?? -1,
					entry.blocked?.reason ?? null,
					entry.list === "blocked" ? "fail" : null,
				);
			}
		});
	}

	/** Migration scans pages only; no normal scheduler operation enumerates the backlog. */
	*importCoordinates(half: boolean): Generator<ContinuousChatWorkItem> {
		let level = -1,
			ordinal = -1;
		for (;;) {
			const rows = half
				? this.sql(
						"SELECT level,ordinal FROM legacy_half WHERE (level,ordinal)>(?,?) ORDER BY level,ordinal LIMIT 256",
					).all(level, ordinal)
				: this.sql(
						"SELECT level,ordinal FROM work WHERE (level,ordinal)>(?,?) ORDER BY level,ordinal LIMIT 256",
					).all(level, ordinal);
			if (!rows.length) return;
			for (const row of rows) {
				const item = parseContinuousChatNodeCoordinate(row);
				if (!item) throw new ContinuousChatCorruptError(this.path, "Invalid imported coordinate");
				level = item.level;
				ordinal = item.ordinal;
				yield item;
			}
		}
	}
	finishImport(header: LegacyQueueHeader, sequence: number, sourceDigest: string): void {
		const invalid =
			this.sql(`SELECT 1 FROM legacy_half h WHERE EXISTS(SELECT 1 FROM work w WHERE w.level=h.level AND w.ordinal=h.ordinal)
		 OR EXISTS(SELECT 1 FROM legacy_half s WHERE s.level=h.level AND s.ordinal=h.ordinal+CASE WHEN h.ordinal%2=0 THEN 1 ELSE -1 END)
		 OR EXISTS(SELECT 1 FROM work p WHERE p.level=h.level+1 AND p.ordinal=h.ordinal/2)
		 OR EXISTS(SELECT 1 FROM legacy_half p WHERE p.level=h.level+1 AND p.ordinal=h.ordinal/2) LIMIT 1`).get();
		if (invalid) throw new ContinuousChatCorruptError(this.path, "Contradictory legacy half-built ownership");
		if (
			this.sql(
				"SELECT 1 FROM work p JOIN work c ON c.level=p.level-1 AND c.ordinal IN(p.ordinal*2,p.ordinal*2+1) LIMIT 1",
			).get() ||
			this.sql(
				"SELECT 1 FROM work p JOIN legacy_half c ON c.level=p.level-1 AND c.ordinal IN(p.ordinal*2,p.ordinal*2+1) LIMIT 1",
			).get()
		)
			throw new ContinuousChatCorruptError(this.path, "Legacy parent overlaps its child");
		const leaves = this.sql("SELECT count(*) AS n FROM work WHERE level=0").get()?.n;
		if (
			typeof leaves !== "number" ||
			leaves > CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS ||
			(header.nextLeaf !== header.totalMessages && leaves !== CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS)
		)
			throw new ContinuousChatCorruptError(this.path, "Invalid legacy leaf window");
		if (this.sql("SELECT 1 FROM work WHERE status='blocked' AND retry_after<>? LIMIT 1").get(header.generation))
			throw new ContinuousChatCorruptError(this.path, "Invalid legacy failure generation");
		for (const half of [false, true])
			for (const item of this.importCoordinates(half))
				if (continuousChatNodeFirstMessage(item) + continuousChatNodeMessageCount(item.level) > header.nextLeaf)
					throw new ContinuousChatCorruptError(this.path, "Legacy work exceeds admitted messages");
		this.transaction(() => {
			this.save({ ...header, sequence, leafRetryNext: false, parentRetryNext: false, sourceDigest });
			this.db.exec("DELETE FROM legacy_half");
		});
	}
	initialize(totalMessages = 0): void {
		this.transaction(() =>
			this.save({
				revision: 0,
				generation: 0,
				totalMessages,
				nextLeaf: totalMessages,
				sequence: 0,
				leafStreak: 0,
				leafRetryNext: false,
				parentRetryNext: false,
				origin: totalMessages === 0 ? "fresh" : "legacy-replay-v1",
				sourceDigest: "fresh",
			}),
		);
	}
	enqueue(items: readonly ContinuousChatWorkItem[]): void {
		this.transaction(() => {
			const meta = this.meta();
			for (const item of items) this.insert(item, ++meta.sequence);
			meta.revision++;
			this.save(meta);
		});
	}

	snapshot(): ContinuousChatSchedulerSnapshot {
		const meta = this.meta();
		const running = this.sql("SELECT * FROM work WHERE status='running' ORDER BY sequence LIMIT 9")
			.all()
			.map((row) => {
				const work = decodeWork(row)!;
				return { level: work.level, ordinal: work.ordinal, claimId: work.claimId };
			});
		if (running.length > CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS)
			throw new ContinuousChatCorruptError(this.path, "Too many active scheduler claims");
		const minimum = this.sql("SELECT ordinal FROM work WHERE level=0 ORDER BY ordinal LIMIT 1").get()?.ordinal;
		if (minimum !== undefined && !isNonNegativeSafeInteger(minimum))
			throw new ContinuousChatCorruptError(this.path, "Invalid pending leaf");
		return { ...meta, running, builtLeafPrefix: Math.min(meta.nextLeaf, minimum ?? meta.nextLeaf) };
	}
	arrival(totalMessages?: number): void {
		this.transaction(() => {
			const meta = this.meta();
			const count = totalMessages ?? meta.totalMessages;
			if (!isNonNegativeSafeInteger(count) || count < meta.totalMessages)
				throw new RangeError("Message count must not decrease");
			if (totalMessages !== undefined && count === meta.totalMessages) return;
			meta.generation += totalMessages === undefined ? 1 : count - meta.totalMessages;
			meta.totalMessages = count;
			meta.revision++;
			this.save(meta);
		});
	}
	private candidate(kind: number, retry: boolean, generation: number): WorkRow | undefined {
		if (!retry)
			return decodeWork(
				this.sql("SELECT * FROM work WHERE kind=? AND status='ready' AND attempts=0 ORDER BY sequence LIMIT 1").get(
					kind,
				),
			);
		return (
			decodeWork(
				this.sql(
					"SELECT * FROM work INDEXED BY ready_retry WHERE kind=? AND status='ready' AND attempts>0 ORDER BY sequence LIMIT 1",
				).get(kind),
			) ??
			decodeWork(
				this.sql(
					"SELECT * FROM work WHERE kind=? AND status='blocked' AND retry_after<? ORDER BY retry_after,sequence LIMIT 1",
				).get(kind, generation),
			)
		);
	}
	claim(): ContinuousChatClaim | undefined {
		return this.transaction(() => {
			const snapshot = this.snapshot();
			const { running: _running, builtLeafPrefix: _built, ...meta } = snapshot;
			if (snapshot.running.length >= CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS) return undefined;
			const oldLeaf = this.candidate(0, true, meta.generation);
			const readyLeaf = this.candidate(0, false, meta.generation);
			const freshLeaf = readyLeaf !== undefined || meta.nextLeaf < meta.totalMessages;
			const newParent = this.candidate(1, false, meta.generation),
				oldParent = this.candidate(1, true, meta.generation);
			const parent = meta.parentRetryNext ? (oldParent ?? newParent) : (newParent ?? oldParent);
			const chooseParent =
				parent !== undefined && ((!oldLeaf && !freshLeaf) || meta.leafStreak >= CONTINUOUS_CHAT_MAX_LEAF_STREAK);
			let selected: ContinuousChatWorkItem;
			let row: WorkRow | undefined;
			if (chooseParent) {
				row = parent;
				selected = parent;
				meta.parentRetryNext = parent === newParent;
				meta.leafStreak = 0;
			} else if (oldLeaf && (!freshLeaf || meta.leafRetryNext)) {
				row = oldLeaf;
				selected = oldLeaf;
				meta.leafRetryNext = false;
				meta.leafStreak = parent ? meta.leafStreak + 1 : 0;
			} else if (freshLeaf) {
				if (readyLeaf) {
					selected = readyLeaf;
					row = readyLeaf;
				} else {
					selected = { level: 0, ordinal: meta.nextLeaf++ };
					if (this.row(selected))
						throw new ContinuousChatCorruptError(this.path, "Unadmitted leaf already has work");
					this.insert(selected, ++meta.sequence);
					row = this.row(selected);
				}
				meta.leafRetryNext = true;
				meta.leafStreak = parent ? meta.leafStreak + 1 : 0;
			} else if (parent) {
				row = parent;
				selected = parent;
				meta.parentRetryNext = parent === newParent;
				meta.leafStreak = 0;
			} else return undefined;
			if (continuousChatNodeFirstMessage(selected) + continuousChatNodeMessageCount(selected.level) > meta.nextLeaf)
				throw new ContinuousChatCorruptError(this.path, "Claim exceeds admitted messages");
			const claimId = ++meta.revision;
			this.sql(
				"UPDATE work SET status='running',claim_id=?,attempts=?,last_action=NULL WHERE level=? AND ordinal=?",
			).run(claimId, (row?.attempts ?? 0) + 1, selected.level, selected.ordinal);
			this.save(meta);
			return { level: selected.level, ordinal: selected.ordinal, claimId };
		});
	}
	abandon(claim: ContinuousChatClaim, action: ContinuousChatWorkAbandonment): void {
		const reason =
			action.kind === "fail"
				? Array.from(action.reason).slice(0, CONTINUOUS_CHAT_MAX_FAILURE_REASON_CHARACTERS).join("")
				: null;
		if (reason === "") throw new RangeError("Failure needs a reason");
		this.transaction(() => {
			const meta = this.meta(),
				row = this.row(claim);
			if (!row || row.claimId !== claim.claimId) throw new Error("ICM work claim was superseded");
			if (row.status !== "running" && (row.lastAction !== action.kind || row.reason !== reason))
				throw new Error("ICM work disposition does not match retry");
			if (row.status === "running")
				this.sql(
					"UPDATE work SET status=?,sequence=?,retry_after=?,reason=?,last_action=? WHERE level=? AND ordinal=?",
				).run(
					action.kind === "fail" ? "blocked" : "ready",
					++meta.sequence,
					action.kind === "fail" ? meta.generation : -1,
					reason,
					action.kind,
					claim.level,
					claim.ordinal,
				);
			meta.revision++;
			this.save(meta);
		});
	}
	complete(item: ContinuousChatWorkItem, parent?: ContinuousChatWorkItem): void {
		this.transaction(() => {
			const meta = this.meta();
			this.sql("DELETE FROM work WHERE level=? AND ordinal=?").run(item.level, item.ordinal);
			if (parent) this.insert(parent, ++meta.sequence);
			meta.revision++;
			this.save(meta);
		});
	}
	recover(): void {
		this.transaction(() => {
			const meta = this.meta();
			this.sql(
				"UPDATE work SET status='ready',retry_after=-1,last_action='release',reason=NULL WHERE status='running'",
			).run();
			meta.revision++;
			this.save(meta);
		});
	}
}
