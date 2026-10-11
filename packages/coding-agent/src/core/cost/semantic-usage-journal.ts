import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isSessionIdentity } from "../../kernel/session/session-manager.ts";
import type { TypeSafeUsageReceipt } from "../review/system-one-review-port.ts";
import { isReceiptCount, isReceiptText, parseTypeSafeUsageReceipt } from "../review/typesafe-usage-receipt-codec.ts";
import {
	type AtomicFileLockOptions,
	isMissingFileError,
	withFileLockSync,
	writeFileAtomicSync,
} from "../util/atomic-file.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import type { SemanticUsageLedgerIdentity } from "./session-ledger-port.ts";

/**
 * Bounds of one session's pending usage journal. Upper bound of concurrent evaluations: scan 32 (code-duplicates.ts:310,
 * scaled at most 2x at :305), admission 4 jobs (settings-rules.ts:71), root tool execution 32 (settings-rules.ts:302),
 * and five default workers (settings-schema.ts:321) each running 32 tool calls: (32 + 4 + 32 + 5 * 32) evaluations x 3
 * responses (SYSTEM_ONE_RESPONSES_PER_EVALUATION) = 684, rounded up to 1024. A worker `maxConcurrent` above its default
 * has no source ceiling; once the owner's bound is reached, paid work is refused before payment instead of growing unbounded.
 *
 * On disk the journal holds at most 1024 records and about 2.1 MB: every write is checked under the lock against the
 * merged document, and a write past either bound is refused as capacity (the record stays held in memory). In memory the
 * bound is 2048: a recovery adopts up to 1024 journal records beside up to 1024 obligations admitted while the journal was
 * unreadable. Neither set is dropped.
 */
export const SEMANTIC_USAGE_JOURNAL_MAX_RECORDS = 1024;
/** Fits the largest receipt the codec accepts: five identity texts at MAX_RECEIPT_TEXT_CHARS plus record fields. */
export const SEMANTIC_USAGE_JOURNAL_MAX_RECORD_BYTES = 2048;
export const SEMANTIC_USAGE_JOURNAL_MAX_CONFLICTS = 8;
const MAX_CORRUPT_EVIDENCE_SLOTS = 4;
const MAX_SIDECAR_BYTES =
	(SEMANTIC_USAGE_JOURNAL_MAX_RECORDS + SEMANTIC_USAGE_JOURNAL_MAX_CONFLICTS) *
		SEMANTIC_USAGE_JOURNAL_MAX_RECORD_BYTES +
	4 * 1024;
const MAX_SESSION_FILE_CHARS = 4096;
/**
 * Lock policy: at most four attempts, 5/10/20 ms apart, about 35 ms when the lock is held. That bound is POSIX only. On
 * win32 each sidecar write also retries its rename and its lock release (win32-transient-fs.ts: 9 retries, 10 to 200 ms),
 * up to about 1.1 s each: one write takes about 2.25 s at worst, and a paid response, which writes twice, about 4.5 s.
 */
const JOURNAL_LOCK_OPTIONS: AtomicFileLockOptions = { retries: 3, minRetryDelayMs: 5, maxRetryDelayMs: 20 };

const DOCUMENT_KEYS = [
	"version",
	"kind",
	"sessionId",
	"sessionFile",
	"headerTimestamp",
	"updatedAt",
	"records",
	"conflicts",
	"droppedConflicts",
] as const;
const RECORD_KEYS = ["reportId", "payload", "createdAt"] as const;
const CONFLICT_KEYS = ["reportId", "payload", "seenAt"] as const;

/** A held paid receipt: the record a retained obligation keeps until its identical row is confirmed. */
export interface JournalRecord {
	readonly reportId: string;
	readonly payload: TypeSafeUsageReceipt;
	readonly createdAt: string;
}

/** A conflicting payload kept as evidence next to the first record it contradicts. */
export interface JournalConflict {
	readonly reportId: string;
	readonly payload: TypeSafeUsageReceipt;
	readonly seenAt: string;
}

