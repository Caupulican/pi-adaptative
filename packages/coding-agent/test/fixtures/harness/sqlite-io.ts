import { constants, type DatabaseSync, type SQLOutputValue } from "node:sqlite";

interface SqliteFiles {
	path(value: unknown): string;
	existsSync(path: string): boolean;
	writeFileSync(path: string, data: string): void;
	statSync(path: string): { ino: number | bigint };
}

interface Backing {
	database: DatabaseSync;
	identity: number | bigint;
	readOnly: boolean;
	transactionOwner?: Handle;
	readonly handles: Set<Handle>;
	/** The journal mode a real file database would report; the RAM engine can only answer `memory`. */
	journalMode: string;
}

interface Handle {
	path: string;
	open: boolean;
	readOnly: boolean;
}

export type SqliteFaultOperation = "exec" | "prepare" | "run";

/**
 * The native result a scripted SQLite fault reports. Absent, the failure is a plain scripted error naming its operation and SQL.
 * `busy` and `locked` throw what node:sqlite throws for SQLITE_BUSY (5) and SQLITE_LOCKED (6): `code` ERR_SQLITE_ERROR, the
 * result code in `errcode`, and SQLite's own text as `errstr` and message. The RAM backing never contends, so this is the only
 * way a journey reaches a busy or locked database.
 */
export type SqliteFaultResult = "busy" | "locked";

const NATIVE_RESULTS: Readonly<Record<SqliteFaultResult, { readonly errcode: number; readonly errstr: string }>> = {
	busy: { errcode: 5, errstr: "database is locked" },
	locked: { errcode: 6, errstr: "database table is locked" },
};

interface SqliteFault {
	readonly operation: SqliteFaultOperation;
	readonly sql: string;
	readonly result?: SqliteFaultResult;
	/** Present on a persistent fault: it stays armed until cleared and counts what it refused. */
	readonly denial?: { readonly name: string; hits: number; cleared: boolean };
}

/** A persistent SQLite fault: every matching operation fails until the scenario clears it. Close fails if it is never cleared or never hit. */
export interface SqliteDenial {
	readonly name: string;
	/** Operations refused so far. */
	readonly hits: number;
	/** Restores the operation; returns the number of refused operations. */
	clear(): number;
}

/** One backing's committed schema and rows: what {@link VirtualSqlite.rewind} restores. */
interface BackingImage {
	readonly userVersion: number;
	/** Every schema object with SQL of its own, in creation order (internal `sqlite_` objects and automatic indexes excluded). */
	readonly objects: readonly { readonly type: string; readonly name: string; readonly sql: string }[];
	/** Each table's rows, `sqlite_sequence` included when present; integers are read as bigints, so every value is exact. */
	readonly rows: ReadonlyMap<string, readonly Record<string, SQLOutputValue>[]>;
}

/** The committed state of every RAM backing at one point, by file identity: the durable point a crash cut rewinds SQLite to. */
export interface VirtualSqliteSnapshot {
	readonly images: ReadonlyMap<number | bigint, BackingImage>;
}

function quoted(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function scriptedFailure(fault: SqliteFault): Error {
	if (fault.result === undefined) return new Error(`Scripted SQLite ${fault.operation} failure: ${fault.sql}`);
	const native = NATIVE_RESULTS[fault.result];
	return Object.assign(new Error(native.errstr), { code: "ERR_SQLITE_ERROR", ...native });
}

function imageOf(database: DatabaseSync): BackingImage {
	const userVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
	const objects = database
		.prepare(
			"SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
		)
		.all()
		.map((row) => ({ type: String(row.type), name: String(row.name), sql: String(row.sql) }));
	const tables = objects.filter((object) => object.type === "table").map((object) => object.name);
	if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get() !== undefined)
		tables.push("sqlite_sequence");
	const rows = new Map<string, readonly Record<string, SQLOutputValue>[]>();
	for (const table of tables) {
		const statement = database.prepare(`SELECT * FROM ${quoted(table)}`);
		statement.setReadBigInts(true);
		rows.set(table, statement.all());
	}
	return { userVersion, objects, rows };
}

