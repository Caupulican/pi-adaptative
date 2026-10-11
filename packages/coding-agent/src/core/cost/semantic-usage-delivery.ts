import { existsSync } from "node:fs";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import {
	SYSTEM_ONE_RESPONSES_PER_EVALUATION,
	type SystemOneUsageLease,
	type SystemOneUsageOutcome,
	SystemOneUsageRefusal,
	type SystemOneUsageSink,
	type TypeSafeUsageReceipt,
} from "../review/system-one-review-port.ts";
import { parseTypeSafeUsageReceipt } from "../review/typesafe-usage-receipt-codec.ts";
import {
	errorCodeOf,
	foreignJournalPaths,
	type JournalChange,
	type JournalConflict,
	type JournalDocument,
	type JournalRecord,
	type JournalSlot,
	journalRecordBytes,
	journalSlotOf,
	readJournal,
	SEMANTIC_USAGE_JOURNAL_MAX_CONFLICTS,
	SEMANTIC_USAGE_JOURNAL_MAX_RECORD_BYTES,
	SEMANTIC_USAGE_JOURNAL_MAX_RECORDS,
	SemanticUsageJournalError,
	samePayload,
	updateJournal,
} from "./semantic-usage-journal.ts";
import {
	createSessionManagerLedgerPort,
	normalizedReport,
	type SemanticUsageLedgerIdentity,
	type SemanticUsageLedgerPort,
} from "./session-ledger-port.ts";
import { type SemanticUsageReport, semanticUsageReportOf } from "./usage-records.ts";

/** Why a receipt stays owed: the write or read it waits on, or the lifetime of the owner it outlived. */
export type SemanticUsagePendingReason =
	| "deferred_first_reply"
	| "ledger_uncertain"
	| "ledger_unverified"
	| "foreign_binding"
	| "disposed";

/**
 * What became of one paid response's usage. Only `physically_recorded` confirms the spend in the session's ledger;
 * `durably_pending` keeps the receipt retained in this session's journal until its identical row is confirmed;
 * `unretained` leaves no durable copy here (the spend is disclosed, and an admission job keeps its own copy).
 */
export type SemanticUsageOutcome =
	| { readonly kind: "physically_recorded"; readonly scope: "ledger" | "process" }
	| { readonly kind: "durably_pending"; readonly reason: SemanticUsagePendingReason; readonly cause: string }
	| {
			readonly kind: "unretained";
			readonly reason:
				| "capacity"
				| "conflict"
				| "invalid_receipt"
				| "storage_refused"
				| "storage_corrupt"
				| "not_retained";
			readonly cause: string;
	  };

/** The held reports that the ledger may not carry yet. Readers exclude report ids their ledger already holds. */
export interface SemanticUsageProjection {
	/** Changes whenever the held set or the live identity binding changes, so a memoized reader can tell its totals are stale. */
	readonly revision: number;
	readonly reports: readonly SemanticUsageReport[];
}

export interface SemanticUsageSnapshot {
	/** Held reports with a copy in this session's journal and no confirmed row yet. */
	readonly retained: number;
	/** Held reports with no journal copy: their retention was refused, or waits for its retry. */
	readonly unretained: number;
	/** Confirmed rows whose journal copy is still in the sidecar; they are evidence and are not pending. */
	readonly confirmedUnremoved: number;
	/** Pending journals of other session identities beside this session file: evidence, never charged here. */
	readonly unmatched: readonly string[];
}

/** One session's usage owner: the reviewer's sink, admission's confirmation, and the session's pending journal. */
export interface SessionSemanticUsageDelivery extends SystemOneUsageSink {
	readonly disposed: boolean;
	/** Confirms one receipt for the admission path. Only `physically_recorded` is a confirmed row. */
	confirm(receipt: TypeSafeUsageReceipt): SemanticUsageOutcome;
	pendingProjection(): SemanticUsageProjection;
	snapshot(): SemanticUsageSnapshot;
	/** Binds the host's warning sink; warnings raised before the binding are delivered on it. */
	bindDiagnostics(warn: (message: string) => void): void;
	/** Attempts one last delivery, then releases the timers and listeners. The sidecar keeps what is not confirmed. */
	dispose(): void;
}

interface JournalFailure {
	readonly reason: "storage_refused" | "storage_corrupt" | "capacity" | "invalid_receipt";
	readonly cause: string;
}

interface HeldReceipt {
	readonly payload: TypeSafeUsageReceipt;
	readonly report: SemanticUsageReport;
	readonly createdAt: string;
	retained: boolean;
	/** False when the receipt has no journal copy by design (the record format or size bound, or an unsafe session id). */
	readonly journalable: boolean;
	retainFailure?: JournalFailure;
}

type CanonicalStep =
	| { readonly kind: "persisted" }
	| {
			readonly kind: "pending";
			readonly reason: "deferred_first_reply" | "ledger_uncertain" | "ledger_unverified";
			readonly cause: string;
	  }
	| { readonly kind: "conflict"; readonly cause: string };

/** The result of one retention attempt: retained, refused, or a different payload already stands for the identity. */
type RetainOutcome = "retained" | "conflict" | "failed";

/** The journal operations whose success or failure is tracked on its own: each recovers and warns independently. */
type JournalOperation = "read" | "retain" | "remove" | "quarantine" | "reconcile" | "ledger";
type WriteOperation = "retain" | "remove";

const CAUSE_MAX_CHARS = 200;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const MAX_BUFFERED_WARNINGS = 8;
const UNMATCHED_NAMES_IN_WARNING = 2;
const UNCERTAIN_LEDGER_CAUSE =
	"Session persistence state is uncertain after a failed write; the usage report stays pending in the session journal until a new session manager reads the file";
