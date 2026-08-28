import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface SqliteStatement {
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
	run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	readonly isTransaction: boolean;
	[Symbol.dispose](): void;
}

export interface OpenSqliteDatabaseOptions {
	databasePath: string;
	busyTimeoutMs?: number;
}

type EngineStatement = {
	get: (...params: unknown[]) => unknown;
	all: (...params: unknown[]) => unknown;
	run: (...params: unknown[]) => unknown;
};

type EngineDatabase = {
	exec(sql: string): void;
	prepare(sql: string): EngineStatement;
};

function asRow(value: unknown): Record<string, unknown> | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	return undefined;
}

function wrapStatement(statement: EngineStatement): SqliteStatement {
	return {
		get(...params: unknown[]) {
			return asRow(statement.get(...params));
		},
		all(...params: unknown[]) {
			const rows = statement.all(...params);
			if (!Array.isArray(rows)) return [];
			return rows.flatMap((row) => {
				const record = asRow(row);
				return record === undefined ? [] : [record];
			});
		},
		run(...params: unknown[]) {
			return statement.run(...params);
		},
	};
}

function wrapDatabase(database: EngineDatabase, isTransaction: () => boolean, dispose: () => void): SqliteDatabase {
	return {
		exec(sql: string) {
			database.exec(sql);
		},
		prepare(sql: string) {
			return wrapStatement(database.prepare(sql));
		},
		get isTransaction() {
			return isTransaction();
		},
		[Symbol.dispose]() {
			dispose();
		},
	};
}

function isBunRuntime(): boolean {
	return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

function openBunDatabase(options: OpenSqliteDatabaseOptions): SqliteDatabase {
	const bunSqlite = require("bun:sqlite") as {
		Database: new (filename: string) => EngineDatabase & { close(): void; inTransaction: boolean };
	};
	const database = new bunSqlite.Database(options.databasePath);
	return wrapDatabase(
		database,
		() => database.inTransaction,
		() => {
			database.close();
		},
	);
}

function openNodeDatabase(options: OpenSqliteDatabaseOptions): SqliteDatabase {
	const specifier = ["node", "sqlite"].join(":");
	const nodeSqlite = require(specifier) as {
		DatabaseSync: new (
			filename: string,
			sqliteOptions?: { enableForeignKeyConstraints?: boolean; timeout?: number },
		) => EngineDatabase & { readonly isTransaction: boolean; [Symbol.dispose](): void };
	};
	const database = new nodeSqlite.DatabaseSync(options.databasePath, {
		enableForeignKeyConstraints: true,
		timeout: options.busyTimeoutMs ?? 5_000,
	});
	return wrapDatabase(
		database,
		() => database.isTransaction,
		() => {
			database[Symbol.dispose]();
		},
	);
}

export function openSqliteDatabase(options: OpenSqliteDatabaseOptions): SqliteDatabase {
	return isBunRuntime() ? openBunDatabase(options) : openNodeDatabase(options);
}
