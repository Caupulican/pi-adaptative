import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isSessionIdentity, visitSessionEntriesAsync } from "../../kernel/session/session-manager.ts";
import type { TypeSafeUsageReceipt, UnresolvedUsageRequest } from "../review/system-one-review-port.ts";
import {
	isReceiptCount,
	isReceiptText,
	isSystemOneUsageRoute,
	MAX_RECEIPT_TEXT_CHARS,
	MAX_TYPESAFE_USAGE_RECEIPT_BYTES,
	parseAccountingOrigin,
	parseTypeSafeUsageReceipt,
} from "../review/typesafe-usage-receipt-codec.ts";
import {
	type AtomicFileLockOptions,
	isMissingFileError,
	withFileLockSync,
	writeFileAtomicSync,
} from "../util/atomic-file.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import {
	normalizedHeaderTimestamp,
	type SemanticUsageLedgerIdentity,
	type SemanticUsageLedgerPort,
	semanticUsageCanonicalDataMatches,
} from "./session-ledger-port.ts";
import { SEMANTIC_USAGE_CUSTOM_TYPE, semanticUsageReportOf } from "./usage-records.ts";

/**
 * Bounds of one session's pending usage journal. Upper bound of concurrent evaluations: scan 32 (code-duplicates.ts:310,
 * scaled at most 2x at :305), admission 4 jobs (settings-rules.ts:71), root tool execution 32 (settings-rules.ts:302),
 * and five workers (the former default concurrency) each running 32 tool calls: (32 + 4 + 32 + 5 * 32) evaluations x 3
 * responses (SYSTEM_ONE_RESPONSES_PER_EVALUATION) = 684, rounded up to 1024. The fleet may run more workers than five
 * (its room is computed, bounded only by `fleet.ceiling.running`); once the bound is reached, paid work is refused before
 * payment instead of growing unbounded.
 *
 * On disk the journal holds at most 1024 records within the derived encoded-receipt bound: every write is checked under the lock against the
 * merged document, and a write past either bound is refused as capacity (the record stays held in memory). In memory the
 * bound is 2048: a recovery adopts up to 1024 journal records beside up to 1024 obligations admitted while the journal was
 * unreadable. Neither set is dropped.
 */
export const SEMANTIC_USAGE_JOURNAL_MAX_RECORDS = 1024;
/** A codec-maximal receipt plus escaped reportId/createdAt and the journal record wrapper. */
export const SEMANTIC_USAGE_JOURNAL_MAX_RECORD_BYTES =
	MAX_TYPESAFE_USAGE_RECEIPT_BYTES + 2 * MAX_RECEIPT_TEXT_CHARS * 6 + 512;
export const SEMANTIC_USAGE_JOURNAL_MAX_CONFLICTS = 8;
const MAX_CORRUPT_EVIDENCE_SLOTS = 4;
const MAX_SIDECAR_BYTES =
	(SEMANTIC_USAGE_JOURNAL_MAX_RECORDS + SEMANTIC_USAGE_JOURNAL_MAX_CONFLICTS) *
		SEMANTIC_USAGE_JOURNAL_MAX_RECORD_BYTES +
	4 * 1024;
const MAX_SESSION_FILE_CHARS = 4096;
const MAX_SUMMARY_RECOVERY_JOBS = 256;
const MAX_ACTIVE_SUMMARY_RECOVERY_SCANS = 2;
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
	"unresolved",
] as const;
const RECORD_KEYS = ["reportId", "payload", "createdAt", "summarySpendPending", "canonicalConfirmed"] as const;
const CONFLICT_KEYS = ["reportId", "payload", "seenAt"] as const;

/** A held paid receipt: the record a retained obligation keeps until its identical row is confirmed. */
export interface JournalRecord {
	readonly reportId: string;
	readonly payload: TypeSafeUsageReceipt;
	readonly createdAt: string;
	/** Meter-bound summary spend still awaits durable shared-meter acknowledgment. */
	readonly summarySpendPending?: boolean;
	/** The matching canonical row was physically confirmed. */
	readonly canonicalConfirmed?: true;
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
	readonly unresolved?: readonly UnresolvedUsageRequest[];
}