const UNSAFE_SESSION_ID_CAUSE = "the session id is not a safe file name for the usage journal";
const NOT_READY_CAUSE = "the usage journal is not ready; retention waits for it to recover";
const FULL_CAUSE = "usage journal is full";
const RECEIPT_CONFLICT_CAUSE = "a different usage report already exists for this receipt identity";
const JOURNAL_CONFLICT_CAUSE = "the session journal holds a different usage report with this identity";
const LEDGER_CONFLICT_CAUSE = "the session ledger holds a different usage report with this identity";
const ROW_CONFLICT_CAUSE = "the session file row at this identity differs from the usage report";
const PENDING_SUFFIX: Record<SemanticUsagePendingReason, string> = {
	deferred_first_reply: "it is retained and recorded when the session file is written",
	ledger_uncertain: "it is retained in the session journal and recorded when a new session manager reads the file",
	ledger_unverified: "it is kept in its session journal until the session file can be read to confirm it",
	foreign_binding: "it is kept in its session journal",
	disposed: "it is kept in its session journal",
};
const JOURNAL_REASON: Record<SemanticUsageJournalError["reason"], JournalFailure["reason"]> = {
	unavailable: "storage_refused",
	corrupt: "storage_corrupt",
	capacity: "capacity",
};

function boundedCause(text: string): string {
	const trimmed = text.trim() || "unknown error";
	return trimmed.length <= CAUSE_MAX_CHARS ? trimmed : trimmed.slice(0, CAUSE_MAX_CHARS);
}

function causeOf(error: unknown): string {
	return boundedCause(error instanceof Error ? error.message : String(error));
}

/** Classifies one journal failure. Raw error text (which carries paths) is reduced to the code. */
function classifyJournalFailure(error: unknown): JournalFailure {
	if (error instanceof SemanticUsageJournalError) {
		return { reason: JOURNAL_REASON[error.reason], cause: boundedCause(error.message) };
	}
	return { reason: "storage_refused", cause: boundedCause(`usage journal write failed: ${errorCodeOf(error)}`) };
}

function sameIdentity(left: SemanticUsageLedgerIdentity, right: SemanticUsageLedgerIdentity): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.sessionFile === right.sessionFile &&
		left.headerTimestamp === right.headerTimestamp &&
		left.persisted === right.persisted
	);
}

