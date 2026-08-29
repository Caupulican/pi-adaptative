import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { resolvePath } from "../../utils/paths.ts";
import {
	collectActiveAliasIds,
	collectMessageTexts,
	displayPath,
	emptyPathAliasTable,
	extendPathAliasTable,
	formatPathAliasLegendForIds,
	MAX_RESERVED_TOKENS,
	type PathAliasTable,
	rewriteAgentMessagesWith,
	rewriteText,
} from "./path-alias-table.ts";
import {
	createSqlitePathAliasStore,
	openPathAliasStoreReadOnly,
	type SqlitePathAliasRow,
	type SqlitePathAliasStore,
} from "./sqlite-runtime-index.ts";

const LAST_SCANNED_TS_KEY = "last_scanned_timestamp";
const RESERVED_TOKENS_KEY = "reserved_alias_tokens";
const TABLE_CWD_KEY = "table_cwd";

interface PathAliasRecord {
	/** Posix absolute (or drive-style) path — the durable, cwd-independent identity. */
	absolute: string;
	id: string;
}

/**
 * PREFIX-STABILITY INVARIANT: every provider request re-sends the whole conversation, and the
 * provider serves it from a cache keyed by the longest byte-identical prefix. So the projection
 * this runtime produces must be APPEND-ONLY across requests — request N+1 reproduces request N's
 * bytes for everything already sent, and only appends. Two rules enforce that here:
 *
 * - a text span keeps the spelling it was FIRST sent with ({@link PathAliasRuntime.renderFrozen}),
 *   even after a later turn mints an alias that would also match it. Retro-rewriting already-sent
 *   history moves bytes deep inside the cached prefix and forces a full re-prefill of the
 *   conversation;
 * - the legend never retracts a line ({@link PathAliasRuntime.legendIds}). Scoping it to the ids
 *   visible in the current window makes it flap as the window slides, and the legend is re-sent
 *   verbatim on every request.
 */
export class PathAliasRuntime {
	private table: PathAliasTable;
	private records: PathAliasRecord[] = [];
	private store: SqlitePathAliasStore | undefined;
	private loaded = false;
	private lastScannedTs = 0;
	/**
	 * Ids ever rendered into the legend. Monotone: an id whose last mention scrolls out of the
	 * window keeps its line instead of retracting it, so the rendered legend only ever grows by
	 * lines appended in table (mint) order.
	 */
	private readonly legendIds = new Set<string>();
	/**
	 * Frozen provider spelling per already-rendered text span, keyed by a hash of the span BEFORE
	 * rewriting. Rebuilt each sync from the spans actually present, so it holds exactly the live
	 * context and a span that leaves the window (compaction, GC repacking) drops out.
	 */
	private frozenSpellings = new Map<string, string>();
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
		// Every id lives under the literal relative prefix `p/`, so when no `p` entry
		// exists under cwd at all, one stat clears every candidate — a per-candidate stat
		// is a synchronous filesystem roundtrip that hangs large syncs on slow mounts
		// (WSL /mnt drives). When `p` does exist, per-id results are memoized for the sync.
		const pEntryExists = existsSync(join(this.table.cwd, "p"));
		const idTakenMemo = new Map<string, boolean>();
		const extended = extendPathAliasTable(this.table, this.textsToScan(messages), {
			reservationTexts: collectMessageTexts(messages),
			isIdTaken: (aliasId) => {
				if (!pEntryExists) return false;
				let taken = idTakenMemo.get(aliasId);
				if (taken === undefined) {
					taken = existsSync(join(this.table.cwd, aliasId));
					idTakenMemo.set(aliasId, taken);
				}
				return taken;
			},
		});
		if (extended.inserted.length > 0 || extended.table !== this.table) {
			const turn = this.getTurnIndex();
			const rows: SqlitePathAliasRow[] = [];
			for (const entry of extended.inserted) {
				const absolute = toStoredAbsolute(entry.path, this.table.cwd);
				this.records.push({ absolute, id: entry.id });
				rows.push({ fullPath: absolute, aliasId: entry.id, createdAtTurn: turn });
			}
			this.store?.upsertMany(rows);
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
		const rewritten = this.renderFrozen(messages);
		for (const id of collectActiveAliasIds(collectMessageTexts(rewritten))) this.legendIds.add(id);
		return {
			messages: rewritten,
			legend: formatPathAliasLegendForIds(this.table, this.legendIds),
		};
	}

	/**
	 * Render every text span through its frozen spelling, minting one only for spans not yet sent.
	 * Called several times per provider request (preview, projection, commit) and must return the
	 * same bytes each time; it does, because the freeze is resolved before the fresh rewrite.
	 */
	private renderFrozen(messages: readonly AgentMessage[]): AgentMessage[] {
		const live = new Map<string, string>();
		const rendered = rewriteAgentMessagesWith(messages, (text) => {
			const key = createHash("sha256").update(text).digest("hex");
			const frozen = live.get(key) ?? this.frozenSpellings.get(key);
			if (frozen !== undefined) {
				live.set(key, frozen);
				return frozen;
			}
			const fresh = rewriteText(this.table, text);
			live.set(key, fresh);
			return fresh;
		});
		this.frozenSpellings = live;
		return rendered;
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

/**
 * Read-only counterpart to `ensureLoaded()`: loads the table for a session that is not (and must
 * not become) the live one — HTML export, primarily. Skips both of `ensureLoaded`'s write side
 * effects (the `table_cwd` meta backfill for legacy rows, and `createSqlitePathAliasStore`'s
 * schema-creating open) and never mints or extends — that is `sync()`'s job, and calling it here
 * would write new alias rows to a closed session's store. Returns `undefined` when the database
 * file does not exist (an old/foreign session with no alias table); any other failure to open or
 * read it propagates uncaught.
 */
export function loadPathAliasTableReadOnly(cwd: string, databasePath: string): PathAliasTable | undefined {
	const store = openPathAliasStoreReadOnly({ databasePath });
	if (!store) return undefined;
	try {
		const storedCwd = store.getMeta(TABLE_CWD_KEY);
		const records: PathAliasRecord[] = store.list().map((row) => ({
			absolute: toStoredAbsolute(row.fullPath, storedCwd ?? cwd),
			id: row.aliasId,
		}));
		return {
			cwd,
			entries: records.map((record) => ({ id: record.id, path: displayPath(record.absolute, cwd) })),
			reservedIds: readReservedTokens(store.getMeta(RESERVED_TOKENS_KEY)),
		};
	} finally {
		store.close();
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
		if (!Array.isArray(parsed)) return [];
		// A legacy meta blob written before the cap existed could exceed it; trim on load
		// (first-come-keep, matching the in-table policy) so it can never grow again.
		return parsed.filter((token) => typeof token === "string").slice(0, MAX_RESERVED_TOKENS);
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