export type SummarySpendReceiptRead =
	| {
			readonly kind: "known";
			readonly costUsd: number;
			readonly observedAtMs: number;
			readonly summarySpendPending: boolean;
	  }
	| { readonly kind: "unresolved" | "missing" | "unknown"; readonly reason?: string };

export type { UnresolvedUsageRequest } from "../review/system-one-review-port.ts";

export function parseUnresolvedUsageRequest(value: unknown): UnresolvedUsageRequest | undefined {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["requestId", "provider", "model", "route", "origin", "startedAt", "summarySpendPending"])
	)
		return undefined;
	const { requestId, provider, model, route, startedAt } = value;
	const origin = parseAccountingOrigin(value.origin);
	if (
		!isReceiptText(requestId) ||
		!isReceiptText(provider) ||
		!isReceiptText(model) ||
		!origin ||
		!isReceiptText(startedAt) ||
		!Number.isFinite(Date.parse(startedAt)) ||
		(route !== undefined && !isSystemOneUsageRoute(route)) ||
		(value.summarySpendPending !== undefined && value.summarySpendPending !== true) ||
		(value.summarySpendPending === true && route !== "history_summary")
	)
		return undefined;
	return {
		requestId,
		provider,
		model,
		...(route !== undefined ? { route } : {}),
		origin,
		startedAt,
		...(value.summarySpendPending === true ? { summarySpendPending: true } : {}),
	};
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
export interface JournalStandingOutcome {
	standing?: JournalRecord;
}

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
interface SummaryRecoveryJob {
	identity: SemanticUsageLedgerIdentity;
	request: UnresolvedUsageRequest;
	running: boolean;
	queued: boolean;
	failures: number;
	retryAt: number;
}
const summaryRecoveryJobs = new Map<string, SummaryRecoveryJob>();
const summaryRecoveryQueue: string[] = [];
let activeSummaryRecoveryScans = 0;

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

/** Materialize before taking the shared-meter identity, then prove it is still the bound durable journal slot. */
export function captureSummarySpendIdentity(
	ledger: SemanticUsageLedgerPort,
	bound: SemanticUsageLedgerIdentity,
	disposed: boolean,
): SemanticUsageLedgerIdentity {
	ledger.materialize();
	const identity = ledger.identity();
	if (
		disposed ||
		!identity.persisted ||
		!journalSlotOf(identity) ||
		identity.sessionId !== bound.sessionId ||
		identity.sessionFile !== bound.sessionFile ||
		identity.headerTimestamp !== bound.headerTimestamp ||
		identity.persisted !== bound.persisted ||
		ledger.persistenceUncertain()
	)
		throw new Error("Summary spend requires the same durable session identity");
	return { ...identity, persisted: true };
}