export interface JournalDocument {
	readonly version: 1;
	readonly kind: "semantic-usage-pending";
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly headerTimestamp?: string;
	readonly updatedAt: string;
	readonly records: readonly JournalRecord[];
	readonly conflicts: readonly JournalConflict[];
	readonly droppedConflicts: number;
}

/** The sidecar one session identity owns, and the identity its content must carry. */
export interface JournalSlot {
	readonly path: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	/** The normalized header timestamp of the identity (see the ledger port): written on every write and compared on every read. */
	readonly headerTimestamp: string;
}

/** Maps the current document to the one to write, or `undefined` to remove the sidecar. */
export type JournalChange = (current: JournalDocument | undefined) => JournalDocument | undefined;

/**
 * Journal storage that cannot be used: `unavailable` when it cannot be read, `corrupt` when its content is invalid or
 * belongs to another session identity, and `capacity` when a write would exceed the journal's bounds.
 */
export class SemanticUsageJournalError extends Error {
	readonly reason: "unavailable" | "corrupt" | "capacity";

	constructor(reason: "unavailable" | "corrupt" | "capacity", message: string) {
		super(message);
		this.name = "SemanticUsageJournalError";
		this.reason = reason;
	}
}

/**
 * Sidecar names stay under 160 characters, so the tmp, lock and evidence names derived from them stay under 255. A session id
 * can be as long as the header it is read from, so a long id or a long session file base name is not refused: the stem is
 * replaced by `h-<hash>` when the base name is long, and the token by its hash when it would overflow the name.
 * The name is only an address: the sidecar's content keeps the full session id, which is what readJournal verifies.
 */
const MAX_SIDECAR_NAME_CHARS = 160;
const MAX_STEM_CHARS = 96;
/** The kernel reads a session header within 64 KiB (`MAX_SESSION_HEADER_BYTES`), so no session id is longer than that. */
const SHORT_TOKEN = /^[0-9a-f]{24}$/;

function shortToken(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

/** The stem every sidecar of one session file shares: its base name, or a hash of it when the base name is long. */
function journalStemOf(sessionFile: string): string {
	const base = basename(sessionFile);
	return base.length <= MAX_STEM_CHARS ? base : `h-${shortToken(base)}`;
}

/** The sidecar name of one session identity: `<stem>.usage-pending.<token>.json`, with the id or its hash as the token. */
function journalNameOf(stem: string, sessionId: string): string {
	const full = `${stem}.usage-pending.${sessionId}.json`;
	const token = full.length <= MAX_SIDECAR_NAME_CHARS ? sessionId : shortToken(sessionId);
	return `${stem}.usage-pending.${token}.json`;
}

/**
 * The slot of a persisted session identity. Undefined for an in-memory session (no sidecar) and for a persisted session
 * whose id is not a safe file-name token: the owner tells those two apart by `identity.persisted`.
 */
export function journalSlotOf(identity: SemanticUsageLedgerIdentity): JournalSlot | undefined {
	if (!identity.persisted || identity.sessionFile === undefined) return undefined;
	const { sessionFile, sessionId, headerTimestamp } = identity;
	if (!isSessionIdentity(sessionId)) return undefined;
	return {
		path: join(dirname(sessionFile), journalNameOf(journalStemOf(sessionFile), sessionId)),
		sessionId,
		sessionFile,
		headerTimestamp,
	};
}

/** Whether two receipts are the same paid response, compared in their stored (JSON) form: a replay re-presents the same payload. */
export function samePayload(left: TypeSafeUsageReceipt, right: TypeSafeUsageReceipt): boolean {
	return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

export function journalRecordBytes(record: JournalRecord): number {
	return Buffer.byteLength(JSON.stringify(record));
}

export function errorCodeOf(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: "IO_ERROR";
}

function validateRecord(value: unknown): JournalRecord | undefined {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) return undefined;
	const { reportId, payload, createdAt } = value;
	if (!isReceiptText(reportId) || !isReceiptText(createdAt)) return undefined;
	const receipt = parseTypeSafeUsageReceipt(payload);
	if (!receipt || receipt.receiptId !== reportId) return undefined;
	return { reportId, payload: receipt, createdAt };
}

function validateConflict(value: unknown): JournalConflict | undefined {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, CONFLICT_KEYS)) return undefined;
	const { reportId, payload, seenAt } = value;
	if (!isReceiptText(reportId) || !isReceiptText(seenAt)) return undefined;
	const receipt = parseTypeSafeUsageReceipt(payload);
	if (!receipt || receipt.receiptId !== reportId) return undefined;
	return { reportId, payload: receipt, seenAt };
}