function emptyJournal(slot: JournalSlot, updatedAt: string): JournalDocument {
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

/** The record appended for a new identity. A repeated identity is handled by {@link recordChange}, never appended twice. */
function withRecord(current: JournalDocument | undefined, slot: JournalSlot, record: JournalRecord): JournalDocument {
	const base = current ?? emptyJournal(slot, record.createdAt);
	return { ...base, updatedAt: record.createdAt, records: [...base.records, record] };
}

/**
 * The journal change for one retained record. The first record of an identity stands: the same payload is the same
 * obligation (idempotent, nothing is appended), and a different payload is evidence beside the standing record, which
 * is reported through `outcome` so the caller can adopt it.
 */
function recordChange(slot: JournalSlot, record: JournalRecord, outcome: { standing?: JournalRecord }): JournalChange {
	return (current) => {
		const standing = current?.records.find((existing) => existing.reportId === record.reportId);
		if (current && standing) {
			if (samePayload(standing.payload, record.payload)) return current;
			outcome.standing = standing;
			return withConflict(current, { reportId: record.reportId, payload: record.payload, seenAt: record.createdAt });
		}
		return withRecord(current, slot, record);
	};
}

/**
 * Removes the record the payload names. A record of the same identity with another payload is another obligation and
 * stays: an acknowledgement never removes a different receipt's copy.
 */
function withoutRecord(
	current: JournalDocument,
	reportId: string,
	payload: TypeSafeUsageReceipt,
	updatedAt: string,
): JournalDocument | undefined {
	const records = current.records.filter(
		(record) => record.reportId !== reportId || !samePayload(record.payload, payload),
	);
	if (records.length === 0 && current.conflicts.length === 0 && current.droppedConflicts === 0) return undefined;
	if (records.length === current.records.length) return current;
	return { ...current, updatedAt, records };
}

function withConflict(current: JournalDocument, conflict: JournalConflict): JournalDocument {
	if (current.conflicts.length >= SEMANTIC_USAGE_JOURNAL_MAX_CONFLICTS) {
		return { ...current, updatedAt: conflict.seenAt, droppedConflicts: current.droppedConflicts + 1 };
	}
	return { ...current, updatedAt: conflict.seenAt, conflicts: [...current.conflicts, conflict] };
}

/**
 * Why a receipt has no journal copy: the journal's record format or size bound. These bounds belong to the journal only, so
 * such a receipt still gets its ledger row appended and verified; it is just never retained.
 */
function journalRefusalOf(receipt: TypeSafeUsageReceipt, record: JournalRecord): JournalFailure | undefined {
	if (parseTypeSafeUsageReceipt(receipt) === undefined) {
		return { reason: "invalid_receipt", cause: "the receipt is outside the usage record format" };
	}
	if (journalRecordBytes(record) > SEMANTIC_USAGE_JOURNAL_MAX_RECORD_BYTES) {
		return { reason: "capacity", cause: "the usage record exceeds its journal size bound" };
	}
	return undefined;
}

function standingEntry(record: JournalRecord): HeldReceipt {
	return {
		payload: record.payload,
		report: semanticUsageReportOf(record.payload),
		createdAt: record.createdAt,
		retained: true,
		journalable: true,
	};
}

function conflictWarning(cause: string): string {
	return `A System One usage receipt conflicts with a recorded report of the same identity (${cause}); its payload is kept as evidence.`;
}

/** Leases hand their unused slots back through this, so the owner's reservation count stays exact. */
interface LeaseOwner {
	recordLease(identity: SemanticUsageLedgerIdentity, receipt: TypeSafeUsageReceipt): SemanticUsageOutcome;
	returnSlots(count: number): void;
}

class SemanticUsageLease implements SystemOneUsageLease {
	private readonly owner: LeaseOwner;
	private readonly identity: SemanticUsageLedgerIdentity;
	private unused: number;
	private released = false;

	constructor(owner: LeaseOwner, identity: SemanticUsageLedgerIdentity, slots: number) {
		this.owner = owner;
		this.identity = identity;
		this.unused = slots;
	}

	record(receipt: TypeSafeUsageReceipt): SystemOneUsageOutcome {
		if (this.released) {
			return { kind: "unretained", cause: "the usage lease was released before its response was recorded" };
		}
		if (this.unused > 0) {
			this.unused -= 1;
			this.owner.returnSlots(1);
		}
		return this.owner.recordLease(this.identity, receipt);
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.owner.returnSlots(this.unused);
		this.unused = 0;
	}
}

/**
 * The single owner of one session manager's paid-usage delivery. Every paid response is retained in the session's
 * sidecar before its canonical row is appended, and its held record is released once the identical row is read back.
 * Journal writes are skipped while their operation is not ready; the ledger step never is. All state changes are
 * synchronous. Ledger listeners only schedule a microtask, and failed journal operations retry on one unref'd backoff
 * timer, which is also the only wake-up while the journal is failing.
 *
 * Bounds: the journal holds at most 1024 records on disk (refused as capacity past that). In memory the held set can reach
 * 2048: a recovery adopts up to 1024 journal records beside up to 1024 obligations admitted while the journal was unreadable.
 */
class SemanticUsageDelivery implements SessionSemanticUsageDelivery, LeaseOwner {
	private readonly ledger: SemanticUsageLedgerPort;
	private readonly bound: SemanticUsageLedgerIdentity;
	/** The bound identity's sidecar; undefined for an in-memory session or a persisted session whose id is not a safe name. */
	private readonly boundSlot: JournalSlot | undefined;
	private readonly held = new Map<string, HeldReceipt>();
	/** Confirmed rows whose journal copy is still in the sidecar, keyed by identity with the payload that copy names. */
	private readonly staleCopies = new Map<string, TypeSafeUsageReceipt>();
	private reserved = 0;
	private revision = 0;
	private projectionMatches = true;
	private fenceCause: string | undefined;
	/** Per operation, each recovers on its own: the sidecar was read, a retained record can be written, a removal can be written. */
	private loaded = false;
	private retainReady = true;
	private removeReady = true;
	/** The journal refused a record for capacity: no further record is written until a removal frees space or a pass starts. */
	private retainFull = false;
	/** Messages emitted per operation since that operation last succeeded: a failing operation warns once per distinct text. */
	private readonly warnedByOperation = new Map<JournalOperation, Set<string>>();
	private unmatched: string[] = [];
	private warnSink: ((message: string) => void) | undefined;
	private readonly bufferedWarnings: string[] = [];
	private droppedWarnings = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryDelayMs = RETRY_MIN_MS;
	private failedThisPass = false;
	private reconcileQueued = false;
	private unsubscribePersisted: (() => void) | undefined;
	private isDisposed = false;

	constructor(ledger: SemanticUsageLedgerPort) {
		this.ledger = ledger;
		this.bound = ledger.identity();
		this.boundSlot = journalSlotOf(this.bound);
		if (this.bound.persisted) this.unsubscribePersisted = ledger.onPersisted(() => this.scheduleReconcile());
		if (this.boundSlot !== undefined) this.listUnmatched(this.boundSlot);
		// Recovery runs before this owner can take any paid work. A persisted session with an unsafe id still gets the ledger
		// step (its rows are confirmed); it only has no journal copy.
		if (this.bound.persisted) this.runReconcile();
	}

	get disposed(): boolean {
		return this.isDisposed;
	}

	/**
	 * Paid work is refused once held plus reserved reaches 1022 (1024 minus one evaluation's three slots): the held set counts
	 * unretained reports too. Otherwise it refuses only when the owner has ended, or
	 * when the session identity moved on. An unreadable or unwritable journal never refuses: its receipts are disclosed as
	 * unretained, and the owner keeps retrying the journal.
	 */
	begin(): SystemOneUsageLease {
		if (this.isDisposed) {
			throw new SystemOneUsageRefusal(
				"System One usage cannot be recorded: the session has ended, so no evaluation starts",
			);
		}
		const identity = this.ledger.identity();
		if (!sameIdentity(identity, this.bound)) {
			throw new SystemOneUsageRefusal("System One usage cannot be recorded: the session identity changed");
		}
		if (this.held.size + this.reserved + SYSTEM_ONE_RESPONSES_PER_EVALUATION > SEMANTIC_USAGE_JOURNAL_MAX_RECORDS) {
			throw new SystemOneUsageRefusal(
				"System One usage journal is full: unconfirmed usage fills its bound, so no paid evaluation starts",
			);
		}
		this.reserved += SYSTEM_ONE_RESPONSES_PER_EVALUATION;
		return new SemanticUsageLease(this, identity, SYSTEM_ONE_RESPONSES_PER_EVALUATION);
	}

	returnSlots(count: number): void {
		this.reserved -= count;
	}

	recordLease(identity: SemanticUsageLedgerIdentity, receipt: TypeSafeUsageReceipt): SemanticUsageOutcome {
		let outcome: SemanticUsageOutcome;
		try {
			outcome = this.recordReceipt(identity, receipt);
		} catch (error) {
			outcome = this.unexpectedOutcome(receipt.receiptId, error);
		}
		// A conflict is reported where it is detected (W3); it is not a second, generic "could not be retained" warning.
		if (outcome.kind === "unretained" && outcome.reason === "conflict") return outcome;
		// Buffering before the first reply is the normal state of a new session, not a write failure.
		const isBuffered = outcome.kind === "durably_pending" && outcome.reason === "deferred_first_reply";
		if (outcome.kind !== "physically_recorded" && !isBuffered) this.warnUnrecorded(outcome);
		return outcome;
	}

	confirm(receipt: TypeSafeUsageReceipt): SemanticUsageOutcome {
		try {
			return this.confirmReceipt(receipt);
		} catch (error) {
			return this.unexpectedOutcome(receipt.receiptId, error);
		}
	}

	pendingProjection(): SemanticUsageProjection {
		// Held reports belong to the bound identity. Once the live session has moved on they are that identity's evidence,
		// not this session's spend, so they leave the projection (and the revision changes, so memoized totals refresh).
		const matches = sameIdentity(this.ledger.identity(), this.bound);
		if (matches !== this.projectionMatches) {
			this.projectionMatches = matches;
			this.revision += 1;
		}
		return {
			revision: this.revision,
			reports: matches ? [...this.held.values()].map((entry) => entry.report) : [],
		};
	}

	snapshot(): SemanticUsageSnapshot {
		let retained = 0;
		for (const entry of this.held.values()) if (entry.retained) retained += 1;
		return {
			retained,
			unretained: this.held.size - retained,
			confirmedUnremoved: this.staleCopies.size,
			unmatched: this.unmatched,
		};
	}

	bindDiagnostics(warn: (message: string) => void): void {
		this.warnSink = warn;
		for (const message of this.bufferedWarnings.splice(0)) warn(message);
		if (this.droppedWarnings > 0) {
			const count = this.droppedWarnings;
			this.droppedWarnings = 0;
			warn(
				count === 1
					? "1 usage-journal warning was dropped before diagnostics were bound"
					: `${count} usage-journal warnings were dropped before diagnostics were bound`,
			);
		}
	}

	dispose(): void {
		if (this.isDisposed) return;
		try {
			// One last attempt while the ledger is still live; anything still unconfirmed stays in the sidecar.
			this.runReconcile();
		} finally {
			this.isDisposed = true;
			this.unsubscribePersisted?.();
			this.unsubscribePersisted = undefined;
			if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
			this.retryTimer = undefined;
		}
		const snapshot = this.snapshot();
		const total = snapshot.retained + snapshot.unretained + snapshot.confirmedUnremoved + snapshot.unmatched.length;
		if (total === 0) return;
		// A session file that was never written can never record its buffered rows: the journal copy says so, plainly.
		const sessionFile = this.bound.sessionFile;
		const neverWritten = sessionFile !== undefined && !existsSync(sessionFile);
		const pending =
			neverWritten && snapshot.retained > 0
				? `${snapshot.retained} System One usage report(s) kept in the session journal for a session file that was never written, so they cannot be recorded`
				: `${snapshot.retained} System One usage report(s) pending in the session journal`;
		this.warn(
			`Session usage handoff: ${pending}, ${snapshot.unretained} not retained, ${snapshot.confirmedUnremoved} confirmed row(s) whose journal copy is not removed, ${snapshot.unmatched.length} unmatched journal(s) kept as evidence; none is charged to another session.`,
		);
	}

	private confirmReceipt(receipt: TypeSafeUsageReceipt): SemanticUsageOutcome {
		const known = this.held.get(receipt.receiptId);
		if (known) return this.deliverKnown(receipt, known);
		// Admission keeps its own copy of an unknown receipt. This owner holds none, so it only confirms or appends the row.
		const identity = this.ledger.identity();
		const report = semanticUsageReportOf(receipt);
		if (!identity.persisted) return this.appendInMemory(report);
		const slot = journalSlotOf(identity);
		if (this.isDisposed) {
			return {
				kind: "unretained",
				reason: "not_retained",
				cause: "the session has ended; this owner holds no copy of the receipt",
			};
		}
		if (!sameIdentity(identity, this.bound)) {
			return { kind: "unretained", reason: "storage_refused", cause: "the session identity changed" };
		}
		const step = this.canonicalStep(report);
		if (step.kind === "persisted") return { kind: "physically_recorded", scope: "ledger" };
		if (step.kind === "conflict") {
			this.warnConflict(step.cause);
			return { kind: "unretained", reason: "conflict", cause: step.cause };
		}
		if (slot === undefined) return { kind: "unretained", reason: "storage_refused", cause: UNSAFE_SESSION_ID_CAUSE };
		return {
			kind: "unretained",
			reason: "not_retained",
			cause: boundedCause(`${step.cause}; this owner holds no copy of the receipt, which the caller keeps`),
		};
	}

	private recordReceipt(identity: SemanticUsageLedgerIdentity, receipt: TypeSafeUsageReceipt): SemanticUsageOutcome {
		const report = semanticUsageReportOf(receipt);
		if (!identity.persisted) {
			return sameIdentity(identity, this.ledger.identity())
				? this.appendInMemory(report)
				: {
						kind: "unretained",
						reason: "storage_refused",
						cause: "the session identity changed before this usage was recorded",
					};
		}
		const slot = journalSlotOf(identity);
		const record: JournalRecord = {
			reportId: receipt.receiptId,
			payload: receipt,
			createdAt: new Date().toISOString(),
		};
		// Why this receipt has no journal copy, if it has none. The ledger row is never refused for it: only retention is skipped.
		const refusal = journalRefusalOf(receipt, record);
		// The lease's identity is judged against the live ledger: a session that has moved on never receives this usage.
		if (!sameIdentity(identity, this.ledger.identity())) {
			if (slot === undefined) {
				return {
					kind: "unretained",
					reason: "storage_refused",
					cause: "the session identity changed before this usage was recorded",
				};
			}
			if (refusal !== undefined) return { kind: "unretained", reason: refusal.reason, cause: refusal.cause };
			return this.recordForeign(slot, record);
		}
		const known = this.held.get(receipt.receiptId);
		if (known) return this.deliverKnown(receipt, known);
		const entry: HeldReceipt = {
			payload: receipt,
			report,
			createdAt: record.createdAt,
			retained: false,
			journalable: slot !== undefined && refusal === undefined,
			...(refusal !== undefined ? { retainFailure: refusal } : {}),
		};
		this.held.set(receipt.receiptId, entry);
		this.revision += 1;
		return this.deliverHeld(receipt.receiptId, entry);
	}

	/** A receipt already held under its identity: the same payload is the same obligation; a different payload is evidence. */
	private deliverKnown(receipt: TypeSafeUsageReceipt, known: HeldReceipt): SemanticUsageOutcome {
		if (!samePayload(known.payload, receipt)) return this.conflict(receipt);
		return this.deliverHeld(receipt.receiptId, known);
	}

	/** A late response whose session identity has changed: retained to its own identity's journal only, never delivered here. */
	private recordForeign(slot: JournalSlot, record: JournalRecord): SemanticUsageOutcome {
		const outcome: { standing?: JournalRecord } = {};
		try {
			const movedAside = updateJournal(slot, recordChange(slot, record, outcome));
			if (movedAside !== undefined) {
				this.warn(
					`The session's usage journal was corrupt and is preserved at ${basename(movedAside)}; its reports are not recovered automatically.`,
				);
				// Only the bound sidecar's own content is this owner's copy; another identity's file leaves the held state alone.
				if (this.boundSlot !== undefined && slot.path === this.boundSlot.path) this.evidenceMoved(undefined);
			}
		} catch (error) {
			const failure = classifyJournalFailure(error);
			return { kind: "unretained", reason: failure.reason, cause: failure.cause };
		}
		if (outcome.standing) {
			this.warnConflict(JOURNAL_CONFLICT_CAUSE);
			return { kind: "unretained", reason: "conflict", cause: JOURNAL_CONFLICT_CAUSE };
		}
		return {
			kind: "durably_pending",
			reason: "foreign_binding",
			cause: "the session identity changed before this usage was recorded; it stays with its original session file",
		};
	}

	/**
	 * Canonical delivery for a held entry: retain first when the journal can write, then the ledger step (always), then
	 * release the held record once its identical row is read back.
	 */
	private deliverHeld(reportId: string, entry: HeldReceipt): SemanticUsageOutcome {
		const slot = this.boundSlot;
		if (!entry.retained && entry.journalable && slot !== undefined) {
			// A different payload already stands for this identity in the journal: that record is the obligation, this one is evidence.
			if (this.retainOrWait(entry, slot) === "conflict") {
				return { kind: "unretained", reason: "conflict", cause: JOURNAL_CONFLICT_CAUSE };
			}
		}
		if (this.isDisposed) {
			return this.pendingOutcome(
				entry,
				"disposed",
				"the session has ended; the report stays in its session journal",
			);
		}
		if (!sameIdentity(this.ledger.identity(), this.bound)) {
			return this.pendingOutcome(
				entry,
				"foreign_binding",
				"the session identity changed; the report stays with its original session file",
			);
		}
		const step = this.canonicalStep(entry.report);
		if (step.kind === "persisted") {
			this.acknowledge(reportId, entry);
			return { kind: "physically_recorded", scope: "ledger" };
		}
		if (step.kind === "conflict") {
			this.resolveConflict(reportId, entry, step.cause);
			return { kind: "unretained", reason: "conflict", cause: step.cause };
		}
		return this.pendingOutcome(entry, step.reason, step.cause);
	}

	/**
	 * Retention is one journal write. While the sidecar is unread, its retain operation is failing, or the journal is full,
	 * it is not attempted per response (each attempt can block on a locked file): the entry stays held, and the retry retains
	 * it once the journal can take it.
	 */
	private retainOrWait(entry: HeldReceipt, slot: JournalSlot): RetainOutcome | "waiting" {
		if (!this.loaded || !this.retainReady) {
			entry.retainFailure = { reason: "storage_refused", cause: NOT_READY_CAUSE };
			return "waiting";
		}
		if (this.retainFull) {
			entry.retainFailure = { reason: "capacity", cause: FULL_CAUSE };
			return "waiting";
		}
		return this.retain(entry, slot);
	}

	/** One ledger step: the existing canonical row, or one append, then the physical read-back of that row. */
	private canonicalStep(report: SemanticUsageReport): CanonicalStep {
		// A fence this owner did not cause (another entry's failed write) is learned here, on the next step.
		if (this.ledger.persistenceUncertain()) this.noteLedgerFence(report.reportId);
		const existing = this.ledger.findCanonical(report.reportId);
		let entryId: string;
		if (existing) {
			if (!isDeepStrictEqual(normalizedReport(existing.data), normalizedReport(report))) {
				return { kind: "conflict", cause: LEDGER_CONFLICT_CAUSE };
			}
			entryId = existing.entryId;
		} else {
			if (this.fenceCause !== undefined) {
				return { kind: "pending", reason: "ledger_uncertain", cause: this.fenceCause };
			}
			try {
				entryId = this.ledger.append(report);
			} catch (error) {
				// The kernel fences the manager on the first failed write: nothing more is appended to this file.
				this.noteLedgerFence(report.reportId);
				return { kind: "pending", reason: "ledger_uncertain", cause: causeOf(error) };
			}
		}
		let state: "persisted" | "pending" | "conflict";
		try {
			state = this.ledger.physicalState(entryId, report);
		} catch (error) {
			// The row is in the ledger, but the session file could not be read to confirm it: it stays owed until a retry reads.
			this.scheduleRetry();
			return {
				kind: "pending",
				reason: "ledger_unverified",
				cause: boundedCause(`the session file could not be read to confirm the row (${errorCodeOf(error)})`),
			};
		}
		if (state === "persisted") return { kind: "persisted" };
		if (state === "conflict") return { kind: "conflict", cause: ROW_CONFLICT_CAUSE };
		// A fenced manager never writes the buffered row either: the fence, not the missing first reply, is what holds it.
		if (this.fenceCause !== undefined) return { kind: "pending", reason: "ledger_uncertain", cause: this.fenceCause };
		return {
			kind: "pending",
			reason: "deferred_first_reply",
			cause: "the usage row is buffered until the first reply is written",
		};
	}

	/** Append-only delivery for a session that writes no file: there is no sidecar and no physical row to confirm. */
	private appendInMemory(report: SemanticUsageReport): SemanticUsageOutcome {
		if (this.isDisposed) return { kind: "unretained", reason: "storage_refused", cause: "the session has ended" };
		try {
			const existing = this.ledger.findCanonical(report.reportId);
			if (existing) {
				if (!isDeepStrictEqual(normalizedReport(existing.data), normalizedReport(report))) {
					this.warnConflict(LEDGER_CONFLICT_CAUSE);
					return { kind: "unretained", reason: "conflict", cause: LEDGER_CONFLICT_CAUSE };
				}
				return { kind: "physically_recorded", scope: "process" };
			}
			this.ledger.append(report);
			return { kind: "physically_recorded", scope: "process" };
		} catch (error) {
			return { kind: "unretained", reason: "storage_refused", cause: causeOf(error) };
		}
	}

	private retain(entry: HeldReceipt, slot: JournalSlot): RetainOutcome {
		const record: JournalRecord = {
			reportId: entry.report.reportId,
			payload: entry.payload,
			createdAt: entry.createdAt,
		};
		const outcome: { standing?: JournalRecord } = {};
		try {
			this.writeJournal("retain", slot, recordChange(slot, record, outcome), entry);
		} catch (error) {
			entry.retainFailure = this.failJournal("retain", error);
			return "failed";
		}
		if (outcome.standing) {
			// The standing record is the obligation for this identity; the newcomer's payload is already kept as evidence.
			this.held.set(record.reportId, standingEntry(outcome.standing));
			this.revision += 1;
			this.warnConflict(JOURNAL_CONFLICT_CAUSE);
			return "conflict";
		}
		entry.retained = true;
		entry.retainFailure = undefined;
		return "retained";
	}

	private pendingOutcome(entry: HeldReceipt, reason: SemanticUsagePendingReason, cause: string): SemanticUsageOutcome {
		if (entry.retained) return { kind: "durably_pending", reason, cause };
		// No journal at all (a persisted session whose id is not a safe file name): the ledger row decides, and only a pending
		// row is reported. A receipt the journal's format or bound refuses has its reason in retainFailure instead.
		if (this.boundSlot === undefined) {
			return { kind: "unretained", reason: "storage_refused", cause: UNSAFE_SESSION_ID_CAUSE };
		}
		const failure = entry.retainFailure ?? { reason: "storage_refused", cause: "retention was not attempted" };
		return {
			kind: "unretained",
			reason: failure.reason,
			cause: boundedCause(`${cause}; the report is not retained: ${failure.cause}`),
		};
	}

	/**
	 * The row is confirmed, so the held record is released now. Its journal copy is removed when the journal can write;
	 * until then it is a confirmed row's stale copy, counted as evidence and never as pending or not retained.
	 */
	private acknowledge(reportId: string, entry: HeldReceipt): void {
		this.held.delete(reportId);
		this.revision += 1;
		const slot = this.boundSlot;
		if (slot === undefined || !entry.retained) return;
		this.staleCopies.set(reportId, entry.payload);
		if (this.removeReady) this.removeCopy(slot, reportId, entry.payload);
	}

	private removeCopy(slot: JournalSlot, reportId: string, payload: TypeSafeUsageReceipt): void {
		try {
			this.writeJournal(
				"remove",
				slot,
				(current) =>
					current === undefined ? undefined : withoutRecord(current, reportId, payload, new Date().toISOString()),
				undefined,
			);
			this.staleCopies.delete(reportId);
		} catch (error) {
			const failure = this.failJournal("remove", error);
			this.warnOnce(
				"remove",
				`The session's usage journal could not be updated (${failure.cause}); its records are retried.`,
			);
		}
	}

	/** Retries stale copies in order; after a failed removal the rest wait, so a failing journal is not written per copy. */
	private removeStaleCopies(slot: JournalSlot): void {
		let attempted = false;
		for (const [reportId, payload] of [...this.staleCopies]) {
			if (attempted && !this.removeReady) break;
			attempted = true;
			this.removeCopy(slot, reportId, payload);
		}
	}

	/**
	 * A canonical row that differs from the held payload: the held payload is evidence and its own journal copy is removed;
	 * a different record standing in the journal for this identity is adopted, so its own delivery continues.
	 */
	private resolveConflict(reportId: string, entry: HeldReceipt, cause: string): void {
		const result = this.keepConflict(entry.payload, entry);
		if (!result.written) return;
		this.held.delete(reportId);
		if (result.standing) this.held.set(reportId, standingEntry(result.standing));
		this.revision += 1;
		this.warnConflict(cause);
	}

	private conflict(receipt: TypeSafeUsageReceipt): SemanticUsageOutcome {
		this.keepConflict(receipt, undefined);
		this.warnConflict(RECEIPT_CONFLICT_CAUSE);
		return { kind: "unretained", reason: "conflict", cause: RECEIPT_CONFLICT_CAUSE };
	}

	/**
	 * Writes one conflicting payload as evidence in the same journal write that removes the held record it contradicts (only
	 * its own copy: the held payload's journal record). Reports the standing record of another payload, if one holds the identity.
	 */
	private keepConflict(
		payload: TypeSafeUsageReceipt,
		held: HeldReceipt | undefined,
	): { written: boolean; standing?: JournalRecord } {
		const slot = this.boundSlot;
		if (slot === undefined) return { written: true };
		const seenAt = new Date().toISOString();
		const outcome: { standing?: JournalRecord } = {};
		const operation: WriteOperation = held === undefined ? "retain" : "remove";
		try {
			this.writeJournal(
				operation,
				slot,
				(current) => {
					const base = current ?? emptyJournal(slot, seenAt);
					const next =
						held === undefined
							? base
							: (withoutRecord(base, held.report.reportId, held.payload, seenAt) ?? emptyJournal(slot, seenAt));
					const standing = next.records.find((record) => record.reportId === payload.receiptId);
					if (standing && !samePayload(standing.payload, payload)) outcome.standing = standing;
					return withConflict(next, { reportId: payload.receiptId, payload, seenAt });
				},
				undefined,
			);
			return { written: true, standing: outcome.standing };
		} catch (error) {
			const failure = this.failJournal(operation, error);
			this.warnOnce(
				operation,
				`The session's usage journal could not be updated (${failure.cause}); its records are retried.`,
			);
			return { written: false };
		}
	}

	/**
	 * One journal write under its lock. A success recovers that write operation only. Corrupt content that is moved aside
	 * takes every other held record's journal copy with it, so those records are retained again into the fresh journal.
	 */
	private writeJournal(
		operation: WriteOperation,
		slot: JournalSlot,
		change: JournalChange,
		keep: HeldReceipt | undefined,
	): void {
		const movedAside = updateJournal(slot, change);
		if (operation === "retain") {
			this.retainReady = true;
		} else {
			this.removeReady = true;
			// A removal frees space: a record refused for capacity may now be written.
			this.retainFull = false;
		}
		this.operationRecovered(operation);
		if (movedAside === undefined) return;
		this.warn(
			`The session's usage journal was corrupt and is preserved at ${basename(movedAside)}; its reports are not recovered automatically.`,
		);
		this.evidenceMoved(keep);
	}

	/** The moved-aside copies went with the evidence: held records are retained again, and stale copies are simply gone. */
	private evidenceMoved(keep: HeldReceipt | undefined): void {
		for (const entry of this.held.values()) {
			// A receipt that never had a journal copy has nothing in the moved file to lose.
			if (entry === keep || !entry.journalable) continue;
			entry.retained = false;
			entry.retainFailure = undefined;
		}
		this.staleCopies.clear();
		this.scheduleReconcile();
	}

	/** Classifies one failed write. A capacity refusal holds further writes for the pass; any other failure marks that operation not ready and arms the retry. */
	private failJournal(operation: WriteOperation, error: unknown): JournalFailure {
		const failure = classifyJournalFailure(error);
		if (failure.reason === "capacity") {
			if (operation === "retain") this.retainFull = true;
			return failure;
		}
		if (operation === "retain") this.retainReady = false;
		else this.removeReady = false;
		this.scheduleRetry();
		return failure;
	}

	/** Other identities' sidecars beside this session file: unmatched evidence, listed once and never charged here. */
	private listUnmatched(slot: JournalSlot): void {
		let names: string[];
		try {
			names = foreignJournalPaths(slot.sessionFile, slot.sessionId).map((path) => basename(path));
		} catch (error) {
			this.warn(`${causeOf(error)}; other session identities' journals are not reported.`);
			return;
		}
		if (names.length === 0) return;
		this.unmatched = names;
		// The host bounds a warning to 500 characters; two names plus a count keep the whole message under that.
		const listed = names.slice(0, UNMATCHED_NAMES_IN_WARNING).join(", ");
		const more =
			names.length > UNMATCHED_NAMES_IN_WARNING ? ` and ${names.length - UNMATCHED_NAMES_IN_WARNING} more` : "";
		this.warn(
			`${names.length} pending usage journal(s) from another session identity are kept as evidence and are not charged to this session: ${listed}${more}.`,
		);
	}

	/**
	 * Adopts a validated journal. A held newcomer whose identity the journal holds with another payload is evidence first
	 * (written beside the journal's record); a failed evidence write leaves the sidecar unadopted until a retry. Returns false then.
	 */
	private adoptDocument(document: JournalDocument | undefined): boolean {
		for (const record of document?.records ?? []) {
			const held = this.held.get(record.reportId);
			if (!held || samePayload(held.payload, record.payload)) continue;
			if (!this.keepConflict(held.payload, undefined).written) return false;
			this.held.delete(record.reportId);
			this.warnConflict(JOURNAL_CONFLICT_CAUSE);
		}
		for (const record of document?.records ?? []) {
			const held = this.held.get(record.reportId);
			if (held) {
				held.retained = true;
				continue;
			}
			this.held.set(record.reportId, standingEntry(record));
		}
		this.revision += 1;
		return true;
	}

	private load(slot: JournalSlot): void {
		try {
			if (!this.adoptDocument(readJournal(slot))) return;
			this.loaded = true;
			this.operationRecovered("read");
		} catch (error) {
			if (error instanceof SemanticUsageJournalError && error.reason === "corrupt") {
				this.quarantine(slot, error.message);
				return;
			}
			const failure = classifyJournalFailure(error);
			this.scheduleRetry();
			this.warnOnce(
				"read",
				`The session's usage journal is unavailable (${failure.cause}); its pending reports are retried.`,
			);
		}
	}

	/**
	 * Corrupt content is moved aside under the lock. The change re-reads the file there: a valid journal found by then is kept
	 * and adopted, never removed; a journal that was moved aside leaves nothing to keep.
	 */
	private quarantine(slot: JournalSlot, reason: string): void {
		let locked: JournalDocument | undefined;
		try {
			const movedAside = updateJournal(slot, (current) => {
				locked = current;
				return current;
			});
			if (!this.adoptDocument(locked)) return;
			this.loaded = true;
			this.operationRecovered("read");
			this.operationRecovered("quarantine");
			if (movedAside !== undefined) {
				this.evidenceMoved(undefined);
				this.warn(
					`The session's usage journal could not be trusted (${boundedCause(reason)}); it is preserved at ${basename(movedAside)} and its reports are not recovered automatically.`,
				);
			}
		} catch (error) {
			const failure = classifyJournalFailure(error);
			this.scheduleRetry();
			this.warnOnce(
				"quarantine",
				`The session's usage journal is not preserved (${failure.cause}); no new usage is retained until it is.`,
			);
		}
	}

	/** Probes retention with one write that keeps the content; a success recovers the retain operation only. */
	private probe(slot: JournalSlot): void {
		try {
			this.writeJournal("retain", slot, (current) => current, undefined);
		} catch (error) {
			const failure = this.failJournal("retain", error);
			this.warnOnce(
				"retain",
				`The session's usage journal is unavailable (${failure.cause}); its pending reports are retried.`,
			);
		}
	}

	/**
	 * One pass: the sidecar is read or probed as needed, then every held receipt goes through the ledger step. Journal
	 * writes are skipped while their operation is not ready, so a failing journal is not written per receipt.
	 */
	private reconcile(): void {
		this.failedThisPass = false;
		this.retainFull = false;
		const slot = this.boundSlot;
		if (slot !== undefined) {
			if (!this.loaded) this.load(slot);
			if (this.loaded && !this.retainReady) this.probe(slot);
		}
		for (const [reportId, entry] of [...this.held]) {
			try {
				const fencedBefore = this.fenceCause !== undefined;
				const outcome = this.deliverHeld(reportId, entry);
				// A step that fences the manager (its own failed append, or a flag another write left) leaves this receipt pending
				// because of a failed write. No caller waits for a reconcile pass, so the pass tells it, with its own cause. A
				// conflict is not a write failure and keeps its own reporting.
				const conflict = outcome.kind === "unretained" && outcome.reason === "conflict";
				if (!fencedBefore && this.fenceCause !== undefined && !conflict) this.warnUnrecorded(outcome);
			} catch (error) {
				this.warnUnrecorded(this.unexpectedOutcome(reportId, error));
			}
		}
		if (slot !== undefined) this.removeStaleCopies(slot);
		if (!this.failedThisPass) {
			this.retryDelayMs = RETRY_MIN_MS;
			this.operationRecovered("reconcile");
		}
	}

	/** A scheduled or constructor pass never throws out of its callback: an unexpected failure is reported and retried. */
	private runReconcile(): void {
		try {
			if (this.ledger.persistenceUncertain()) this.noteLedgerFence();
			this.reconcile();
		} catch (error) {
			this.scheduleRetry();
			this.warnOnce(
				"reconcile",
				`The session's usage journal could not be reconciled (${causeOf(error)}); its pending reports are retried.`,
			);
		}
	}

	/** Event-driven wake-up after a persisted batch. While a backoff retry is armed, storage is failing: the timer resumes the work. */
	private scheduleReconcile(): void {
		if (this.reconcileQueued || this.isDisposed || this.held.size === 0 || this.retryTimer !== undefined) return;
		this.reconcileQueued = true;
		queueMicrotask(() => {
			this.reconcileQueued = false;
			if (!this.isDisposed && this.retryTimer === undefined) this.runReconcile();
		});
	}

	/** Backoff for failed journal operations only: one unref'd timer at a time, from 1 s doubling to 60 s. */
	private scheduleRetry(): void {
		this.failedThisPass = true;
		if (this.retryTimer !== undefined || this.isDisposed) return;
		const delay = this.retryDelayMs;
		this.retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (!this.isDisposed) this.runReconcile();
		}, delay);
		this.retryTimer.unref();
	}

	/** An unexpected failure is an unconfirmed obligation: typed, retried, and never thrown into a caller. */
	private unexpectedOutcome(reportId: string, error: unknown): SemanticUsageOutcome {
		this.scheduleRetry();
		const cause = boundedCause(`the session journal could not be confirmed (${causeOf(error)})`);
		const entry = this.held.get(reportId);
		return entry
			? this.pendingOutcome(entry, "ledger_uncertain", cause)
			: { kind: "unretained", reason: "storage_refused", cause };
	}

	private warnUnrecorded(outcome: SemanticUsageOutcome): void {
		if (outcome.kind === "physically_recorded") return;
		if (outcome.kind === "durably_pending") {
			const message = `A System One usage receipt is pending, not yet in this session's usage record (${outcome.cause}); ${PENDING_SUFFIX[outcome.reason]}.`;
			// One fence is one fact for the whole session: its pending receipts warn once, not once per receipt.
			if (outcome.reason === "ledger_uncertain") this.warnOnce("ledger", message);
			else this.warn(message);
			return;
		}
		this.warn(
			`A System One usage receipt could not be retained (${outcome.cause}); its spend is not in this session's usage record.`,
		);
	}

	private warnConflict(cause: string): void {
		this.warn(conflictWarning(cause));
	}

	/**
	 * The kernel fences the manager on a failed write, whichever entry made it. The fence is one fact for the session and is
	 * told once. Retained receipts held before it still carry the earlier deferred wording, so they are told the fence now.
	 * `steppingId` is the receipt whose step found or caused the fence: its caller (or the reconcile pass) tells it with its own
	 * pending outcome, so it is not told again here. Nothing is emitted when no other retained receipt is held.
	 */
	private noteLedgerFence(steppingId?: string): void {
		if (this.fenceCause !== undefined) return;
		this.fenceCause = UNCERTAIN_LEDGER_CAUSE;
		const heldBefore = [...this.held.values()].some(
			(entry) => entry.retained && entry.report.reportId !== steppingId,
		);
		if (heldBefore) {
			this.warnUnrecorded({ kind: "durably_pending", reason: "ledger_uncertain", cause: UNCERTAIN_LEDGER_CAUSE });
		}
	}

	/** A retry-driven message: emitted once per distinct text per operation until that operation succeeds again. */
	private warnOnce(operation: JournalOperation, message: string): void {
		let warned = this.warnedByOperation.get(operation);
		if (!warned) {
			warned = new Set<string>();
			this.warnedByOperation.set(operation, warned);
		}
		if (warned.has(message)) return;
		warned.add(message);
		this.warn(message);
	}

	private operationRecovered(operation: JournalOperation): void {
		this.warnedByOperation.delete(operation);
	}

	private warn(message: string): void {
		if (this.warnSink) {
			this.warnSink(message);
			return;
		}
		// Before diagnostics are bound, the first warnings are kept and the rest are counted; bind reports the count.
		if (this.bufferedWarnings.length < MAX_BUFFERED_WARNINGS) this.bufferedWarnings.push(message);
		else this.droppedWarnings += 1;
	}
}

const deliveries = new WeakMap<SessionManager, SemanticUsageDelivery>();

/**
 * The one usage owner of a session manager. The reviewer, the admission path and the session share it, so a session
 * has one owner; a disposed owner is replaced by a fresh one that recovers the same journal.
 */
export function sessionSemanticUsageOf(manager: SessionManager): SessionSemanticUsageDelivery {
	const existing = deliveries.get(manager);
	if (existing && !existing.disposed) return existing;
	const delivery = new SemanticUsageDelivery(createSessionManagerLedgerPort(manager));
	deliveries.set(manager, delivery);
	return delivery;
}