/** Whether two receipts are the same paid response, compared in their stored (JSON) form: a replay re-presents the same payload. */
export function samePayload(left: TypeSafeUsageReceipt, right: TypeSafeUsageReceipt): boolean {
	return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

export function requestMatchesReceipt(request: UnresolvedUsageRequest, receipt: TypeSafeUsageReceipt): boolean {
	return (
		request.provider === receipt.provider &&
		request.model === receipt.model &&
		request.route === receipt.route &&
		isDeepStrictEqual(request.origin, receipt.origin) &&
		(request.summarySpendPending !== true || receipt.summaryAccounting !== undefined)
	);
}

/** Removes one matching receipt and its matching unresolved identity, preserving every other journal obligation. */
export function withoutRecord(
	current: JournalDocument,
	reportId: string,
	payload: TypeSafeUsageReceipt,
	updatedAt: string,
): JournalDocument | undefined {
	const records = current.records.filter(
		(record) => record.reportId !== reportId || !samePayload(record.payload, payload),
	);
	const unresolved = current.unresolved?.filter(
		(request) => request.requestId !== reportId || !requestMatchesReceipt(request, payload),
	);
	if (!records.length && !current.conflicts.length && !current.droppedConflicts && !unresolved?.length)
		return undefined;
	if (records.length === current.records.length && unresolved?.length === current.unresolved?.length) return current;
	return { ...current, updatedAt, records, ...(unresolved ? { unresolved } : {}) };
}

export function emptyJournal(slot: JournalSlot, updatedAt: string): JournalDocument {
	return {
		version: 1,
		kind: "semantic-usage-pending",
		sessionId: slot.sessionId,
		sessionFile: slot.sessionFile,
		headerTimestamp: slot.headerTimestamp,
		updatedAt,
		records: [],
		conflicts: [],
		droppedConflicts: 0,
	};
}

export function withConflict(current: JournalDocument, conflict: JournalConflict): JournalDocument {
	if (current.conflicts.length >= SEMANTIC_USAGE_JOURNAL_MAX_CONFLICTS)
		return { ...current, updatedAt: conflict.seenAt, droppedConflicts: current.droppedConflicts + 1 };
	return { ...current, updatedAt: conflict.seenAt, conflicts: [...current.conflicts, conflict] };
}

/** The one idempotent retain operation; a replay preserves existing canonical and shared-meter proofs. */
export function retainRecordChange(
	slot: JournalSlot,
	record: JournalRecord,
	outcome: JournalStandingOutcome,
): JournalChange {
	return (current) => {
		const unresolved = current?.unresolved?.find((request) => request.requestId === record.reportId);
		if (unresolved && !requestMatchesReceipt(unresolved, record.payload))
			throw new SemanticUsageJournalError(
				"corrupt",
				"Usage settlement does not match its dispatched request identity",
			);
		if (unresolved && current)
			current = {
				...current,
				unresolved: current.unresolved!.filter((request) => request.requestId !== record.reportId),
			};
		const standing = current?.records.find((existing) => existing.reportId === record.reportId);
		if (current && standing) {
			if (samePayload(standing.payload, record.payload)) {
				const summarySpendPending = standing.summarySpendPending ?? record.summarySpendPending;
				const canonicalConfirmed = standing.canonicalConfirmed === true || record.canonicalConfirmed === true;
				if (summarySpendPending === false && canonicalConfirmed)
					return withoutRecord(current, record.reportId, record.payload, record.createdAt);
				if (
					summarySpendPending === standing.summarySpendPending &&
					canonicalConfirmed === (standing.canonicalConfirmed === true)
				)
					return current;
				return {
					...current,
					updatedAt: record.createdAt,
					records: current.records.map((existing) =>
						existing.reportId === record.reportId
							? {
									...existing,
									...(summarySpendPending !== undefined ? { summarySpendPending } : {}),
									...(canonicalConfirmed ? { canonicalConfirmed: true as const } : {}),
								}
							: existing,
					),
				};
			}
			outcome.standing = standing;
			return withConflict(current, { reportId: record.reportId, payload: record.payload, seenAt: record.createdAt });
		}
		const base = current ?? emptyJournal(slot, record.createdAt);
		return { ...base, updatedAt: record.createdAt, records: [...base.records, record] };
	};
}

/** Canonical proof removes a record only after spend acknowledgment; otherwise it persists the proof beside it. */
export function confirmCanonicalSummaryChange(reportId: string, payload: TypeSafeUsageReceipt): JournalChange {
	return (current) => {
		const standing = current?.records.find((record) => record.reportId === reportId);
		if (!current || !standing) return current;
		if (!samePayload(standing.payload, payload))
			throw new SemanticUsageJournalError("corrupt", "Canonical summary acknowledgment conflicts with its receipt");
		const updatedAt = new Date().toISOString();
		if (standing.summarySpendPending === false) return withoutRecord(current, reportId, payload, updatedAt);
		return {
			...current,
			updatedAt,
			records: current.records.map((record) =>
				record.reportId === reportId
					? { ...record, summarySpendPending: standing.summarySpendPending ?? true, canonicalConfirmed: true }
					: record,
			),
		};
	};
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
	if (
		(value.summarySpendPending !== undefined && typeof value.summarySpendPending !== "boolean") ||
		(value.canonicalConfirmed !== undefined && value.canonicalConfirmed !== true)
	)
		return undefined;
	const receipt = parseTypeSafeUsageReceipt(payload);
	if (!receipt || receipt.receiptId !== reportId) return undefined;
	if (
		(value.summarySpendPending !== undefined || value.canonicalConfirmed === true) &&
		(receipt.route !== "history_summary" || receipt.summaryAccounting === undefined)
	)
		return undefined;
	return {
		reportId,
		payload: receipt,
		createdAt,
		...(value.summarySpendPending !== undefined ? { summarySpendPending: value.summarySpendPending as boolean } : {}),
		...(value.canonicalConfirmed === true ? { canonicalConfirmed: true } : {}),
	};
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
	const unresolved = value.unresolved ?? [];
	if (!Array.isArray(unresolved) || unresolved.length + records.length > SEMANTIC_USAGE_JOURNAL_MAX_RECORDS)
		return undefined;
	const validUnresolved: UnresolvedUsageRequest[] = [];
	const validRecords: JournalRecord[] = [];
	const reportIds = new Set<string>();
	for (const item of records) {
		const record = validateRecord(item);
		// A duplicate identity is two answers for one obligation: the file is not a journal this owner can trust.
		if (!record || reportIds.has(record.reportId)) return undefined;
		reportIds.add(record.reportId);
		validRecords.push(record);
	}
	for (const item of unresolved) {
		const request = parseUnresolvedUsageRequest(item);
		if (!request || request.origin.sessionId !== sessionId || reportIds.has(request.requestId)) return undefined;
		reportIds.add(request.requestId);
		validUnresolved.push(request);
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
		...(validUnresolved.length ? { unresolved: validUnresolved } : {}),
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
		document.records.length + (document.unresolved?.length ?? 0) > SEMANTIC_USAGE_JOURNAL_MAX_RECORDS ||
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
			persistJournalChange(slot, change(current));
			return movedAside;
		},
		JOURNAL_LOCK_OPTIONS,
	);
}

