import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import {
	collectMessageTexts,
	emptyPathAliasTable,
	extendPathAliasTable,
	formatPathAliasLegend,
	type PathAliasTable,
	rewriteAgentMessages,
} from "./path-alias-table.ts";
import { createSqlitePathAliasStore, type SqlitePathAliasStore } from "./sqlite-runtime-index.ts";

const LAST_SCANNED_TS_KEY = "last_scanned_timestamp";

export class PathAliasRuntime {
	private table: PathAliasTable;
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

	peekLegend(): string | undefined {
		return formatPathAliasLegend(this.table);
	}

	sync(messages: readonly AgentMessage[]): { messages: AgentMessage[]; legend?: string } {
		this.ensureLoaded();
		const extended = extendPathAliasTable(this.table, this.textsToScan(messages));
		if (extended.inserted.length > 0) {
			const turn = this.getTurnIndex();
			for (const entry of extended.inserted) {
				this.store?.upsert({ fullPath: entry.path, aliasId: entry.id, createdAtTurn: turn });
			}
			this.table = extended.table;
		}
		const maxTs = maxMessageTimestamp(messages);
		if (maxTs > this.lastScannedTs) {
			this.lastScannedTs = maxTs;
			this.store?.setMeta(LAST_SCANNED_TS_KEY, String(maxTs));
		}
		return {
			messages: rewriteAgentMessages(messages, this.table),
			legend: formatPathAliasLegend(this.table),
		};
	}

	close(): void {
		this.store?.close();
		this.store = undefined;
		this.loaded = false;
	}

	private ensureLoaded(): void {
		const cwd = this.getCwd();
		if (this.loaded) {
			this.table = { ...this.table, cwd };
			return;
		}
		const databasePath = this.getDatabasePath();
		mkdirSync(dirname(databasePath), { recursive: true });
		this.store = createSqlitePathAliasStore({ databasePath });
		const rows = this.store.list();
		this.table = {
			cwd,
			entries: rows.map((row) => ({ id: row.aliasId, path: row.fullPath })),
		};
		const meta = this.store.getMeta(LAST_SCANNED_TS_KEY);
		this.lastScannedTs = meta ? Number(meta) || 0 : 0;
		this.loaded = true;
	}

	private textsToScan(messages: readonly AgentMessage[]): string[] {
		if (this.table.entries.length === 0) return collectMessageTexts(messages);
		return collectMessageTexts(messages.filter((message) => (message.timestamp ?? 0) > this.lastScannedTs));
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