function validateDocument(value: unknown): JournalDocument | undefined {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, DOCUMENT_KEYS)) return undefined;
	const { version, kind, sessionId, sessionFile, headerTimestamp, updatedAt, records, conflicts, droppedConflicts } =
		value;
	if (version !== 1 || kind !== "semantic-usage-pending") return undefined;
	if (typeof sessionId !== "string" || !isSessionIdentity(sessionId)) return undefined;
	if (!isReceiptText(updatedAt) || !isReceiptCount(droppedConflicts)) return undefined;
	if (typeof sessionFile !== "string" || sessionFile.length === 0 || sessionFile.length > MAX_SESSION_FILE_CHARS) {
		return undefined;
	}
	if (headerTimestamp !== undefined && !isReceiptText(headerTimestamp)) return undefined;
	if (!Array.isArray(records) || records.length > SEMANTIC_USAGE_JOURNAL_MAX_RECORDS) return undefined;
	if (!Array.isArray(conflicts) || conflicts.length > SEMANTIC_USAGE_JOURNAL_MAX_CONFLICTS) return undefined;
	const validRecords: JournalRecord[] = [];
	const reportIds = new Set<string>();
	for (const item of records) {
		const record = validateRecord(item);
		// A duplicate identity is two answers for one obligation: the file is not a journal this owner can trust.
		if (!record || reportIds.has(record.reportId)) return undefined;
		reportIds.add(record.reportId);
		validRecords.push(record);
	}
	const validConflicts: JournalConflict[] = [];
	for (const item of conflicts) {
		const conflict = validateConflict(item);
		if (!conflict) return undefined;
		validConflicts.push(conflict);
	}
	return {
		version: 1,
		kind: "semantic-usage-pending",
		sessionId,
		sessionFile,
		...(headerTimestamp !== undefined ? { headerTimestamp } : {}),
		updatedAt,
		records: validRecords,
		conflicts: validConflicts,
		droppedConflicts,
	};
}

/**
 * Read one identity's sidecar: `undefined` when absent. Throws `unavailable` when the file cannot be read, and `corrupt`
 * when its content is not a valid journal or belongs to another session identity (that content is evidence, never imported).
 */