function insertRows(database: DatabaseSync, table: string, rows: readonly Record<string, SQLOutputValue>[]): void {
	const first = rows[0];
	if (first === undefined) return;
	const columns = Object.keys(first);
	const insert = database.prepare(
		`INSERT INTO ${quoted(table)} (${columns.map(quoted).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
	);
	for (const row of rows) insert.run(...columns.map((column) => row[column] ?? null));
}

/**
 * Replaces every schema object and row of `database` with `image` in one transaction: what the database holds is exactly what it
 * held when the image was taken. Foreign keys are off while the tables are rebuilt and restored afterwards.
 */
function restoreImage(database: DatabaseSync, image: BackingImage): void {
	const foreignKeys = Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys ?? 0);
	database.exec("PRAGMA foreign_keys = OFF");
	try {
		database.exec("BEGIN");
		try {
			const current = database
				.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
				.all()
				.map((row) => ({ type: String(row.type), name: String(row.name) }));
			for (const type of ["view", "trigger", "index", "table"]) {
				for (const object of current.filter((candidate) => candidate.type === type))
					database.exec(`DROP ${type.toUpperCase()} IF EXISTS ${quoted(object.name)}`);
			}
			const tables = image.objects.filter((object) => object.type === "table");
			for (const object of tables) database.exec(object.sql);
			for (const object of tables) insertRows(database, object.name, image.rows.get(object.name) ?? []);
			// Explicit ids advance the sequence of each AUTOINCREMENT table; the image's own counters replace them.
			if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").get() !== undefined) {
				database.exec("DELETE FROM sqlite_sequence");
				insertRows(database, "sqlite_sequence", image.rows.get("sqlite_sequence") ?? []);
			}
			for (const object of image.objects.filter((candidate) => candidate.type !== "table"))
				database.exec(object.sql);
			database.exec(`PRAGMA user_version = ${image.userVersion}`);
			database.exec("COMMIT");
		} catch (error) {
			if (database.isTransaction) database.exec("ROLLBACK");
			throw error;
		}
	} finally {
		database.exec(`PRAGMA foreign_keys = ${foreignKeys === 0 ? "OFF" : "ON"}`);
	}
}

const EMPTY_IMAGE: BackingImage = { userVersion: 0, objects: [], rows: new Map() };

const WRITE_ACTIONS = new Set(
	Object.entries(constants)
		.filter(([name]) => /^SQLITE_(?:CREATE_|DROP_|INSERT$|UPDATE$|DELETE$|ALTER_TABLE$)/.test(name))
		.map(([, code]) => code),
);

/**
 * Pragmas that only read the schema (their argument names a table or index). They set no connection state, so running
 * one while another handle shares the same RAM backing is what concurrent connections to one real file do.
 */
const SCHEMA_INTROSPECTION_PRAGMAS: ReadonlySet<string> = new Set([
	"table_info",
	"table_xinfo",
	"index_list",
	"index_info",
	"index_xinfo",
	"foreign_key_list",
]);

const JOURNAL_MODES: ReadonlySet<string> = new Set(["delete", "truncate", "persist", "memory", "wal", "off"]);
const JOURNAL_MODE_PRAGMA = /^\s*PRAGMA\s+journal_mode\s*(?:=\s*([A-Za-z]+))?\s*;?\s*$/i;
const JOURNAL_MODE_ASSIGNMENTS = /PRAGMA\s+journal_mode\s*=\s*([A-Za-z]+)/gi;

/** A file database accepts any journal mode a pragma names; an unknown name leaves the mode unchanged, as SQLite does. */
function applyJournalMode(backing: Backing, requested: string): void {
	const mode = requested.toLowerCase();
	if (JOURNAL_MODES.has(mode)) backing.journalMode = mode;
}

/** Logical file identities persist in the virtual tree; their native SQL backing remains entirely in RAM. */
export class VirtualSqlite {
	private readonly files: SqliteFiles;
	private readonly reject: (kind: string) => never;
	private readonly backings = new Map<number | bigint, Backing>();
	private readonly databases = new Set<DatabaseSync>();
	private readonly handles = new Set<Handle>();
	private readonly faults: SqliteFault[] = [];
	/** Persistent faults by name, kept after clearing so the close can check each was hit. */
	private readonly denials = new Map<string, NonNullable<SqliteFault["denial"]>>();
	private active = true;

	constructor(files: SqliteFiles, reject: (kind: string) => never) {
		this.files = files;
		this.reject = reject;
	}

	open(databaseConstructor: typeof DatabaseSync, arguments_: readonly unknown[]): object {
		if (!this.active) return this.reject("sqlite.after_dispose");
		const memoryOnly = arguments_[0] === ":memory:";
		const path = memoryOnly ? ":memory:" : this.files.path(arguments_[0]);
		const options = arguments_[1] as { readOnly?: boolean; open?: boolean } | undefined;
		if (options?.open === false) return this.reject("sqlite.deferred_open");
		const handle: Handle = { path, open: true, readOnly: options?.readOnly === true };
		if (!memoryOnly && !this.files.existsSync(path)) {
			if (handle.readOnly) throw new Error(`Unable to open read-only virtual SQLite database: ${path}`);
			this.files.writeFileSync(path, "");
		}
		const identity = memoryOnly ? undefined : this.files.statSync(path).ino;
		let backing = identity === undefined ? undefined : this.backings.get(identity);
		if (backing?.database.isTransaction) return this.reject("sqlite.concurrent_transaction");
		if (!backing) {
			const database = Reflect.construct(databaseConstructor, [
				":memory:",
				{ ...(options ?? {}), open: true, readOnly: false, allowExtension: false },
			]) as DatabaseSync;
			this.databases.add(database);
			if (typeof database.setAuthorizer !== "function") throw new Error("RAM SQLite requires native setAuthorizer");
			database.enableLoadExtension(false);
			database.exec("PRAGMA temp_store = MEMORY");
			backing = { database, identity: identity ?? 0, readOnly: false, handles: new Set(), journalMode: "delete" };
			const authorized = backing;
			database.setAuthorizer((action, first, second) => {
				const name = first?.toLowerCase();
				if (action === constants.SQLITE_FUNCTION && second?.toLowerCase() === "load_extension") {
					try {
						this.reject("sqlite.load_extension");
					} catch {
						return constants.SQLITE_DENY;
					}
				}
				const diskAttach = action === constants.SQLITE_ATTACH && first !== ":memory:";
				const storagePragma =
					action === constants.SQLITE_PRAGMA &&
					second !== null &&
					(name === "temp_store_directory" ||
						(name === "temp_store" && !["2", "memory"].includes(second.toLowerCase())));
				if (diskAttach || storagePragma) {
					// Throwing from the authorizer prevents native execution and records the precise denied boundary.
					try {
						this.reject(`sqlite.${diskAttach ? "attach" : "storage_pragma"}`);
					} catch {
						return constants.SQLITE_DENY;
					}
				}
				if (
					authorized.readOnly &&
					action === constants.SQLITE_PRAGMA &&
					second !== null &&
					!["busy_timeout", "temp_store"].includes(name ?? "")
				) {
					// Read-only consumers may tune supported connection settings, never mutate persistent metadata.
					try {
						this.reject("sqlite.readonly_pragma");
					} catch {
						return constants.SQLITE_DENY;
					}
				}
				if (
					action === constants.SQLITE_PRAGMA &&
					second !== null &&
					[...authorized.handles].filter((lease) => lease.open).length > 1 &&
					!["busy_timeout", "journal_mode"].includes(name ?? "") &&
					!SCHEMA_INTROSPECTION_PRAGMAS.has(name ?? "")
				) {
					try {
						this.reject("sqlite.concurrent_connection_pragma");
					} catch {
						return constants.SQLITE_DENY;
					}
				}
				return authorized.readOnly && WRITE_ACTIONS.has(action) ? constants.SQLITE_DENY : constants.SQLITE_OK;
			});
			if (identity !== undefined) this.backings.set(identity, backing);
		}
		this.handles.add(handle);
		backing.handles.add(handle);
		const current = backing;
		const check = () => {
			if (!this.active) return this.reject("sqlite.after_dispose");
			if (!handle.open) throw new Error("database is not open");
		};
		const invoke = (target: object, key: PropertyKey, args: unknown[]): unknown => {
			check();
			if (current.database.isTransaction && current.transactionOwner !== handle) {
				return this.reject("sqlite.concurrent_transaction");
			}
			const sql = key === "run" ? Reflect.get(target, "sourceSQL", target) : args[0];
			const faultIndex = this.faults.findIndex(
				(fault) => fault.operation === key && typeof sql === "string" && sql.includes(fault.sql),
			);
			const fault = this.faults[faultIndex];
			if (fault !== undefined) {
				if (fault.denial === undefined) this.faults.splice(faultIndex, 1);
				else fault.denial.hits++;
				throw scriptedFailure(fault);
			}
			const method: unknown = Reflect.get(target, key, target);
			if (typeof method !== "function") throw new TypeError(`SQLite ${String(key)} is not callable`);
			const previous = current.readOnly;
			current.readOnly = handle.readOnly;
			try {
				return Reflect.apply(method, target, args);
			} finally {
				current.transactionOwner = current.database.isTransaction ? handle : undefined;
				current.readOnly = previous;
			}
		};
		const close = (idempotent: boolean) => {
			if (!this.active) return this.reject("sqlite.after_dispose");
			if (!idempotent) check();
			if (current.transactionOwner === handle && current.database.isTransaction) {
				current.database.exec("ROLLBACK");
				current.transactionOwner = undefined;
			}
			handle.open = false;
		};
		return new Proxy(current.database, {
			get: (database, key) => {
				if (key === "isOpen") return this.active && handle.open;
				if (key === "isTransaction") {
					check();
					return current.transactionOwner === handle && database.isTransaction;
				}
				if (key === Symbol.dispose || key === "close") return () => close(key === Symbol.dispose);
				if (key === "open") return () => this.reject("sqlite.reopen_handle");
				if (key === "prepare")
					return (...args: unknown[]) => {
						const statement = invoke(database, key, args) as object;
						const journalPragma = memoryOnly ? null : JOURNAL_MODE_PRAGMA.exec(String(args[0]));
						return new Proxy(statement, {
							get: (target, name) => {
								if (name === "db" || name === "constructor")
									return () => this.reject(`sqlite.statement.${String(name)}`);
								if (name === "iterate") return () => this.reject("sqlite.statement.iterate");
								const value: unknown = Reflect.get(target, name, target);
								if (typeof value !== "function") return value;
								return (...parameters: unknown[]) => {
									const result = invoke(target, name, parameters);
									if (!journalPragma || name !== "get" || typeof result !== "object" || result === null)
										return result;
									if (journalPragma[1] !== undefined) applyJournalMode(current, journalPragma[1]);
									return { ...result, journal_mode: current.journalMode };
								};
							},
						});
					};
				if (
					[
						"setAuthorizer",
						"enableLoadExtension",
						"loadExtension",
						"createTagStore",
						"createSession",
						"constructor",
					].includes(String(key))
				) {
					return () => this.reject(`sqlite.${String(key)}`);
				}
				const value: unknown = Reflect.get(database, key, database);
				if (typeof value !== "function") {
					check();
					return value;
				}
				return (...args: unknown[]) => {
					const result = invoke(database, key, args);
					if (key === "exec" && !memoryOnly)
						for (const [, mode] of String(args[0]).matchAll(JOURNAL_MODE_ASSIGNMENTS))
							applyJournalMode(current, mode!);
					return result;
				};
			},
		});
	}

	/** Open application handles, separately from the fixture-owned persistent RAM backing connections. */
	openHandles(): readonly string[] {
		return [...this.handles].filter((handle) => handle.open).map((handle) => handle.path);
	}

	failNext(operation: SqliteFaultOperation, sql: string, result?: SqliteFaultResult): void {
		if (!sql.trim()) throw new Error("SQLite failure requires a specific SQL witness");
		this.faults.push({ operation, sql, ...(result === undefined ? {} : { result }) });
	}

	/** Fails every matching operation until `clear()`; see {@link SqliteDenial}. */
	denyUntilCleared(fault: {
		readonly name: string;
		readonly operation: SqliteFaultOperation;
		readonly sql: string;
		readonly result?: SqliteFaultResult;
	}): SqliteDenial {
		if (!fault.sql.trim()) throw new Error("SQLite denial requires a specific SQL witness");
		if (this.denials.has(fault.name)) throw new Error(`SQLite denial ${fault.name} is already declared`);
		const denial = { name: fault.name, hits: 0, cleared: false };
		this.denials.set(fault.name, denial);
		const entry: SqliteFault = {
			operation: fault.operation,
			sql: fault.sql,
			...(fault.result === undefined ? {} : { result: fault.result }),
			denial,
		};
		this.faults.push(entry);
		return {
			name: fault.name,
			get hits() {
				return denial.hits;
			},
			clear: () => {
				const index = this.faults.indexOf(entry);
				if (index >= 0) this.faults.splice(index, 1);
				denial.cleared = true;
				return denial.hits;
			},
		};
	}

	assertFaultsConsumed(): void {
		const pending = this.faults.filter((fault) => fault.denial === undefined);
		const problems = pending.length ? [`Unused SQLite faults: ${JSON.stringify(pending)}`] : [];
		for (const [name, denial] of this.denials) {
			if (!denial.cleared) problems.push(`SQLite denial ${name} was never cleared`);
			else if (denial.hits === 0) problems.push(`SQLite denial ${name} refused no operation`);
		}
		if (problems.length) throw new Error(problems.join("; "));
	}

	/**
	 * The committed state of every backing now. A backing inside a transaction has no durable point to take, so the snapshot
	 * refuses it rather than record uncommitted rows the shared connection can see.
	 */
	snapshot(): VirtualSqliteSnapshot {
		if (!this.active) return this.reject("sqlite.after_dispose");
		const images = new Map<number | bigint, BackingImage>();
		for (const [identity, backing] of this.backings) {
			if (backing.database.isTransaction)
				throw new Error(`SQLite snapshot during an open transaction: ${[...backing.handles][0]?.path ?? identity}`);
			images.set(identity, imageOf(backing.database));
		}
		return { images };
	}

	/**
	 * Rewinds every backing to `snapshot`, as a crash returns each database file to its last durable point: a backing the snapshot
	 * holds is restored to it, one created after it is emptied. Only a cut owner can be rewound: an open application handle on a
	 * backing, or an open transaction, refuses the rewind before anything changes.
	 */
	rewind(snapshot: VirtualSqliteSnapshot): void {
		if (!this.active) this.reject("sqlite.after_dispose");
		for (const backing of this.backings.values()) {
			const open = [...backing.handles].filter((handle) => handle.open);
			if (open.length > 0 || backing.database.isTransaction)
				throw new Error(`SQLite rewind of a live backing: ${open.map((handle) => handle.path).join(", ")}`);
		}
		for (const [identity, backing] of this.backings)
			restoreImage(backing.database, snapshot.images.get(identity) ?? EMPTY_IMAGE);
	}

	dispose(): void {
		this.active = false;
		const failures: unknown[] = [];
		for (const database of this.databases) {
			try {
				if (database.isOpen) database.close();
			} catch (error) {
				failures.push(error);
			}
		}
		this.databases.clear();
		this.backings.clear();
		if (failures.length) throw new AggregateError(failures, "RAM SQLite backing cleanup failed");
	}
}
