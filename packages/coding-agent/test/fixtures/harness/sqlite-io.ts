import { constants, type DatabaseSync } from "node:sqlite";

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
}

interface Handle {
	path: string;
	open: boolean;
	readOnly: boolean;
}

export type SqliteFaultOperation = "exec" | "prepare" | "run";

const WRITE_ACTIONS = new Set(
	Object.entries(constants)
		.filter(([name]) => /^SQLITE_(?:CREATE_|DROP_|INSERT$|UPDATE$|DELETE$|ALTER_TABLE$)/.test(name))
		.map(([, code]) => code),
);

/** Logical file identities persist in the virtual tree; their native SQL backing remains entirely in RAM. */
export class VirtualSqlite {
	private readonly files: SqliteFiles;
	private readonly reject: (kind: string) => never;
	private readonly backings = new Map<number | bigint, Backing>();
	private readonly databases = new Set<DatabaseSync>();
	private readonly handles = new Set<Handle>();
	private readonly faults: Array<{ operation: SqliteFaultOperation; sql: string }> = [];
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
			backing = { database, identity: identity ?? 0, readOnly: false, handles: new Set() };
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
					!["busy_timeout", "journal_mode"].includes(name ?? "")
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
			if (faultIndex >= 0) {
				const fault = this.faults.splice(faultIndex, 1)[0];
				throw new Error(`Scripted SQLite ${fault.operation} failure: ${fault.sql}`);
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
						return new Proxy(statement, {
							get: (target, name) => {
								if (name === "db" || name === "constructor")
									return () => this.reject(`sqlite.statement.${String(name)}`);
								if (name === "iterate") return () => this.reject("sqlite.statement.iterate");
								const value: unknown = Reflect.get(target, name, target);
								if (typeof value !== "function") return value;
								return (...parameters: unknown[]) => invoke(target, name, parameters);
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
				return (...args: unknown[]) => invoke(database, key, args);
			},
		});
	}

	/** Open application handles, separately from the fixture-owned persistent RAM backing connections. */
	openHandles(): readonly string[] {
		return [...this.handles].filter((handle) => handle.open).map((handle) => handle.path);
	}

	failNext(operation: SqliteFaultOperation, sql: string): void {
		if (!sql.trim()) throw new Error("SQLite failure requires a specific SQL witness");
		this.faults.push({ operation, sql });
	}

	assertFaultsConsumed(): void {
		if (this.faults.length) throw new Error(`Unused SQLite faults: ${JSON.stringify(this.faults)}`);
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
