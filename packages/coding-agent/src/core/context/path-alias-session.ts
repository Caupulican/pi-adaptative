import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTransientRecordPayload } from "../../kernel/index.ts";
import { createCustomMessage } from "../../kernel/messages.ts";
import { PrefixFold, PrefixFoldByFirstItem } from "../../kernel/prefix-fold.ts";
import { transientRecordMessageOf } from "../../kernel/transient-records.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { resolvePath } from "../../utils/paths.ts";
import { COMMS_RECORD_VERSION } from "../comms/comms-records.ts";
import {
	PATH_ALIAS_LEGEND_PAUSED_LINE,
	PATH_ALIAS_LEGEND_RESUMED_LINE,
	type PathAliasLegendRecord,
	readPathAliasLegendRecord,
	renderPathAliasLegendFrame,
} from "../comms/host-injection-records.ts";
import {
	buildPathAliasLegendDelta,
	collectActiveAliasIds,
	collectMessageTexts,
	collectReferencedAliasIds,
	collectWireTexts,
	displayPath,
	emptyPathAliasTable,
	extendPathAliasTable,
	MAX_RESERVED_TOKENS,
	PATH_ALIAS_LEGEND_CUSTOM_TYPE,
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

const RESERVED_TOKENS_KEY = "reserved_alias_tokens";
const SCANNED_PERSIST_INTERVAL_MS = 5_000;
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
 * - the legend never retracts a line: a legend record, once in the history, stays there, and a
 *   later record only adds the lines of aliases that became visible since.
 *
 * VISIBILITY RULE: a legend record lists the aliases the model can see on this request's wire and
 * no committed record lists - ids referenced by the rendered messages, the request's transients and
 * the text the kernel and a host projection carry around them (the failure ledger, a turn view).
 * An alias the model can no longer see gets no line: a projection that sends only the running turn
 * (continuous chat) would otherwise re-send every alias minted in the session at every turn. Tool
 * arguments never depend on the legend: the tool wrapper expands any minted alias against the full
 * table (`wrapToolWithPathAliasExpansion`), so the rule is a model-visibility concern only.
 */
/** Legend bytes below which the budget never pauses minting (a table this small cannot be the cost). */
const LEGEND_BUDGET_FLOOR_CHARS = 4096;
/**
 * The legend may cost up to this multiple of what the aliases saved before minting pauses. One:
 * a legend line that saves less than it costs is a loss the rest of the session keeps paying
 * (measured live: 315 lines minted from directory listings that nothing ever mentioned).
 */
const LEGEND_BUDGET_MARGIN = 1;

export interface PathAliasSyncResult {
	messages: AgentMessage[];
	/**
	 * The cumulative delta legend record for one request: the aliases the model can see on the wire (these rendered messages,
	 * plus the request's other `visibleMessages` and `visibleTexts`) that no legend record in the synced history, or on the
	 * wire, lists. While alias minting is paused, the first request of the pause carries a pause-only record (no lines); a
	 * request whose history already shows the pause carries nothing more for it, and a delta that lists aliases carries the
	 * pause line itself. When minting resumes while a pause note is on the wire, the record clears it (`resumed`) and lists the
	 * aliases pending on that request. Undefined when every visible alias already has a line and no pause note needs a change.
	 */
	legendFor?(
		visibleMessages: readonly AgentMessage[],
		visibleTexts: readonly string[],
	): PathAliasLegendRecord | undefined;
	/**
	 * The cumulative legend of a carried frame: every alias the frame's texts reference, in the order they were first listed
	 * in this runtime. Its text is append-only (`renderPathAliasLegendFrame`): a frame that lists more aliases starts with the
	 * text of one that listed fewer, so the carried copy stays a byte prefix of every later one. It carries no pause state;
	 * the delta legend does.
	 */
	frameLegend?(frameTexts: readonly string[]): AgentMessage | undefined;
}

/** Digest identifying one legend content, for the frame legends and the cost count that a re-sent frame legend must not repeat. */
function legendDigest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** The text of a legend record: its string content, or the text blocks a carried frame re-sent it as. */
function legendText(message: Extract<AgentMessage, { role: "custom" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The render fold's state: the output aligned with the messages it covered, and the spellings they froze. */
interface RenderState {
	live: Map<string, string>;
	rendered: AgentMessage[];
}

/** The legend fold's state over one history: the lines its records list, and whether a pause note is still on the wire. */
interface LegendHistoryState {
	listed: Set<string>;
	pauseVisible: boolean;
}

/** One durable legend record's reading: the aliases it lists, and the pause state it sets (`paused`) or clears (`resumed`). */
interface LegendRecordState {
	readonly ids: readonly string[];
	readonly paused: boolean;
	readonly resumed: boolean;
}

/**
 * The alias ids of a legend record written before legend records carried `details.record`: its `<id>=<path>`
 * lines. Such records are already in persisted histories and still name what the model can see.
 */
function legacyLegendIds(content: unknown): readonly string[] {
	if (typeof content !== "string") return [];
	const ids: string[] = [];
	// comms-legacy-decoder: legend records persisted before the typed record list their ids only as text lines.
	for (const line of content.split("\n")) {
		const separator = line.indexOf("=");
		// The header and the pause and resume notes name no alias; only an `<id>=<path>` line lists one.
		if (separator > 0) ids.push(line.slice(0, separator));
	}
	return ids;
}

/** The characters a legend record's pause or resume line takes up in its text (each with the newline that joins it): state, not charged. */
function legendStateChars(record: PathAliasLegendRecord | undefined): number {
	if (record === undefined) return 0;
	return (
		(record.paused === true ? PATH_ALIAS_LEGEND_PAUSED_LINE.length + 1 : 0) +
		(record.resumed === true ? PATH_ALIAS_LEGEND_RESUMED_LINE.length + 1 : 0)
	);
}

export class PathAliasRuntime {
	private table: PathAliasTable;
	private records: PathAliasRecord[] = [];
	private store: SqlitePathAliasStore | undefined;
	private loaded = false;
	private scanned = new Set<string>();
	private readonly scanFingerprints = new WeakMap<AgentMessage, string>();
	/**
	 * Scanned fingerprints the store does not hold yet, and when they were last persisted.
	 * They are a resume optimization (which messages an earlier process already scanned), so they
	 * do not need to reach disk on every request: persisting per request was one synchronous
	 * journaled SQLite write per provider request -- 37% of host time on Windows in the CI profile.
	 * They land with any alias insert (already a write), at close, and otherwise at most every few
	 * seconds; a lag only means the next process rescans a few more messages, which is idempotent.
	 */
	private pendingScanned: string[] = [];
	private scannedPersistedAt = 0;
	/** Ids ever rendered in a message: whose mentions the legend budget's savings side counts (`getAliasEconomics`). */
	private readonly legendIds = new Set<string>();
	/**
	 * Characters of every distinct legend record seen in a synced history: the legend budget's cost side. A record is
	 * one object per conversation it was sent in, so a line re-sent to another conversation, or again after a
	 * compaction or in a continuous-chat turn, is paid again. A record that lists no alias is not charged, and neither
	 * is the pause or resume line of one that does: those notes describe minting, and a note charged to the budget that
	 * pauses minting would keep minting paused.
	 */
	private emittedLegendChars = 0;
	/**
	 * The aliases a carried frame legend lists, in the order they were first listed. Append-only: an id leaves it only when it
	 * leaves the table. A restarted runtime rebuilds it from the referenced aliases in table order, so its line order can differ
	 * from the live runtime's: at most one head cache miss.
	 */
	private frameLegendOrder: string[] = [];
	/** Digests of every frame legend content this runtime made, so a legend record is recognized as a frame's. */
	private readonly frameLegendDigests = new Set<string>();
	/**
	 * The characters of the frame legend the cost count holds. The frame text is append-only, so its longest version is every
	 * character the frame has ever sent once: a version that only extends it adds its new suffix, and a re-sent one adds nothing.
	 */
	private countedFrameLegendChars = 0;
	/** The alias ids each wire message references, read once per message object. */
	private readonly referencedIds = new WeakMap<AgentMessage, ReadonlySet<string>>();
	/** What each durable legend record says, read once per record object (see {@link LegendRecordState}). */
	private readonly legendRecordStates = new WeakMap<object, LegendRecordState>();
	/** Mentions per alias id in rendered text, the savings side of the legend budget. */
	private readonly mentionsById = new Map<string, number>();
	private mintingPaused = false;
	/**
	 * Frozen provider spelling per already-rendered text span, keyed by a hash of the span BEFORE
	 * rewriting. Rebuilt each sync from the spans actually present, so it holds exactly the live
	 * context and a span that leaves the window (compaction, GC repacking) drops out.
	 */
	private frozenSpellings = new Map<string, string>();
	/**
	 * The render fold: what the messages it covered rendered to, and the live spellings after them. A request whose history
	 * extends that prefix renders only the appended messages; rebuilding the live map from every message's spellings on every
	 * request walked the whole transcript. A diverged history starts the fold over, and the spellings the last render froze
	 * (`frozenSpellings`, which the fresh render reads) keep their bytes.
	 */
	private renderFold: PrefixFold<AgentMessage, RenderState> = this.createRenderFold();
	/** The legend records of the history, and of the wire a legend is made for: each lineage has its own fold. */
	private readonly historyLegendFolds = new PrefixFoldByFirstItem<AgentMessage, LegendHistoryState>(
		() => ({ listed: new Set(), pauseVisible: false }),
		(state, message) => this.foldLegendRecord(state, message),
	);
	private readonly wireLegendFolds = new PrefixFoldByFirstItem<AgentMessage, LegendHistoryState>(
		() => ({ listed: new Set(), pauseVisible: false }),
		(state, message) => this.foldLegendRecord(state, message),
	);
	/** The alias ids the rendered messages reference, folded over the render's output. */
	private readonly visibleAliasFold = new PrefixFoldByFirstItem<AgentMessage, Set<string>>(
		() => new Set(),
		(ids, message) => {
			for (const id of this.referencedAliasIds(message)) ids.add(id);
		},
	);
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
				readonly result: PathAliasSyncResult;
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

	/**
	 * Whether a candidate must exist on disk (from the table's cwd) before it is minted. Production
	 * keeps this on: a spelling relative to another root would otherwise become an alias that
	 * resolves to ENOENT. Tests of the table mechanics turn it off to mint synthetic paths.
	 */
	private readonly requireExistingTargets: boolean;

	constructor(
		getCwd: () => string,
		getDatabasePath: () => string,
		getTurnIndex: () => number,
		options?: { requireExistingTargets?: boolean },
	) {
		this.getCwd = getCwd;
		this.getDatabasePath = getDatabasePath;
		this.getTurnIndex = getTurnIndex;
		this.requireExistingTargets = options?.requireExistingTargets ?? true;
		this.table = emptyPathAliasTable(".");
	}

	peekTable(): PathAliasTable {
		return this.table;
	}

	sync(messages: readonly AgentMessage[]): PathAliasSyncResult {
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
		// Whole-table budget: an alias pays for itself per mention, but the legend is paid per line
		// in every record that carries it. Once the lines cost more than every mention saves, minting
		// stops (existing aliases keep working) until the balance recovers.
		this.mintingPaused = this.legendCostExceedsSavings();
		const unscanned = messages.filter((message) => !this.scanned.has(this.scanFingerprint(message)));
		const textsToScan = this.mintingPaused ? [] : collectMessageTexts(unscanned);
		let scanWholeHistoryForReservations = !this.reservationHistoryScanned;
		const reservationTexts = scanWholeHistoryForReservations ? collectMessageTexts(messages) : textsToScan;
		this.reservationHistoryScanned = true;
		const existsMemo = new Map<string, boolean>();
		const extended = extendPathAliasTable(this.table, textsToScan, {
			reservationTexts,
			...(this.requireExistingTargets
				? {
						candidateExists: (path: string) => {
							let exists = existsMemo.get(path);
							if (exists === undefined) {
								exists = existsSync(toStoredAbsolute(path, this.table.cwd));
								existsMemo.set(path, exists);
							}
							return exists;
						},
					}
				: {}),
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
		if (!this.mintingPaused) {
			for (const message of unscanned) {
				const fingerprint = this.scanFingerprint(message);
				if (this.scanned.has(fingerprint)) continue;
				this.scanned.add(fingerprint);
				this.pendingScanned.push(fingerprint);
			}
		}
		const wroteAliases = extended.inserted.length > 0;
		if (
			this.pendingScanned.length > 0 &&
			(wroteAliases || Date.now() - this.scannedPersistedAt >= SCANNED_PERSIST_INTERVAL_MS)
		) {
			this.persistScanned();
		}
		const rewritten = this.renderFrozen(messages);
		// The legend a request carries is the delta of the aliases visible on its wire against the lines
		// the model can actually see: the legend records in this history. Read from the history, not
		// remembered by the process, so a restarted process does not re-send lines already there, and a
		// compaction that summarized a record away re-sends the lines its still-visible aliases need.
		const { listed: committed, pauseVisible } = this.legendHistory(messages, this.historyLegendFolds);
		const visible = new Set(this.visibleAliasFold.fold(rewritten));
		const table = this.table;
		const paused = this.mintingPaused;
		const result: PathAliasSyncResult = {
			messages: rewritten,
			legendFor: (visibleMessages, visibleTexts) => {
				const ids = new Set(visible);
				for (const message of visibleMessages) for (const id of this.referencedAliasIds(message)) ids.add(id);
				for (const id of collectReferencedAliasIds(visibleTexts)) ids.add(id);
				// A legend record on the wire (a carried frame legend) lists its lines as the history's own records do.
				const onWire = this.legendHistory(visibleMessages, this.wireLegendFolds).listed;
				const listed = onWire.size === 0 ? committed : new Set([...committed, ...onWire]);
				const delta = buildPathAliasLegendDelta(table, ids, listed, { paused });
				if (paused) {
					if (delta !== undefined) return delta;
					// A pause note already in the history stands for the rest of its turn; only a new pause gets one.
					return pauseVisible
						? undefined
						: { v: COMMS_RECORD_VERSION, k: "path_alias_legend", paused: true, entries: [] };
				}
				if (!pauseVisible) return delta;
				// Minting resumed while the pause note is on the wire: this record clears it, with the aliases pending on this request.
				return {
					v: COMMS_RECORD_VERSION,
					k: "path_alias_legend",
					paused: false,
					resumed: true,
					entries: delta?.entries ?? [],
				};
			},
			frameLegend: (frameTexts) => this.frameLegendMessage(frameTexts, table),
		};
		this.lastSync = {
			cwd: this.table.cwd,
			messages: messages.slice(),
			result,
		};
		return result;
	}

	/** The alias ids a wire message references (see {@link collectReferencedAliasIds}), read once per message object. */
	private referencedAliasIds(message: AgentMessage): ReadonlySet<string> {
		let ids = this.referencedIds.get(message);
		if (!ids) {
			ids = collectReferencedAliasIds(collectWireTexts(message));
			this.referencedIds.set(message, ids);
		}
		return ids;
	}

	/**
	 * What the legend records in `messages` list, and whether alias minting is paused in them: a pause note (a record with
	 * `paused`) stays on the wire until a clearing record (`resumed`) follows it. A frame record and a plain delta say nothing
	 * about the pause, so they leave it as it was. Read from `details.record`, once per record object.
	 */
	private legendHistory(
		messages: readonly AgentMessage[],
		folds: PrefixFoldByFirstItem<AgentMessage, LegendHistoryState>,
	): { listed: Set<string>; pauseVisible: boolean } {
		const state = folds.fold(messages);
		return { listed: new Set(state.listed), pauseVisible: state.pauseVisible };
	}

	/** One step of the legend fold: a legend record's lines join the listed set, and its pause reading moves the state. */
	private foldLegendRecord(state: LegendHistoryState, message: AgentMessage): void {
		if (message.role !== "custom" || message.customType !== PATH_ALIAS_LEGEND_CUSTOM_TYPE) return;
		const record = this.legendRecordState(message);
		for (const id of record.ids) state.listed.add(id);
		if (record.resumed) state.pauseVisible = false;
		else if (record.paused) state.pauseVisible = true;
	}

	/** One legend record's reading, made once per record object, and charged to the cost side the first time it is read. */
	private legendRecordState(message: Extract<AgentMessage, { role: "custom" }>): LegendRecordState {
		let state = this.legendRecordStates.get(message);
		if (!state) {
			const record = readPathAliasLegendRecord(readTransientRecordPayload(message.details));
			state = {
				ids: record ? record.entries.map((entry) => entry.id) : legacyLegendIds(message.content),
				paused: record?.paused === true,
				resumed: record?.resumed === true,
			};
			this.legendRecordStates.set(message, state);
			// A record that lists no alias is a note on minting, and is not charged to the budget that pauses it.
			if (state.ids.length > 0) this.countLegendChars(message, record);
		}
		return state;
	}

	/**
	 * Counts a legend record's characters into the cost side, once per record object, except that a frame legend counts only the
	 * characters it adds to the frame: its bytes are paid once from the cached head, and a head that grows by a line pays for that
	 * line alone. Every other legend record counts per object, as a re-appended delta is paid each time it is sent, less the pause
	 * or resume line it carries (see {@link legendStateChars}). Until a frame legend exists, no digest is taken.
	 */
	private countLegendChars(
		message: Extract<AgentMessage, { role: "custom" }>,
		record: PathAliasLegendRecord | undefined,
	): void {
		const text = legendText(message);
		if (this.frameLegendDigests.size > 0 && this.frameLegendDigests.has(legendDigest(text))) {
			if (text.length > this.countedFrameLegendChars) {
				this.emittedLegendChars += text.length - this.countedFrameLegendChars;
				this.countedFrameLegendChars = text.length;
			}
			return;
		}
		this.emittedLegendChars += text.length - legendStateChars(record);
	}

	/**
	 * The cumulative legend of the frame that leads the wire: every alias `frameTexts` reference, listed in the order this runtime
	 * first listed them. The aliases one call adds follow in mint order, and the list only grows at the end, so the frame text is
	 * append-only (`renderPathAliasLegendFrame`). Returned as the record reconciliation would append for it (see
	 * `transientRecordMessageOf`), so the carried copy and any later reconciled copy are byte-identical.
	 */
	private frameLegendMessage(frameTexts: readonly string[], table: PathAliasTable): AgentMessage | undefined {
		const paths = new Map(table.entries.map((entry) => [entry.id, entry.path] as const));
		const referenced = collectReferencedAliasIds(frameTexts);
		// An id leaves the order only when it leaves the table. `Set.add` keeps an id already listed where it stands.
		const listed = new Set(this.frameLegendOrder.filter((id) => paths.has(id)));
		for (const entry of table.entries) {
			if (referenced.has(entry.id)) listed.add(entry.id);
		}
		this.frameLegendOrder = [...listed];
		if (this.frameLegendOrder.length === 0) return undefined;
		const entries = this.frameLegendOrder.flatMap((id) => {
			const path = paths.get(id);
			return path === undefined ? [] : [{ id, path }];
		});
		const record: PathAliasLegendRecord = { v: COMMS_RECORD_VERSION, k: "path_alias_legend", entries };
		const content = renderPathAliasLegendFrame(entries);
		// The host transient's timestamp is not part of the record: `transientRecordMessageOf` derives it from the content.
		const hostTransient = createCustomMessage(
			PATH_ALIAS_LEGEND_CUSTOM_TYPE,
			content,
			false,
			{ cumulative: true, record },
			new Date(0).toISOString(),
		);
		const carried = transientRecordMessageOf(hostTransient);
		if (carried !== undefined) this.frameLegendDigests.add(legendDigest(content));
		return carried;
	}

	/** The legend budget: the legend characters actually sent against the characters the aliases saved. */
	getAliasEconomics(): { legendChars: number; savedChars: number; paused: boolean } {
		const byId = new Map(this.table.entries.map((entry) => [entry.id, entry] as const));
		let savedChars = 0;
		for (const id of this.legendIds) {
			const entry = byId.get(id);
			if (!entry) continue;
			savedChars += (this.mentionsById.get(id) ?? 0) * Math.max(0, entry.path.length - entry.id.length);
		}
		return { legendChars: this.emittedLegendChars, savedChars, paused: this.mintingPaused };
	}

	private legendCostExceedsSavings(): boolean {
		if (this.emittedLegendChars === 0) return false;
		const economics = this.getAliasEconomics();
		// A floor keeps a young table minting (every alias starts at one mention); above it the
		// legend must have paid for itself or minting stops until the mentions catch up.
		return (
			economics.legendChars > LEGEND_BUDGET_FLOOR_CHARS &&
			economics.legendChars > LEGEND_BUDGET_MARGIN * economics.savedChars
		);
	}

	/**
	 * Render every text span through its frozen spelling, minting one only for spans not yet sent.
	 * Called several times per provider request (preview, projection, commit) and must return the
	 * same bytes each time; it does, because the freeze is resolved before the fresh rewrite.
	 */
	private createRenderFold(): PrefixFold<AgentMessage, RenderState> {
		return new PrefixFold<AgentMessage, RenderState>(
			() => ({ live: new Map(), rendered: [] }),
			(state, message) => this.renderMessage(state, message),
		);
	}

	/**
	 * One step of the render fold. A fresh fold reads the frozen spellings of the last render, so a diverged history keeps the
	 * bytes it already sent; the spellings of this render become the frozen ones once it returns.
	 */
	private renderMessage(state: RenderState, message: AgentMessage): void {
		// Host records pass through untouched. The legend defines the aliases: rewriting its own
		// text turned every alias display back into an alias. Every other host record (memory
		// evidence, goal context, skill context, the failure ledger) is sent raw as a fresh
		// transient before any alias pass and becomes durable afterwards; rendering it then changed
		// the bytes of an already-sent message (a skill record's base path, measured live), which
		// broke the cached prefix and disengaged the delta path on the very next request.
		if (message.role === "custom") {
			state.rendered.push(message);
			return;
		}
		const memo = this.rendered.get(message);
		if (memo) {
			// Its spellings stay live for any later message that repeats one of its spans.
			for (const [key, spelling] of memo.spellings) state.live.set(key, spelling);
			state.rendered.push(memo.message);
			return;
		}
		const spellings: Array<readonly [string, string]> = [];
		const [output] = rewriteAgentMessagesWith([message], (text) => {
			const key = createHash("sha256").update(text).digest("hex");
			const frozen = state.live.get(key) ?? this.frozenSpellings.get(key);
			const spelling = frozen ?? rewriteText(this.table, text);
			state.live.set(key, spelling);
			spellings.push([key, spelling]);
			return spelling;
		});
		const aliasIds = [...collectActiveAliasIds(collectMessageTexts([output!]))];
		for (const id of aliasIds) {
			this.legendIds.add(id);
			this.mentionsById.set(id, (this.mentionsById.get(id) ?? 0) + 1);
		}
		this.rendered.set(message, { message: output!, spellings, aliasIds });
		state.rendered.push(output!);
	}

	private renderFrozen(messages: readonly AgentMessage[]): AgentMessage[] {
		const state = this.renderFold.fold(messages);
		this.frozenSpellings = state.live;
		// The caller keeps the array it is handed (the sync result), so the fold's own output is never shared out.
		return state.rendered.slice();
	}

	private persistScanned(): void {
		if (this.pendingScanned.length === 0 || !this.store) return;
		this.store.insertScanned(this.pendingScanned);
		this.pendingScanned = [];
		this.scannedPersistedAt = Date.now();
	}

	close(): void {
		let failure: { error: unknown } | undefined;
		try {
			this.persistScanned();
		} catch (error) {
			failure = { error };
		}
		try {
			this.store?.close();
		} catch (error) {
			if (failure) throw new AggregateError([failure.error, error], "Path alias persistence and close failed");
			throw error;
		}
		this.store = undefined;
		this.records = [];
		this.loaded = false;
		this.rendered = new WeakMap();
		this.renderFold = this.createRenderFold();
		this.reservationHistoryScanned = false;
		this.scanned = new Set();
		this.pendingScanned = [];
		if (failure) throw failure.error;
	}

	private ensureLoaded(): void {
		const cwd = this.getCwd();
		if (this.loaded) {
			if (this.table.cwd !== cwd) {
				this.table = this.buildTableForCwd(cwd);
				this.rendered = new WeakMap();
				this.renderFold = this.createRenderFold();
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
		this.scanned = new Set(this.store.listScanned());
		// The persist interval counts from the load, so the first requests do not each write the mark.
		this.scannedPersistedAt = Date.now();
		this.loaded = true;
	}

	private buildTableForCwd(cwd: string): PathAliasTable {
		return {
			cwd,
			entries: this.records.map((record) => ({ id: record.id, path: displayPath(record.absolute, cwd) })),
			reservedIds: this.table.reservedIds ?? [],
		};
	}

	private scanFingerprint(message: AgentMessage): string {
		let fingerprint = this.scanFingerprints.get(message);
		if (fingerprint === undefined) {
			fingerprint = createHash("sha256")
				.update(JSON.stringify(collectMessageTexts([message])))
				.digest("hex");
			this.scanFingerprints.set(message, fingerprint);
		}
		return fingerprint;
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
