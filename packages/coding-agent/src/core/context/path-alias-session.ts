import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { resolvePath } from "../../utils/paths.ts";
import {
	collectMessageTexts,
	displayPath,
	emptyPathAliasTable,
	extendPathAliasTable,
	formatPathAliasLegend,
	type PathAliasTable,
	rewriteAgentMessages,
} from "./path-alias-table.ts";
import { createSqlitePathAliasStore, type SqlitePathAliasStore } from "./sqlite-runtime-index.ts";

const LAST_SCANNED_TS_KEY = "last_scanned_timestamp";
const RESERVED_TOKENS_KEY = "reserved_alias_tokens";
const TABLE_CWD_KEY = "table_cwd";

interface PathAliasRecord {
	/** Posix absolute (or drive-style) path — the durable, cwd-independent identity. */
	absolute: string;
	id: string;
}

export class PathAliasRuntime {
	private table: PathAliasTable;
	private records: PathAliasRecord[] = [];
	private store: SqlitePathAliasStore | undefined;
	private loaded = false;
	private lastScannedTs = 0;
	private readonly getCwd: () => string;
	private readonly getDatabasePath: () => string;
	private readonly getTurnIndex: () => number;

	constructor(getCwd: () => string, getDatabasePath: () => string, getTurnIndex: () => number) {
		this.getCwd = getCwd;
		this.getDatabasePath = getDatabasePath;
		this.getTurnIndex = getTurnIndex;
		this.table = emptyPathAliasTable(".");
	}

	peekTable(): PathAliasTable {
		return this.table;
	}

	sync(messages: readonly AgentMessage[]): { messages: AgentMessage[]; legend?: string } {
		this.ensureLoaded();
		// A candidate id that names a real file or directory under cwd (a literal `p/`
		// tree) must never be assigned, or expansion would redirect real-file references.
		const extended = extendPathAliasTable(this.table, this.textsToScan(messages), {
			reservationTexts: collectMessageTexts(messages),
			isIdTaken: (aliasId) => existsSync(join(this.table.cwd, aliasId)),
		});
		if (extended.inserted.length > 0 || extended.table !== this.table) {
			const turn = this.getTurnIndex();
			for (const entry of extended.inserted) {
				const absolute = toStoredAbsolute(entry.path, this.table.cwd);
				this.records.push({ absolute, id: entry.id });
				this.store?.upsert({ fullPath: absolute, aliasId: entry.id, createdAtTurn: turn });
			}
			const reservationsGrew = (extended.table.reservedIds?.length ?? 0) !== (this.table.reservedIds?.length ?? 0);
			this.table = extended.table;
			if (reservationsGrew) {
				this.store?.setMeta(RESERVED_TOKENS_KEY, JSON.stringify(this.table.reservedIds ?? []));
			}
		}
		const maxTs = maxMessageTimestamp(messages);
		if (maxTs > this.lastScannedTs) {
			this.lastScannedTs = maxTs;
			this.store?.setMeta(LAST_SCANNED_TS_KEY, String(maxTs));
		}
		const rewritten = rewriteAgentMessages(messages, this.table);
		return {
			messages: rewritten,
			legend: formatPathAliasLegend(this.table, collectMessageTexts(rewritten)),
		};
	}

	close(): void {
		this.store?.close();
		this.store = undefined;
		this.records = [];
		this.loaded = false;
	}

	private ensureLoaded(): void {
		const cwd = this.getCwd();
		if (this.loaded) {
			if (this.table.cwd !== cwd) this.table = this.buildTableForCwd(cwd);
			return;
		}
		const databasePath = this.getDatabasePath();
		mkdirSync(dirname(databasePath), { recursive: true });
		this.store = createSqlitePathAliasStore({ databasePath });
		// New rows store absolute paths; legacy rows stored cwd-relative displays and are
		// anchored to the cwd recorded at their creation (falling back to the current one).
		const storedCwd = this.store.getMeta(TABLE_CWD_KEY);
		this.records = this.store.list().map((row) => ({
			absolute: toStoredAbsolute(row.fullPath, storedCwd ?? cwd),
			id: row.aliasId,
		}));
		this.table = {
			cwd,
			entries: [],
			reservedIds: readReservedTokens(this.store.getMeta(RESERVED_TOKENS_KEY)),
		};
		this.table = this.buildTableForCwd(cwd);
		if (!storedCwd) this.store.setMeta(TABLE_CWD_KEY, cwd);
		const meta = this.store.getMeta(LAST_SCANNED_TS_KEY);
		this.lastScannedTs = meta ? Number(meta) || 0 : 0;
		this.loaded = true;
	}

	private buildTableForCwd(cwd: string): PathAliasTable {
		return {
			cwd,
			entries: this.records.map((record) => ({ id: record.id, path: displayPath(record.absolute, cwd) })),
			reservedIds: this.table.reservedIds ?? [],
		};
	}

	private textsToScan(messages: readonly AgentMessage[]): string[] {
		if (this.table.entries.length === 0) return collectMessageTexts(messages);
		return collectMessageTexts(messages.filter((message) => (message.timestamp ?? 0) > this.lastScannedTs));
	}
}

function toStoredAbsolute(path: string, cwd: string): string {
	if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return path;
	return resolvePath(path, cwd).replaceAll("\\", "/");
}

function readReservedTokens(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((token) => typeof token === "string") : [];
	} catch {
		return [];
	}
}

function maxMessageTimestamp(messages: readonly AgentMessage[]): number {
	let max = 0;
	for (const message of messages) {
		const timestamp = message.timestamp ?? 0;
		if (timestamp > max) max = timestamp;
	}
	return max;
}
