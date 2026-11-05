/** Original-owner evidence shared by reflection and durable knowledge learning. */
import { createHash } from "node:crypto";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import {
	appendSessionSnapshot,
	decodeSessionSnapshotPayload,
	getSessionSnapshots,
	type SessionSnapshotCodec,
} from "../session-snapshot.ts";

/**
 * Durable mark that one persisted user message was genuine owner input (typed or sent by the
 * operator through the session's prompt boundary), not an internal prompt, an extension message,
 * a worker report, a tool result or recalled text. The record retains the original words independently
 * of the transformed message it names, so the ledger is rebuilt from the branch after a restart
 * and survives compaction (custom entries are not messages).
 */
export const OWNER_EVIDENCE_CUSTOM_TYPE = "owner_evidence";

export interface OwnerEvidenceRecord {
	/** Full source session identity. Old records without it cannot supply canonical knowledge citations. */
	sessionId?: string;
	/** `<origin session id>/<session entry id>`; older records used a session prefix. */
	sourceId: string;
	entryId: string;
	/**
	 * The owner's ORIGINAL words: what they typed before any input transform, skill or
	 * template expansion rewrote the message the model received. Never reconstructed from the
	 * persisted message content.
	 */
	text: string;
	/** sha256 prefix of `text` as stored; a record whose text does not match on load is dropped. */
	digest: string;
	/** Length of the full original input. Older records may contain only its first 4,000 characters. */
	chars: number;
	createdAt: string;
}

export interface OwnerEvidenceEntry
	extends Pick<OwnerEvidenceRecord, "sessionId" | "sourceId" | "entryId" | "createdAt" | "text"> {}

const MAX_OWNER_EVIDENCE_ENTRIES = 64;
/** Legacy reflection gets a small preview; collection pages through the original independently. */
export const OWNER_EVIDENCE_PAGE_CHARS = 4_000;

export interface OwnerEvidenceCursor {
	/** Canonical custom-entry identity, so two branches never silently rebind a cursor. */
	recordId: string;
	offset: number;
}

export interface OwnerEvidencePage {
	recordId: string;
	source: Omit<OwnerEvidenceRecord, "text">;
	offset: number;
	text: string;
	/** False for older truncated records; their available prefix cannot acknowledge the full input. */
	completeSource: boolean;
	next?: OwnerEvidenceCursor;
}

/** A bounded collection cursor lists identities and full digests without copying original input. */
export interface OwnerEvidenceDescriptor {
	readonly recordId: string;
	readonly sourceId: string;
	readonly sessionId: string | undefined;
	readonly digest: string;
	readonly createdAt: string;
	readonly chars: number;
	readonly complete: boolean;
}

function evidenceTextDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Shape and integrity: the stored words must carry the digest they were recorded with. */
function isOwnerEvidenceRecord(value: unknown): value is OwnerEvidenceRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		(record.sessionId === undefined ||
			(typeof record.sessionId === "string" &&
				record.sessionId.length > 0 &&
				record.sessionId.length <= 200 &&
				record.sourceId === `${record.sessionId}/${record.entryId}`)) &&
		typeof record.sourceId === "string" &&
		record.sourceId.length > 0 &&
		typeof record.entryId === "string" &&
		typeof record.text === "string" &&
		typeof record.digest === "string" &&
		record.digest === evidenceTextDigest(record.text) &&
		typeof record.chars === "number" &&
		Number.isSafeInteger(record.chars) &&
		record.chars >= record.text.length &&
		typeof record.createdAt === "string" &&
		Number.isFinite(Date.parse(record.createdAt)) &&
		new Date(record.createdAt).toISOString() === record.createdAt
	);
}

const OWNER_EVIDENCE_CODEC: SessionSnapshotCodec<OwnerEvidenceRecord, "evidence"> = {
	customType: OWNER_EVIDENCE_CUSTOM_TYPE,
	valueKey: "evidence",
	isValue: isOwnerEvidenceRecord,
	clone: (record) => ({ ...record }),
};