/** Both journal policies publish the same bounded atomic change; their corrupt-input decisions remain separate. */
function persistJournalChange(slot: JournalSlot, next: JournalDocument | undefined): void {
	if (next === undefined) {
		try {
			unlinkSync(slot.path);
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
	} else writeFileAtomicSync(slot.path, serializeWithinBounds(next));
}

/** Strict journal update for the shared-meter ACK path: invalid evidence is returned as an error, never quarantined. */
function updateJournalStrict(slot: JournalSlot, change: JournalChange): void {
	withFileLockSync(
		slot.path,
		() => {
			const current = readJournal(slot);
			persistJournalChange(slot, change(current));
		},
		JOURNAL_LOCK_OPTIONS,
	);
}

function summarySpendState(
	document: JournalDocument | undefined,
	identity: SemanticUsageLedgerIdentity,
	receiptId: string,
): SummarySpendReceiptRead {
	if (!document) return { kind: "missing" };
	if (document.conflicts.some((conflict) => conflict.reportId === receiptId))
		return { kind: "unknown", reason: "receipt_conflict" };
	const record = document.records.find((candidate) => candidate.reportId === receiptId);
	if (record) {
		const { payload } = record;
		if (
			payload.receiptId !== receiptId ||
			payload.route !== "history_summary" ||
			payload.origin?.sessionId !== identity.sessionId ||
			payload.summaryAccounting === undefined ||
			typeof record.summarySpendPending !== "boolean"
		)
			return { kind: "unknown", reason: "receipt_identity_mismatch" };
		if (payload.priceKnown !== true) return { kind: "unknown", reason: "summary_price_unavailable" };
		return {
			kind: "known",
			costUsd: payload.usage.cost.total,
			observedAtMs: payload.summaryAccounting.observedAtMs,
			summarySpendPending: record.summarySpendPending,
		};
	}
	const unresolved = document.unresolved?.find((request) => request.requestId === receiptId);
	if (unresolved) {
		return unresolved.route === "history_summary" &&
			unresolved.summarySpendPending === true &&
			unresolved.origin.sessionId === identity.sessionId
			? { kind: "unresolved" }
			: { kind: "unknown", reason: "request_identity_mismatch" };
	}
	return { kind: "missing" };
}

/** Read one meter-bound summary receipt without changing or quarantining the sidecar. */
export function readSummarySpendReceipt(
	identity: SemanticUsageLedgerIdentity,
	receiptId: string,
): SummarySpendReceiptRead {
	const slot = journalSlotOf(identity);
	if (!slot || !isReceiptText(receiptId)) return { kind: "unknown", reason: "identity_unavailable" };
	try {
		return summarySpendState(readJournal(slot), identity, receiptId);
	} catch (error) {
		return {
			kind: "unknown",
			reason: error instanceof SemanticUsageJournalError ? error.reason : errorCodeOf(error),
		};
	}
}

async function scanCanonicalSummary(
	identity: SemanticUsageLedgerIdentity,
	request: UnresolvedUsageRequest,
): Promise<TypeSafeUsageReceipt> {
	const path = identity.sessionFile;
	if (!identity.persisted || !path) throw new Error("summary session is not persisted");
	let found: TypeSafeUsageReceipt | undefined;
	const header = await visitSessionEntriesAsync(
		path,
		() => true,
		(entry) => {
			if (entry.type !== "custom" || entry.customType !== SEMANTIC_USAGE_CUSTOM_TYPE || !isPlainRecord(entry.data))
				return;
			const { reportId, ...data } = entry.data;
			if (reportId !== request.requestId) return;
			if (!isReceiptText(entry.id))
				throw new SemanticUsageJournalError(
					"corrupt",
					"canonical summary row has an invalid session entry identity",
				);
			const receipt = parseTypeSafeUsageReceipt({ ...data, receiptId: reportId });
			if (!receipt || !requestMatchesReceipt(request, receipt))
				throw new SemanticUsageJournalError("corrupt", "canonical summary row conflicts with its reservation");
			const report = semanticUsageReportOf(receipt);
			if (!semanticUsageCanonicalDataMatches(entry.data, report))
				throw new SemanticUsageJournalError("corrupt", "canonical summary row does not match its receipt");
			if (found && !samePayload(found, receipt))
				throw new SemanticUsageJournalError("corrupt", "canonical summary rows conflict for this receipt");
			found = receipt;
		},
		{ requireComplete: true },
	);
	if (header.id !== identity.sessionId || normalizedHeaderTimestamp(header.timestamp) !== identity.headerTimestamp)
		throw new SemanticUsageJournalError("corrupt", "canonical summary file belongs to another session identity");
	if (!found) throw new SemanticUsageJournalError("unavailable", "canonical summary row is not available yet");
	return found;
}

async function recoverSummarySpend(
	identity: SemanticUsageLedgerIdentity,
	slot: JournalSlot,
	request: UnresolvedUsageRequest,
): Promise<void> {
	const receipt = await scanCanonicalSummary(identity, request);
	const record: JournalRecord = {
		reportId: receipt.receiptId,
		payload: receipt,
		createdAt: new Date().toISOString(),
		summarySpendPending: true,
		canonicalConfirmed: true,
	};
	updateJournalStrict(slot, (current) => {
		if (!current) return current;
		if (current.conflicts.some((conflict) => conflict.reportId === receipt.receiptId))
			throw new SemanticUsageJournalError("corrupt", "canonical summary recovery found a receipt conflict");
		const standing = current.records.find((candidate) => candidate.reportId === receipt.receiptId);
		const unresolved = current.unresolved?.find((candidate) => candidate.requestId === receipt.receiptId);
		if (standing && (!samePayload(standing.payload, receipt) || !requestMatchesReceipt(request, standing.payload)))
			throw new SemanticUsageJournalError(
				"corrupt",
				"canonical summary recovery conflicts with the standing receipt",
			);
		if (!standing && (!unresolved || !isDeepStrictEqual(unresolved, request))) return current;
		return retainRecordChange(slot, record, {})(current);
	});
}

function drainSummaryRecoveryQueue(): void {
	while (activeSummaryRecoveryScans < MAX_ACTIVE_SUMMARY_RECOVERY_SCANS && summaryRecoveryQueue.length > 0) {
		const key = summaryRecoveryQueue.shift()!;
		const job = summaryRecoveryJobs.get(key);
		if (!job || job.running || !job.queued) continue;
		job.queued = false;
		job.running = true;
		activeSummaryRecoveryScans += 1;
		const finish = (): void => {
			activeSummaryRecoveryScans -= 1;
			drainSummaryRecoveryQueue();
		};
		void recoverSummarySpend(job.identity, journalSlotOf(job.identity)!, job.request).then(
			() => {
				summaryRecoveryJobs.delete(key);
				finish();
			},
			() => {
				job.running = false;
				job.failures = Math.min(job.failures + 1, 7);
				job.retryAt = Date.now() + Math.min(1_000 * 2 ** (job.failures - 1), 60_000);
				finish();
			},
		);
	}
}

/** Queue one deduplicated recovery; strict scans run at low concurrency and durable state is observed by later reads. */
export function requestSummarySpendRecovery(identity: SemanticUsageLedgerIdentity, receiptId: string): void {
	const slot = journalSlotOf(identity);
	if (!slot || !isReceiptText(receiptId)) return;
	let request: UnresolvedUsageRequest | undefined;
	try {
		request = readJournal(slot)?.unresolved?.find((candidate) => candidate.requestId === receiptId);
	} catch {
		return;
	}
	if (request?.summarySpendPending !== true || request.route !== "history_summary") return;
	const key = createHash("sha256")
		.update(JSON.stringify([slot.path, slot.sessionId, slot.headerTimestamp, receiptId]))
		.digest("hex");
	const now = Date.now();
	const existing = summaryRecoveryJobs.get(key);
	if (existing?.running || existing?.queued || (existing && existing.retryAt > now)) return;
	for (const [candidateKey, state] of summaryRecoveryJobs) {
		if (!state.running && !state.queued && state.retryAt <= now) summaryRecoveryJobs.delete(candidateKey);
	}
	const job = existing ?? {
		identity: { ...identity },
		request,
		running: false,
		queued: false,
		failures: 0,
		retryAt: 0,
	};
	if (!existing && summaryRecoveryJobs.size >= MAX_SUMMARY_RECOVERY_JOBS) return;
	job.identity = { ...identity };
	job.request = request;
	job.queued = true;
	job.retryAt = 0;
	summaryRecoveryJobs.set(key, job);
	summaryRecoveryQueue.push(key);
	drainSummaryRecoveryQueue();
}

/** Acknowledge the exact shared-meter token, retaining the receipt until canonical row confirmation also exists. */
export function acknowledgeSummarySpend(identity: SemanticUsageLedgerIdentity, receiptId: string): void {
	const slot = journalSlotOf(identity);
	if (!slot || !isReceiptText(receiptId)) {
		throw new SemanticUsageJournalError("corrupt", "summary spend acknowledgment has no valid session identity");
	}
	updateJournalStrict(slot, (current) => {
		if (!current) return undefined;
		const state = summarySpendState(current, identity, receiptId);
		if (state.kind === "missing") return current;
		if (state.kind !== "known") {
			throw new SemanticUsageJournalError("corrupt", "summary spend acknowledgment does not match a known receipt");
		}
		const record = current.records.find((candidate) => candidate.reportId === receiptId)!;
		if (record.summarySpendPending === false) {
			return record.canonicalConfirmed === true
				? withoutRecord(current, receiptId, record.payload, new Date().toISOString())
				: current;
		}
		if (record.canonicalConfirmed === true)
			return withoutRecord(current, receiptId, record.payload, new Date().toISOString());
		return {
			...current,
			updatedAt: new Date().toISOString(),
			records: current.records.map((candidate) =>
				candidate.reportId === receiptId ? { ...candidate, summarySpendPending: false } : candidate,
			),
		};
	});
}

/** Retire only a meter-bound reservation proven to have had no provider response. */
export function cancelUndispatchedSummarySpend(identity: SemanticUsageLedgerIdentity, receiptId: string): void {
	const slot = journalSlotOf(identity);
	if (!slot || !isReceiptText(receiptId))
		throw new SemanticUsageJournalError("corrupt", "summary reservation has no valid session identity");
	updateJournalStrict(slot, (current) => {
		if (!current) return undefined;
		if (
			current.records.some((record) => record.reportId === receiptId) ||
			current.conflicts.some((conflict) => conflict.reportId === receiptId)
		)
			throw new SemanticUsageJournalError("corrupt", "a summary receipt prevents reservation cancellation");
		const request = current.unresolved?.find((item) => item.requestId === receiptId);
		if (!request) return current;
		if (
			request.route !== "history_summary" ||
			request.summarySpendPending !== true ||
			request.origin.sessionId !== identity.sessionId
		)
			throw new SemanticUsageJournalError("corrupt", "summary reservation identity does not match");
		const unresolved = current.unresolved!.filter((item) => item.requestId !== receiptId);
		if (!current.records.length && !current.conflicts.length && !current.droppedConflicts && !unresolved.length)
			return undefined;
		const { unresolved: _removed, ...rest } = current;
		return { ...rest, updatedAt: new Date().toISOString(), ...(unresolved.length ? { unresolved } : {}) };
	});
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
