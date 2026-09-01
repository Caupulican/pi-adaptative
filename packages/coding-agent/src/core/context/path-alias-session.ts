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
const LAST_SCANNED_TS_PERSIST_INTERVAL_MS = 5_000;
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
	 * Whether `lastScannedTs` has moved past what the store holds, and when it was last persisted.
	 * The mark is a resume optimization (which messages an earlier process already scanned), so it
	 * does not need to reach disk on every request: persisting it per request was one synchronous
	 * journaled SQLite write per provider request -- 37% of host time on Windows in the CI profile.
	 * It lands with any alias insert (already a write), at close, and otherwise at most every few
	 * seconds; a mark that lags only means the next process rescans a few more messages, which is
	 * idempotent.
	 */
	private lastScannedTsDirty = false;
	private lastScannedTsPersistedAt = 0;
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
	/**
	 * Result of the most recent {@link sync} call, keyed by the exact message-list identity it saw.
	 * `sync` is called twice per provider request (preview, then commit — see
	 * `ProviderRequestContextController.plan`) built from the same durable messages; when nothing
	 * was freshly GC-packed in between, `applyContextGc` hands back its input array unchanged BY
	 * REFERENCE (untouched messages keep their identity — see `context-gc.ts`'s `nextMessages =
	 * messages.slice()`), so the two calls see the identical array and the second `sync` is a full
	 * transcript hash-and-rewrite pass repeated for an answer already computed. Comparing by
	 * per-element reference (never content) is what keeps the check itself cheap — a pointer scan is
	 * orders of magnitude cheaper than the hashing it lets us skip — and it can never return a stale
	 * answer: any message that actually changed (freshly packed, newly appended) fails the
	 * comparison and falls through to a full, correct recompute. `cwd` is part of the key too: it
	 * comes from a live getter (a session can change directory mid-run), and a cwd change can alter
	 * every display path without touching a single message — keying on messages alone could hand
	 * back a stale legend that a cwd-aware caller (`prepareCommit`'s own equality check) would
	 * otherwise have caught as a genuine change.
	 *
	 * The stored `messages` is a SNAPSHOT (`messages.slice()`), never the caller's live array. That
	 * is what makes `sameMessageSequence`'s `a === b` fast path safe: an array is not immutable just
	 * because this class treats it that way, and at least one real caller mutates one in place to
	 * preserve its identity across a replan (`adoptReplannedMessages` in
	 * `provider-request-planner.ts`, which does `target.messages.length = 0` then re-pushes). Storing
	 * the live reference would let `a === b` compare a mutated array against itself and report "same"
	 * for content that has actually changed, handing back a result computed from the pre-mutation
	 * bytes. The snapshot is a different object from the caller's array on every later call, so a
	 * same-reference caller that mutated in place still falls through to the real (and correct)
	 * length/element comparison below.
	 */
	private lastSync:
		| {
				readonly cwd: string;
				readonly messages: readonly AgentMessage[];
				readonly result: { messages: AgentMessage[]; legend?: string };
		  }
		| undefined;
	/**
	 * Each message's rendering, keyed by message identity, with the frozen spellings it contributed
	 * and the alias ids its rendering references.
	 *
	 * A span keeps the spelling it was first sent with, so a message once rendered renders the same
	 * bytes forever: re-rendering every message on every request -- hashing every text span to look
	 * its frozen spelling up, then scanning every rendered text for the legend -- was 9% of host CPU
	 * over a 1,500-turn session, growing with the transcript. Only messages this runtime has never
	 * rendered are rendered now; the rest hand back the same object, which also keeps their identity
	 * stable for the provider. Reset with the table when the working directory changes.
	 */
	private rendered = new WeakMap<
		AgentMessage,
		{
			readonly message: AgentMessage;
			readonly spellings: ReadonlyArray<readonly [string, string]>;
			readonly aliasIds: readonly string[];
		}
	>();
	/**
	 * A store that predates reservation persistence (`reservedIds` undefined after load) must have its
	 * whole history scanned for standalone tokens once, since none of its earlier scans were kept.
	 * Once per runtime; afterwards the persisted set carries forward and only new texts are scanned.
	 */
	private reservationHistoryScanned = false;
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
		const cached = this.lastSync;
		if (cached && cached.cwd === this.table.cwd && sameMessageSequence(cached.messages, messages))
			return cached.result;
		// A candidate id that names a real file or directory under cwd (a literal `p/`
		// tree) must never be assigned, or expansion would redirect real-file references.
		// Every id lives under the literal relative prefix `p/`, so when no `p` entry
		// exists under cwd at all, one stat clears every candidate — a per-candidate stat
		// is a synchronous filesystem roundtrip that hangs large syncs on slow mounts
		// (WSL /mnt drives). When `p` does exist, per-id results are memoized for the sync.
		const pEntryExists = existsSync(join(this.table.cwd, "p"));
		const idTakenMemo = new Map<string, boolean>();
		// Reservations persist with the table whenever they grow, so texts scanned on an earlier
		// request have already reserved every standalone token they carry; only new texts need scanning.
		const textsToScan = this.textsToScan(messages);
		let scanWholeHistoryForReservations = !this.reservationHistoryScanned;
		const reservationTexts = scanWholeHistoryForReservations ? collectMessageTexts(messages) : textsToScan;
		this.reservationHistoryScanned = true;
		const extended = extendPathAliasTable(this.table, textsToScan, {
			reservationTexts,
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
				scanWholeHistoryForReservations = false;
			}
		}
		// The one-time whole-history scan is recorded even when it reserved nothing, so the next
		// process starts from the persisted set instead of scanning the history again.
		if (scanWholeHistoryForReservations) {
			this.store?.setMeta(RESERVED_TOKENS_KEY, JSON.stringify(this.table.reservedIds ?? []));
		}
		const maxTs = maxMessageTimestamp(messages);
		if (maxTs > this.lastScannedTs) {
			this.lastScannedTs = maxTs;
			this.lastScannedTsDirty = true;
		}
		const wroteAliases = extended.inserted.length > 0;
		if (
			this.lastScannedTsDirty &&
			(wroteAliases || Date.now() - this.lastScannedTsPersistedAt >= LAST_SCANNED_TS_PERSIST_INTERVAL_MS)
		) {
			this.persistLastScannedTs();
		}
		const rewritten = this.renderFrozen(messages);
		const result = {
			messages: rewritten,
			legend: formatPathAliasLegendForIds(this.table, this.legendIds),
		};
		this.lastSync = { cwd: this.table.cwd, messages: messages.slice(), result };
		return result;
	}

	/**
	 * Render every text span through its frozen spelling, minting one only for spans not yet sent.
	 * Called several times per provider request (preview, projection, commit) and must return the
	 * same bytes each time; it does, because the freeze is resolved before the fresh rewrite.
	 */
	private renderFrozen(messages: readonly AgentMessage[]): AgentMessage[] {
		const live = new Map<string, string>();
		const rendered = messages.map((message) => {
			const memo = this.rendered.get(message);
			if (memo) {
				// Its spellings stay live for any later message that repeats one of its spans.
				for (const [key, spelling] of memo.spellings) live.set(key, spelling);
				return memo.message;
			}
			const spellings: Array<readonly [string, string]> = [];
			const [output] = rewriteAgentMessagesWith([message], (text) => {
				const key = createHash("sha256").update(text).digest("hex");
				const frozen = live.get(key) ?? this.frozenSpellings.get(key);
				const spelling = frozen ?? rewriteText(this.table, text);
				live.set(key, spelling);
				spellings.push([key, spelling]);
				return spelling;
			});
			const aliasIds = [...collectActiveAliasIds(collectMessageTexts([output!]))];
			for (const id of aliasIds) this.legendIds.add(id);
			this.rendered.set(message, { message: output!, spellings, aliasIds });
			return output!;
		});
		this.frozenSpellings = live;
		return rendered;
	}

	private persistLastScannedTs(): void {
		if (!this.lastScannedTsDirty || !this.store) return;
		this.store.setMeta(LAST_SCANNED_TS_KEY, String(this.lastScannedTs));
		this.lastScannedTsDirty = false;
		this.lastScannedTsPersistedAt = Date.now();
	}

	close(): void {
		this.persistLastScannedTs();
		this.store?.close();
		this.store = undefined;
		this.records = [];
		this.loaded = false;
		this.rendered = new WeakMap();
		this.reservationHistoryScanned = false;
	}

	private ensureLoaded(): void {
		const cwd = this.getCwd();
		if (this.loaded) {
			if (this.table.cwd !== cwd) {
				this.table = this.buildTableForCwd(cwd);
				this.rendered = new WeakMap();
			}
			return;
		}
		const databasePath = this.getDatabasePath();
		mkdirSync(dirname(databasePath), { recursive: true });
		this.store = createSqlitePathAliasStore({ databasePath });
		// New rows store absolute paths; legacy rows stored cwd-relative displays and are
		// anchored to the cwd recorded at their creation (falling back to the current one).
		const storedCwd = this.store.getMeta(TABLE_CWD_KEY);
		const reservedTokensMeta = this.store.getMeta(RESERVED_TOKENS_KEY);
		// Reservations persisted at all means every earlier scan is already carried forward.
		this.reservationHistoryScanned = reservedTokensMeta !== undefined;
		this.records = this.store.list().map((row) => ({
			absolute: toStoredAbsolute(row.fullPath, storedCwd ?? cwd),
			id: row.aliasId,
		}));
		this.table = {
			cwd,
			entries: [],
			reservedIds: readReservedTokens(reservedTokensMeta),
		};
		this.table = this.buildTableForCwd(cwd);
		if (!storedCwd) this.store.setMeta(TABLE_CWD_KEY, cwd);
		const meta = this.store.getMeta(LAST_SCANNED_TS_KEY);
		this.lastScannedTs = meta ? Number(meta) || 0 : 0;
		// The persist interval counts from the load, so the first requests do not each write the mark.
		this.lastScannedTsPersistedAt = Date.now();
		this.lastScannedTsDirty = false;
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

/**
 * Cheap same-input check for {@link PathAliasRuntime.sync}'s memo: a per-element reference scan,
 * never a content comparison — content equality is exactly the expensive question `sync` itself
 * answers, so testing it here would just move the cost rather than cut it.
 */
function sameMessageSequence(a: readonly AgentMessage[], b: readonly AgentMessage[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}