export function getOwnerEvidenceSnapshots(entries: readonly SessionEntry[]): OwnerEvidenceRecord[] {
	return getSessionSnapshots(entries, OWNER_EVIDENCE_CODEC);
}

/** Lowercase, plain quotes, collapsed horizontal whitespace; newlines are kept so line structure survives. */
function normalizeQuoteText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+/g, " ").trim())
		.join("\n");
}

/**
 * Whether a span of the owner's text is text the owner SHOWED rather than said: inside quotation
 * marks or backticks, inside a fenced block, or on a blockquote line. A pasted excerpt is evidence
 * of what the owner showed, never automatically of what they believe; this is the host's
 * deterministic half of that judgment. The semantic half stays model work.
 */
function isShownSpan(haystack: string, start: number, end: number): boolean {
	const before = haystack.slice(0, start);
	const fences = (before.match(/```/g) ?? []).length;
	if ((fences & 1) === 1) return true;
	const inlineTicks = (before.replace(/```/g, "").match(/`/g) ?? []).length;
	if ((inlineTicks & 1) === 1) return true;
	if (((before.match(/"/g) ?? []).length & 1) === 1) return true;
	// Blockquote: any line the span touches starts with ">".
	let lineStart = before.lastIndexOf("\n") + 1;
	while (lineStart <= end && lineStart < haystack.length) {
		if (haystack.slice(lineStart).startsWith(">")) return true;
		const next = haystack.indexOf("\n", lineStart);
		if (next < 0) break;
		lineStart = next + 1;
	}
	return false;
}

/**
 * Where a cited quote sits in the owner's words. Every occurrence is tried: a quote that appears
 * first inside shown text and later as the owner's own statement is found as stated. Returns the
 * sentence around the first stated occurrence for the explicit/corrective wording check.
 */
export function locateOwnerQuote(
	ownerText: string,
	quote: string,
): { found: boolean; shown: boolean; sentence: string } {
	const haystack = normalizeQuoteText(ownerText);
	const needle = normalizeQuoteText(quote)
		.replace(/\n/g, " ")
		.replace(/^["'`]+|["'`.,;:!?]+$/g, "");
	if (needle.length === 0) return { found: false, shown: false, sentence: "" };
	// Newlines count as spaces for matching only; positions are preserved one to one.
	const flat = haystack.replace(/\n/g, " ");
	let index = flat.indexOf(needle);
	let sawShown = false;
	while (index >= 0) {
		const end = index + needle.length;
		if (!isShownSpan(haystack, index, end)) {
			const before = haystack.slice(0, index);
			const sentenceStart =
				Math.max(
					before.lastIndexOf("."),
					before.lastIndexOf("!"),
					before.lastIndexOf("?"),
					before.lastIndexOf("\n"),
				) + 1;
			const after = haystack.slice(end);
			const stop = after.search(/[.!?\n]/);
			const sentenceEnd = stop < 0 ? haystack.length : end + stop;
			return { found: true, shown: false, sentence: haystack.slice(sentenceStart, sentenceEnd).trim() };
		}
		sawShown = true;
		index = flat.indexOf(needle, index + 1);
	}
	return { found: sawShown, shown: sawShown, sentence: "" };
}

interface OwnerEvidenceLedgerDeps {
	getSessionManager(): SessionManager;
	warn(message: string): void;
}

/** One branch-bound ledger; only the host's original-input persistence path can append evidence. */
export class OwnerEvidenceLedger {
	private readonly listeners = new Set<(change: "source" | "branch") => void>();
	private readonly deps: OwnerEvidenceLedgerDeps;
	private ownerEvidence: OwnerEvidenceEntry[] | undefined;
	/** Identity index follows the canonical branch; only the text projection is limited to 64 records. */
	private sourceEntries: Set<string> | undefined;
	private records: Array<{ recordId: string; record: OwnerEvidenceRecord; digest: string }> = [];
	private readonly byRecord = new Map<string, number>();
	private readonly bySource = new Map<string, number>();
	private readonly ownerInputOriginals = new WeakMap<AgentMessage, string>();

	constructor(deps: OwnerEvidenceLedgerDeps) {
		this.deps = deps;
	}

	/** Listeners only schedule work; they must not throw or mutate the ledger. */
	subscribe(listener: (change: "source" | "branch") => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	invalidate(): void {
		this.ownerEvidence = undefined;
		this.sourceEntries = undefined;
		this.records = [];
		this.byRecord.clear();
		this.bySource.clear();
		for (const listener of this.listeners) listener("branch");
	}

	/** The session admitted `message` as the operator's own input; `originalText` is what they typed. */
	markOwnerInput(message: AgentMessage, originalText: string): void {
		this.ownerInputOriginals.set(message, originalText);
	}

	/**
	 * Persistence hook: a message reached durable history under `entryId`. Owner evidence is
	 * recorded exactly here, with the original words; a withdrawn queued message is never
	 * persisted and therefore never becomes evidence. Non-owner messages are ignored.
	 */
	noteOwnerInputPersisted(message: AgentMessage, entryId: string | undefined): void {
		if (!entryId || message.role !== "user") return;
		const originalText = this.ownerInputOriginals.get(message);
		if (originalText === undefined || !originalText.trim()) return;
		if (this.recordOwnerEvidence(entryId, originalText)) this.ownerInputOriginals.delete(message);
	}

	/**
	 * Mark one persisted user message as genuine owner input and return its source id. Called by
	 * the session at the persistence boundary of a prompt that came through its own owner input
	 * path (never for internal, extension, worker, tool or recalled messages).
	 */
	private recordOwnerEvidence(entryId: string, originalText: string): boolean {
		const sessionId = this.deps.getSessionManager().getSessionId();
		const sourceId = `${sessionId}/${entryId}`;
		// Load before appending: a first read that scans the branch must not see this record twice.
		const ledger = this.loadOwnerEvidence();
		if (this.sourceEntries?.has(entryId)) return true;
		// Strictly increasing within the session, so evidence order is total even inside one millisecond.
		let createdAtMs = Date.now();
		const last = ledger.at(-1);
		if (last) {
			const lastMs = Date.parse(last.createdAt);
			if (Number.isFinite(lastMs) && createdAtMs <= lastMs) createdAtMs = lastMs + 1;
		}
		const createdAt = new Date(createdAtMs).toISOString();
		const text = originalText;
		const record: OwnerEvidenceRecord = {
			sessionId,
			sourceId,
			entryId,
			text,
			digest: evidenceTextDigest(text),
			chars: originalText.length,
			createdAt,
		};
		let recordId: string;
		try {
			recordId = appendSessionSnapshot(this.deps.getSessionManager(), OWNER_EVIDENCE_CODEC, record);
		} catch {
			this.deps.warn("Owner evidence could not be recorded durably for this turn.");
			return false;
		}
		this.sourceEntries?.add(entryId);
		this.indexRecord(recordId, record);
		ledger.push({ sessionId, sourceId, entryId, text: text.slice(0, OWNER_EVIDENCE_PAGE_CHARS), createdAt });
		if (ledger.length > MAX_OWNER_EVIDENCE_ENTRIES) ledger.splice(0, ledger.length - MAX_OWNER_EVIDENCE_ENTRIES);
		for (const listener of this.listeners) listener("source");
		return true;
	}

	/** The owner evidence this branch knows, oldest first, bounded. */
	listOwnerEvidence(): readonly OwnerEvidenceEntry[] {
		return this.loadOwnerEvidence().map((entry) => ({ ...entry }));
	}

	/**
	 * Read one bounded page from original owner input, oldest first, without the reflection cache's
	 * 64-source limit. A cursor names the exact custom entry and offset; a missing cursor is stale,
	 * never permission to start reading a different branch. No summaries or transformed messages enter.
	 */
	readPage(cursor?: OwnerEvidenceCursor): OwnerEvidencePage | undefined {
		if (cursor && (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0))
			throw new RangeError("Invalid owner evidence cursor");
		this.loadOwnerEvidence();
		const start = cursor ? this.byRecord.get(cursor.recordId) : 0;
		if (start === undefined) throw new Error("Owner evidence cursor is no longer on the active branch");
		for (let index = start; index < this.records.length; index++) {
			const { recordId, record } = this.records[index]!;
			const offset = index === start ? (cursor?.offset ?? 0) : 0;
			if (offset > record.text.length) throw new RangeError("Owner evidence cursor exceeds its original input");
			if (offset === record.text.length) continue;
			const text = record.text.slice(offset, offset + OWNER_EVIDENCE_PAGE_CHARS);
			const { text: _original, ...source } = record;
			return {
				recordId,
				source,
				offset,
				text,
				completeSource: record.chars === record.text.length,
				next: { recordId, offset: offset + text.length },
			};
		}
		return undefined;
	}

	/** Resolve a citation against the actual original input, never a reflection preview. */
	findSource(sourceId: string): OwnerEvidenceRecord | undefined {
		this.loadOwnerEvidence();
		const index = this.bySource.get(sourceId);
		return index === undefined ? undefined : { ...this.records[index]!.record };
	}

	/** Retain the last returned record id at the end; a later append is then visible without rescanning. */
	readSources(after?: string): readonly OwnerEvidenceDescriptor[] {
		this.loadOwnerEvidence();
		const previous = after === undefined ? -1 : this.byRecord.get(after);
		if (previous === undefined) throw new Error("Owner source cursor is no longer on the active branch");
		return this.records.slice(previous + 1, previous + 33).map(({ recordId, record, digest }) => ({
			recordId,
			sourceId: record.sourceId,
			sessionId: record.sessionId,
			digest,
			createdAt: record.createdAt,
			chars: record.chars,
			complete: record.chars === record.text.length,
		}));
	}

	private indexRecord(recordId: string, record: OwnerEvidenceRecord): void {
		this.byRecord.set(recordId, this.records.length);
		this.bySource.set(record.sourceId, this.records.length);
		this.records.push({ recordId, record, digest: createHash("sha256").update(record.text, "utf8").digest("hex") });
	}

	/**
	 * One pass over the branch on first use (then incremental through `recordOwnerEvidence`):
	 * owner marks retain original words alongside their source entry identity, so the
	 * ledger is identical after a reopen and unaffected by compaction.
	 */
	private loadOwnerEvidence(): OwnerEvidenceEntry[] {
		if (this.ownerEvidence) return this.ownerEvidence;
		const records: OwnerEvidenceEntry[] = [];
		const sourceEntries = new Set<string>();
		this.records = [];
		this.byRecord.clear();
		this.bySource.clear();
		const entries = this.deps.getSessionManager().getCustomEntriesOnBranch([OWNER_EVIDENCE_CUSTOM_TYPE]);
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== OWNER_EVIDENCE_CUSTOM_TYPE) continue;
			// The codec verifies shape and the stored digest; a tampered or legacy record is skipped.
			const record = decodeSessionSnapshotPayload(entry.data, OWNER_EVIDENCE_CODEC);
			if (!record || sourceEntries.has(record.entryId)) continue;
			sourceEntries.add(record.entryId);
			this.indexRecord(entry.id, record);
			records.push({
				...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
				sourceId: record.sourceId,
				entryId: record.entryId,
				text: record.text.slice(0, OWNER_EVIDENCE_PAGE_CHARS),
				createdAt: record.createdAt,
			});
			if (records.length > MAX_OWNER_EVIDENCE_ENTRIES) records.shift();
		}
		this.sourceEntries = sourceEntries;
		this.ownerEvidence = records;
		return this.ownerEvidence;
	}
}