export function readJournal(slot: JournalSlot): JournalDocument | undefined {
	let text: string;
	try {
		if (statSync(slot.path).size > MAX_SIDECAR_BYTES) {
			throw new SemanticUsageJournalError("corrupt", "usage journal is corrupt: exceeds its size bound");
		}
		text = readFileSync(slot.path, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		if (error instanceof SemanticUsageJournalError) throw error;
		throw new SemanticUsageJournalError("unavailable", `usage journal read failed: ${errorCodeOf(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new SemanticUsageJournalError("corrupt", "usage journal is corrupt: not valid JSON");
	}
	const document = validateDocument(parsed);
	if (!document) throw new SemanticUsageJournalError("corrupt", "usage journal is corrupt: does not match its schema");
	// The sidecar location already binds the file to its session file; the session id and header timestamp bind the content.
	if (document.sessionId !== slot.sessionId || document.headerTimestamp !== slot.headerTimestamp) {
		throw new SemanticUsageJournalError("corrupt", "usage journal belongs to another session identity");
	}
	return document;
}

/** Keep corrupt content as evidence under the first free `.corrupt.N` slot; evidence is never overwritten. */
function moveCorruptJournalAside(path: string): string {
	for (let slot = 1; slot <= MAX_CORRUPT_EVIDENCE_SLOTS; slot++) {
		const target = `${path}.corrupt.${slot}`;
		if (existsSync(target)) continue;
		try {
			renameSync(path, target);
		} catch (error) {
			throw new SemanticUsageJournalError(
				"corrupt",
				`usage journal evidence could not be moved aside: ${errorCodeOf(error)}`,
			);
		}
		return target;
	}
	throw new SemanticUsageJournalError("corrupt", "every usage journal evidence slot is taken");
}

/** The bounds are checked on the merged document, under the lock, so nothing is written that readJournal would reject. */
function serializeWithinBounds(document: JournalDocument): string {
	if (
		document.records.length > SEMANTIC_USAGE_JOURNAL_MAX_RECORDS ||
		document.conflicts.length > SEMANTIC_USAGE_JOURNAL_MAX_CONFLICTS
	) {
		throw new SemanticUsageJournalError("capacity", "usage journal is full");
	}
	const text = `${JSON.stringify(document)}\n`;
	if (Buffer.byteLength(text) > MAX_SIDECAR_BYTES) {
		throw new SemanticUsageJournalError("capacity", "usage journal would exceed its size bound");
	}
	return text;
}

/**
 * Read-modify-write one sidecar under its lock: `change` receives the current document (corrupt content moved aside
 * first) and returns the document to write, or `undefined` to remove the file. Returns the evidence path when corrupt
 * content was moved aside. Throws when the sidecar cannot be read, preserved, bounded or written.
 */
export function updateJournal(slot: JournalSlot, change: JournalChange): string | undefined {
	return withFileLockSync(
		slot.path,
		() => {
			let current: JournalDocument | undefined;
			let movedAside: string | undefined;
			try {
				current = readJournal(slot);
			} catch (error) {
				if (!(error instanceof SemanticUsageJournalError) || error.reason !== "corrupt") throw error;
				movedAside = moveCorruptJournalAside(slot.path);
			}
			const next = change(current);
			if (next === undefined) {
				try {
					unlinkSync(slot.path);
				} catch (error) {
					if (!isMissingFileError(error)) throw error;
				}
			} else {
				writeFileAtomicSync(slot.path, serializeWithinBounds(next));
			}
			return movedAside;
		},
		JOURNAL_LOCK_OPTIONS,
	);
}

/**
 * Every usage-journal artifact beside one session file: sidecars of any identity, their `.lock` directories and their
 * `.corrupt.N` evidence. Removed together with the session file, so no sidecar outlives the file it records into. Throws
 * `unavailable` when the directory cannot be listed.
 */
export function sessionJournalPaths(sessionFile: string): string[] {
	const prefix = `${journalStemOf(sessionFile)}.usage-pending.`;
	let names: string[];
	try {
		names = readdirSync(dirname(sessionFile));
	} catch (error) {
		if (isMissingFileError(error)) return [];
		throw new SemanticUsageJournalError("unavailable", `usage journal directory read failed: ${errorCodeOf(error)}`);
	}
	// readdir order is the platform's: sorted, so every listing (the unmatched warning included) reads the same on any disk.
	return names
		.filter((name) => name.startsWith(prefix))
		.sort()
		.map((name) => join(dirname(sessionFile), name));
}

/**
 * Sidecars of other session identities beside this session file: unmatched evidence, never this session's. Throws
 * `unavailable` when the directory cannot be listed.
 */
export function foreignJournalPaths(sessionFile: string, sessionId: string): string[] {
	const stem = journalStemOf(sessionFile);
	const prefix = `${stem}.usage-pending.`;
	const own = journalNameOf(stem, sessionId);
	// A token is a session id or a hashed one; any other name names no identity this owner can account for, so it is never reported.
	return sessionJournalPaths(sessionFile).filter((path) => {
		const name = basename(path);
		if (name === own || !name.endsWith(".json")) return false;
		const token = name.slice(prefix.length, -".json".length);
		return isSessionIdentity(token) || SHORT_TOKEN.test(token);
	});
}
