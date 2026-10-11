/**
 * Derived persistence for the transcript summary hierarchy: immutable node files, one authoritative
 * manifest, and the bounded job list. Source bodies stay in canonical sessions; everything here can be
 * rebuilt from them, and nothing here is a second conversation log.
 *
 * Layout under `<agentDir>/state/transcript-memory/<projectId>/`:
 *   nodes/<id>.json   immutable node content, written BEFORE anything references it (identity and text never change;
 *                     the only later rewrite is `annotateAdmission`, which adds the admission record of a model summary;
 *                     republishing a dormant node writes the same content again)
 *   manifest.json     schema, writer fence, revision, session cursors, accepted nodes, frontiers, tombstones,
 *                     dormant nodes (content of nodes revoked by a lineage change, kept only to be reused)
 *   jobs.json         bounded scheduler state
 *   retention-anchors.json  retention anchors (per session timestamp, per first-capture source), independent of recipes and jobs
 *   spent-attempts.json     terminal-proof ledger, independent of the job list: one bounded record per admitted job
 *                           identity (a reservation while its job lives, its spent budget once it failed) and the
 *                           durable holds (`saturatedSince`, `lostProofSince`)
 *   writer.lock       advisory lock guarding the manifest transaction
 *
 * Writer model: one lease with a durable fencing token. `acquireWriter` increments `writerFence` under the
 * lock; every transaction re-reads the manifest under the same lock and refuses to publish when the fence
 * is no longer the caller's or the expected revision moved. A newer lease therefore supersedes an older
 * one without any shared in-memory state. Node acceptance, the session cursor and frontier references are
 * one manifest write, so a published frontier can never name a node that was not accepted and present. The
 * manifest `revision` advances with every write that changes what `load()` returns to a reader (accepted nodes,
 * frontiers, tombstones, retention anchors, admission annotations), so a reader comparing it knows when to reload.
 *
 * Durability, stated plainly: `writeFileAtomic` (core/util/atomic-file.ts) writes a uniquely named temporary
 * file and renames it over the destination. It never calls `fsync` on the file or on the directory. That
 * gives atomic visibility: a reader, or a process restart after a process crash, sees the old file or the
 * new one, never a torn one. It does NOT give power-loss or kernel-crash durability: after one, a node
 * file or manifest can be missing or empty even though a rename returned. This store therefore treats
 * every file as untrusted on load (schema, identity and cross-references are verified) and reports damage
 * as an explicit recovery state; derived content is rebuilt from canonical sessions, never trusted blindly.
 * A crash between writing node files and the manifest leaves only unreferenced node files, and a crash between writing
 * a temporary file and its rename leaves only that temporary file; both are swept by age when the coordinator starts.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { stateFile } from "../agent-paths.ts";
import { FileLockDeadlineError, isMissingFileError, withFileLock, writeFileAtomic } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { TranscriptFrontierSelection } from "./transcript-frontier.ts";
import {
	formatTranscriptSourceHandle,
	isTerminalSummaryJobState,
	TRANSCRIPT_SUMMARY_SCHEMA_VERSION,
} from "./transcript-memory-contracts.ts";
import {
	needsReadmission,
	summaryTextDigest,
	TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION,
	type TranscriptSummaryAdmissionRecord,
} from "./transcript-summary-admission.ts";
import {
	isNonNegativeInteger,
	parseSummaryNode,
	type TranscriptSummaryNode,
	validateParentChildren,
} from "./transcript-summary-node.ts";
import {
	parseProofRecord,
	parseSummaryJob,
	proofKindFor,
	TRANSCRIPT_SUMMARY_MAX_PERSISTED_JOBS,
	TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS,
	type TranscriptSummaryJob,
	type TranscriptSummaryProofHold,
	type TranscriptSummaryProofRecord,
	type TranscriptSummaryRekey,
} from "./transcript-summary-scheduler.ts";

export const TRANSCRIPT_SUMMARY_MAX_TOMBSTONES = 10_000;

/** Key prefix of a forgotten session's permanent tombstone; the coordinator restores `forgottenSessions` from it. */
export const SESSION_TOMBSTONE_KEY_PREFIX = "session:";
/**
 * Dormant nodes kept; past this the oldest parked are evicted (their files deleted). A dormant node is only a
 * cache of paid content for an identity that may come back: evicting one costs a rebuild, never proof.
 */
export const TRANSCRIPT_SUMMARY_MAX_DORMANT_NODES = 2_000;
/**
 * Retention anchored sources kept (first-capture sources plus session-timestamp memberships). An anchor is
 * never evicted by age (that would reset a source's age); past this, new ones are refused. Anchors leave only
 * with a forgotten or vanished session.
 */
export const TRANSCRIPT_SUMMARY_MAX_RETENTION_ANCHORS = 20_000;
const MAX_SPENT_MESSAGE_CHARS = 300;
/** The ledger shape with reservations and holds; a file without it was written before reservations existed. */
const PROOF_LEDGER_VERSION = 2;
/** Terminal handoff records kept (newest last). */
export const TRANSCRIPT_SUMMARY_MAX_TERMINALS = 50;
/** Unreferenced node and temporary files younger than this are never swept: their writer may still publish. */
export const TRANSCRIPT_SUMMARY_ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

const NODE_ID_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

export interface TranscriptSummarySessionCursor {
	lineageDigest: string;
	/** Leading selected-lineage spans covered by leaves; the next leaf starts here. */
	coveredSpanCount: number;
	/** Ordinal the leaf starting at `coveredSpanCount` will have (leaves are aligned by ordinal). */
	nextOrdinal: number;
}

/** What the manifest knows about an accepted node: enough to revoke dependents without reading node files. */
export interface TranscriptSummaryAcceptedNode {
	level: number;
	ordinal: number;
	sessionId: string;
	fromIndex: number;
	toIndexExclusive: number;
	children?: [string, string];
	/** Handles of the context sources the node consulted (coverage is derivable from the range). */
	contextRefs: string[];
	/** Oldest event time among coverage and context dependencies; anchors for undated sources are kept apart. */
	oldestDependencyAt?: string;
}

/**
 * Retention anchors: where a source's age starts when its canonical entry carries no usable event time.
 * `sessions`: the canonical session timestamp (a bound no later than the entry), kept ONCE per session with the
 * undated sources it covers (`<entryId>:<part>:<digest>`); dated sources never age from it. `sources`: the
 * instant the hierarchy first saw a source in a session that records no timestamp either; its event time
 * stays unknown and is reported as such.
 */
export interface TranscriptRetentionAnchors {
	sources: Record<string, { at: string }>;
	sessions: Record<string, { at: string; sources: string[] }>;
}

/** One undated source to anchor, by `tx:` handle, and the basis that decides how it is stored. */
export interface TranscriptAnchorRequest {
	handle: string;
	at: string;
	basis: "session_timestamp" | "first_capture";
	/**
	 * The same source's handle under capture version 1 (its text-only digest). An anchor recorded under it moves to
	 * `handle` with its own age and basis instead of a new one being stamped: an upgrade never makes a source younger.
	 */
	legacyHandle?: string;
}

/** A published frontier selection for one lineage; its meaning belongs to transcript-frontier.ts, its integrity to the store. */
export type TranscriptSummaryFrontierRecord = TranscriptFrontierSelection;

export type TranscriptSummaryRevocationReason = "retention" | "invalidated" | "recovery";

export interface TranscriptSummaryTombstone {
	revokedAt: string;
	reason: TranscriptSummaryRevocationReason;
}

export interface TranscriptSummaryManifest {
	schemaVersion: number;
	writerFence: number;
	revision: number;
	sessions: Record<string, TranscriptSummarySessionCursor>;
	acceptedNodes: Record<string, TranscriptSummaryAcceptedNode>;
	frontiers: Record<string, TranscriptSummaryFrontierRecord>;
	/** Retention revocations only: a late result for a forgotten node must not be able to republish it. */
	tombstones: Record<string, TranscriptSummaryTombstone>;
	/**
	 * Nodes revoked because their coverage left the live lineage (a branch switch), parked with their file kept
	 * so the identical identity found again is republished without paying again. Never accepted, never read: no
	 * frontier, discovery or expansion path sees them. Retention, forgetting and a vanished session purge them.
	 */
	dormant: Record<string, TranscriptSummaryDormantEntry>;
}

export interface TranscriptSummaryDormantEntry {
	sessionId: string;
	/** ISO instant it was parked; eviction takes the oldest first. */
	parkedAt: string;
}

/** The `session:` tombstones a damaged manifest's bytes still hold (valid JSON with a valid tombstone entry); none otherwise. */
function salvageSessionTombstones(raw: string): Record<string, TranscriptSummaryTombstone> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!isPlainRecord(value) || !isPlainRecord(value.tombstones)) return {};
	const salvaged: Record<string, TranscriptSummaryTombstone> = {};
	for (const [id, entry] of Object.entries(value.tombstones)) {
		if (
			id.startsWith(SESSION_TOMBSTONE_KEY_PREFIX) &&
			isPlainRecord(entry) &&
			typeof entry.revokedAt === "string" &&
			(entry.reason === "retention" || entry.reason === "invalidated" || entry.reason === "recovery")
		) {
			salvaged[id] = { revokedAt: entry.revokedAt, reason: entry.reason };
		}
	}
	return salvaged;
}

function emptyManifest(writerFence: number): TranscriptSummaryManifest {
	return {
		schemaVersion: TRANSCRIPT_SUMMARY_SCHEMA_VERSION,
		writerFence,
		revision: 0,
		sessions: {},
		acceptedNodes: {},
		frontiers: {},
		tombstones: {},
		dormant: {},
	};
}

type ManifestParse = { ok: true; manifest: TranscriptSummaryManifest } | { ok: false; reason: string };

function parseManifest(raw: string): ManifestParse {
	const fail = (reason: string): ManifestParse => ({ ok: false, reason });
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		return fail(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isPlainRecord(value)) return fail("manifest is not an object");
	if (value.schemaVersion !== TRANSCRIPT_SUMMARY_SCHEMA_VERSION) return fail("unsupported manifest schema version");
	if (!isNonNegativeInteger(value.writerFence) || !isNonNegativeInteger(value.revision)) {
		return fail("writerFence or revision is invalid");
	}
	const manifest = emptyManifest(value.writerFence);
	manifest.revision = value.revision;
	if (
		!isPlainRecord(value.sessions) ||
		!isPlainRecord(value.acceptedNodes) ||
		!isPlainRecord(value.frontiers) ||
		!isPlainRecord(value.tombstones)
	) {
		return fail("manifest sections are missing");
	}
	for (const [sessionId, raw] of Object.entries(value.sessions)) {
		if (
			!isPlainRecord(raw) ||
			typeof raw.lineageDigest !== "string" ||
			!isNonNegativeInteger(raw.coveredSpanCount) ||
			!isNonNegativeInteger(raw.nextOrdinal)
		) {
			return fail(`session cursor ${sessionId} is invalid`);
		}
		manifest.sessions[sessionId] = {
			lineageDigest: raw.lineageDigest,
			coveredSpanCount: raw.coveredSpanCount,
			nextOrdinal: raw.nextOrdinal,
		};
	}
	for (const [id, raw] of Object.entries(value.acceptedNodes)) {
		if (!NODE_ID_PATTERN.test(id)) return fail(`accepted node id ${id} is invalid`);
		if (
			!isPlainRecord(raw) ||
			!isNonNegativeInteger(raw.level) ||
			!isNonNegativeInteger(raw.ordinal) ||
			typeof raw.sessionId !== "string" ||
			!isNonNegativeInteger(raw.fromIndex) ||
			!isNonNegativeInteger(raw.toIndexExclusive) ||
			!Array.isArray(raw.contextRefs) ||
			raw.contextRefs.some((entry) => typeof entry !== "string")
		) {
			return fail(`accepted node ${id} is invalid`);
		}
		let children: [string, string] | undefined;
		if (raw.children !== undefined) {
			if (
				!Array.isArray(raw.children) ||
				raw.children.length !== 2 ||
				!NODE_ID_PATTERN.test(String(raw.children[0])) ||
				!NODE_ID_PATTERN.test(String(raw.children[1]))
			) {
				return fail(`accepted node ${id} has invalid children`);
			}
			children = [String(raw.children[0]), String(raw.children[1])];
		}
		manifest.acceptedNodes[id] = {
			level: raw.level,
			ordinal: raw.ordinal,
			sessionId: raw.sessionId,
			fromIndex: raw.fromIndex,
			toIndexExclusive: raw.toIndexExclusive,
			...(children ? { children } : {}),
			contextRefs: raw.contextRefs as string[],
			...(typeof raw.oldestDependencyAt === "string" ? { oldestDependencyAt: raw.oldestDependencyAt } : {}),
		};
	}
	for (const [key, raw] of Object.entries(value.frontiers)) {
		if (
			!isPlainRecord(raw) ||
			!isNonNegativeInteger(raw.coveredThroughIndex) ||
			!isNonNegativeInteger(raw.omittedBeforeIndex) ||
			!isNonNegativeInteger(raw.revision) ||
			!isNonNegativeInteger(raw.allowanceBytes) ||
			!isNonNegativeInteger(raw.recipeVersion) ||
			!Array.isArray(raw.nodeIds) ||
			raw.nodeIds.some((entry) => typeof entry !== "string" || !NODE_ID_PATTERN.test(entry))
		) {
			return fail(`frontier ${key} is invalid`);
		}
		manifest.frontiers[key] = {
			nodeIds: raw.nodeIds as string[],
			omittedBeforeIndex: raw.omittedBeforeIndex,
			coveredThroughIndex: raw.coveredThroughIndex,
			revision: raw.revision,
			allowanceBytes: raw.allowanceBytes,
			recipeVersion: raw.recipeVersion,
		};
	}
	for (const [id, raw] of Object.entries(value.tombstones)) {
		if (
			!isPlainRecord(raw) ||
			typeof raw.revokedAt !== "string" ||
			(raw.reason !== "retention" && raw.reason !== "invalidated" && raw.reason !== "recovery")
		) {
			return fail(`tombstone ${id} is invalid`);
		}
		manifest.tombstones[id] = { revokedAt: raw.revokedAt, reason: raw.reason };
	}
	// A manifest written before dormant nodes existed has none.
	if (value.dormant !== undefined && !isPlainRecord(value.dormant)) return fail("dormant section is invalid");
	for (const [id, raw] of Object.entries(value.dormant ?? {})) {
		if (
			!NODE_ID_PATTERN.test(id) ||
			!isPlainRecord(raw) ||
			typeof raw.sessionId !== "string" ||
			typeof raw.parkedAt !== "string"
		) {
			return fail(`dormant node ${id} is invalid`);
		}
		manifest.dormant[id] = { sessionId: raw.sessionId, parkedAt: raw.parkedAt };
	}
	return { ok: true, manifest };
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export interface TranscriptSummaryPublishTransaction {
	/** When set, publication is refused unless the manifest is still at exactly this revision. */
	expectedRevision?: number;
	/** Nodes to accept. Their files are written first; parents need their children accepted (here or earlier). */
	nodes?: readonly TranscriptSummaryNode[];
	/** Source cursors to advance in the same write. */
	sessions?: Record<string, TranscriptSummarySessionCursor>;
	/** Frontier records to set; every referenced node must be accepted and present. */
	frontiers?: Record<string, TranscriptSummaryFrontierRecord>;
	removeFrontiers?: readonly string[];
}

export type TranscriptSummaryPublishResult =
	| { status: "published"; revision: number; accepted: string[] }
	| { status: "fenced"; currentFence: number }
	| { status: "stale_revision"; currentRevision: number }
	| { status: "revoked"; nodeIds: string[] }
	| { status: "invalid"; reason: string }
	| { status: "manifest_corrupt"; detail: string }
	| TranscriptSummaryStoreUnavailable;

export type TranscriptSummaryAnnotateResult =
	| { status: "annotated"; node: TranscriptSummaryNode; revision: number }
	| { status: "not_accepted" }
	| { status: "unreadable"; reason: string }
	| { status: "invalid"; reason: string }
	| { status: "fenced"; currentFence: number }
	| { status: "manifest_corrupt"; detail: string }
	| TranscriptSummaryStoreUnavailable;

export type TranscriptSummaryRevokeResult =
	| {
			status: "published";
			revision: number;
			/** Every node removed from the accepted set: the matches and all of their transitive dependents. */
			revoked: string[];
			removedFrontiers: string[];
			/** Revoked nodes parked as dormant (their files kept). */
			parked: string[];
			/** Dormant nodes removed: purged (retention, forgetting, a vanished session, damage) or evicted by the bound. */
			purged: string[];
			/** Node files that could not be deleted; the nodes are revoked either way and the files are unreferenced. */
			unlinkFailures: { id: string; error: string }[];
	  }
	| { status: "fenced"; currentFence: number }
	| { status: "manifest_corrupt"; detail: string }
	| TranscriptSummaryStoreUnavailable;

/** Durable terminal-proof capacity as persisted; the bound is {@link TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS}. */
export interface TranscriptSummaryProofStatus {
	/** Durable terminal-proof records: spent budgets plus reservations. */
	recorded: number;
	/** Reservations held by admitted identities whose job has not ended. */
	reserved: number;
	/** `possibly_lost_proof` when proof may have been lost, else `capacity` while the ledger is at its bound. */
	hold?: TranscriptSummaryProofHold;
}

export type TranscriptSummaryJobsSaveResult =
	| {
			status: "saved";
			/** Terminal jobs removed from the list. A job whose spent or carried attempts lack a record is never among them. */
			pruned: string[];
			/**
			 * The ledger's record for every listed job that has one after this save: the ones it wrote (new reservations, spent
			 * budgets of failures, carried attempts of stale jobs) and the ones it found and kept, including records an earlier
			 * save made durable before it failed at the job list. The owner's proof mirror follows the durable ledger exactly.
			 */
			proof: Record<string, TranscriptSummaryProofRecord>;
			/** Records released because their job ended without spending a budget (ready, or stale/cancelled before any attempt). */
			released: string[];
			/** Live jobs the ledger bound refused a reservation: none of them may start chargeable work. */
			refused: string[];
			/** Terminal jobs kept past the job-list bound because no durable record of their attempts could be written. */
			retained: number;
			/**
			 * The requested budget moves now durable: applied by this save, or already settled (nothing left under the old
			 * key). A skipped one is absent.
			 */
			rekeyed: TranscriptSummaryRekey[];
			ledger: TranscriptSummaryProofStatus;
	  }
	| { status: "jobs_overflow"; active: number }
	| { status: "fenced"; currentFence: number }
	| { status: "manifest_corrupt"; detail: string }
	| TranscriptSummaryStoreUnavailable;

export type TranscriptSummaryAnchorResult =
	/**
	 * `revision`: the manifest revision after this write (advanced when anchors were added or moved). `recorded`: the
	 * anchors now held for the requested handles, with the age they actually carry (a moved one keeps its version 1
	 * age); `moved`: the version 1 handles they were moved from.
	 */
	| { status: "saved"; added: number; recorded: TranscriptAnchorRequest[]; moved: string[]; revision: number }
	/** The anchor file is at its ceiling: the sources in `refused` were not anchored and must not be treated as ageless. */
	| {
			status: "capacity";
			added: number;
			recorded: TranscriptAnchorRequest[];
			moved: string[];
			refused: string[];
			revision: number;
	  }
	| { status: "fenced"; currentFence: number }
	| { status: "manifest_corrupt"; detail: string }
	| TranscriptSummaryStoreUnavailable;

export type TranscriptSummarySessionRecordsResult =
	/**
	 * `spent`: budget records (spent and carried) dropped; `dormant`: dormant nodes of those sessions purged;
	 * `revision`: the manifest revision after the write.
	 */
	| {
			status: "saved";
			anchors: number;
			spent: number;
			dormant: string[];
			ledger: TranscriptSummaryProofStatus;
			revision: number;
	  }
	| { status: "fenced"; currentFence: number }
	| { status: "manifest_corrupt"; detail: string }
	| TranscriptSummaryStoreUnavailable;

export type TranscriptSummaryNodeRead =
	| { status: "ok"; node: TranscriptSummaryNode }
	| { status: "missing" }
	| { status: "corrupt"; reason: string };

export type TranscriptSummaryRecoveryIssue =
	| { kind: "manifest_corrupt"; detail: string }
	| { kind: "node_missing"; nodeId: string }
	| { kind: "node_corrupt"; nodeId: string; detail: string }
	| { kind: "node_mismatch"; nodeId: string; detail: string }
	| { kind: "child_missing"; nodeId: string; childId: string }
	| { kind: "frontier_dangling"; frontier: string; nodeId: string }
	| { kind: "dormant_damaged"; nodeId: string; detail: string }
	| { kind: "jobs_corrupt"; detail: string }
	| { kind: "anchors_corrupt"; detail: string }
	| { kind: "spent_corrupt"; detail: string }
	| { kind: "terminals_corrupt"; detail: string };

export interface TranscriptSummaryTerminalCause {
	jobId: string;
	level: number;
	sessionId: string;
	reason: string;
	message: string;
}

/**
 * The bounded terminal handoff of one finished batch of summary work. The owner decides whether and how
 * to surface it; a successful batch is a diagnostic record and must never inject a chat turn.
 */
/**
 * Why a job waits before any provider call. `model_work`: the summarizer or the admission judge cannot run.
 * `children`: a parent's children are not admitted yet. `proof`: the terminal-proof ledger has no slot. `persistence`:
 * the save that should make its attempt durable failed. `reconciliation`: a recovered leaf whose version 1 budget is
 * not adopted yet (its session has not been read since the start).
 */
export type TranscriptSummaryHoldKind = "model_work" | "children" | "proof" | "persistence" | "reconciliation";

/** Held jobs per hold kind; a kind with none is absent. */
export type TranscriptSummaryHeldByKind = Partial<Record<TranscriptSummaryHoldKind, number>>;

const HOLD_KINDS: readonly TranscriptSummaryHoldKind[] = [
	"model_work",
	"children",
	"proof",
	"persistence",
	"reconciliation",
];

export interface TranscriptSummaryTerminalRecord {
	batchId: number;
	/** `completed`: every job reached a terminal state. `stopped`: the coordinator stopped with work left. */
	outcome: "completed" | "stopped";
	succeeded: number;
	failed: number;
	cancelled: number;
	stale: number;
	/** Jobs put back on the queue by a stop; they resume on the next start. */
	interrupted: number;
	startedAt: number;
	endedAt: number;
	causes: TranscriptSummaryTerminalCause[];
	/** Jobs still held when the batch ended (see {@link TranscriptSummaryHoldKind}); not failures, not finished. */
	held?: number;
	/** The kind of the first held job's hold. */
	heldKind?: TranscriptSummaryHoldKind;
	/** The real cause recorded with that hold when it was set, bounded. */
	heldReason?: string;
	/** Held jobs per hold kind; their sum is `held`. */
	heldByKind?: TranscriptSummaryHeldByKind;
	/** Set when the coordinator stopped itself because of an unrecoverable condition (superseded writer, corrupt store). */
	stopReason?: string;
}

export interface TranscriptSummaryStoreState {
	/** Undefined when no manifest exists yet, or when it is corrupt (an issue says which). */
	manifest: TranscriptSummaryManifest | undefined;
	/** Every accepted node that loaded and validated. */
	nodes: Map<string, TranscriptSummaryNode>;
	/** Dormant nodes that loaded and validated: for reuse by the summary coordinator only, never for a reader. */
	dormant: Map<string, TranscriptSummaryNode>;
	jobs: TranscriptSummaryJob[];
	retentionAnchors: TranscriptRetentionAnchors;
	/** The terminal-proof ledger: records by job key and the capacity they leave. */
	proof: { records: Record<string, TranscriptSummaryProofRecord>; status: TranscriptSummaryProofStatus };
	/** The persisted terminal handoff records, oldest first. */
	terminals: TranscriptSummaryTerminalRecord[];
	issues: TranscriptSummaryRecoveryIssue[];
}

export type TranscriptSummaryWriterAcquisition =
	| { status: "acquired"; writer: TranscriptSummaryWriter }
	| { status: "manifest_corrupt"; detail: string };

export interface TranscriptSummaryRecoveryReport {
	revoked: string[];
	removedFrontiers: string[];
	jobsRewritten: boolean;
}

export interface TranscriptSummaryStoreOptions {
	agentDir: string;
	projectId: string;
	/** Clock for tombstone timestamps; injectable. */
	now?: () => number;
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

/** A store read that could not be served: the real cause (an I/O or lock failure, or the caller's deadline). */
export interface TranscriptSummaryStoreUnavailable {
	status: "unavailable";
	reason: string;
}

/** A bounded load that reached its deadline between file reads: it stops there, and its lock is released. */
class StoreReadDeadlineError extends Error {}

function pastDeadline(deadlineAt: number | undefined): void {
	if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new StoreReadDeadlineError();
}

/** A system I/O error (it names its syscall) or a lock that is held or compromised. */
function isStoreIoError(error: unknown): error is Error {
	if (!(error instanceof Error)) return false;
	if ("syscall" in error && typeof error.syscall === "string") return true;
	return "code" in error && (error.code === "ELOCKED" || error.code === "ECOMPROMISED");
}

/**
 * The store's one classification of a store operation that threw (`what` names the operation): an I/O or lock
 * failure, a lock wait past its deadline and a load that ran out of time are the typed real-cause `unavailable`;
 * anything else is a programming error, undefined here. Readers get it through {@link readBoundary}; an owner whose
 * store write threw classifies the failure with it, so both sides name the same causes the same way.
 */
export function storeUnavailable(what: string, error: unknown): TranscriptSummaryStoreUnavailable | undefined {
	if (error instanceof FileLockDeadlineError) {
		return { status: "unavailable", reason: `the summary store is busy: ${what} ${withErrorCode(error)}` };
	}
	if (error instanceof StoreReadDeadlineError) {
		return { status: "unavailable", reason: `${what} did not finish before the operation deadline` };
	}
	if (isStoreIoError(error)) return { status: "unavailable", reason: `${what} failed: ${withErrorCode(error)}` };
	return undefined;
}

/**
 * An error's message led by its code (`ELOCKED: Lock file is already being held`), so the cause names its class even
 * when the message does not. A message that already starts with its code (Node's `EIO: i/o error, ...`) is kept as is.
 */
function withErrorCode(error: Error): string {
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	return code === undefined || error.message.startsWith(`${code}:`) ? error.message : `${code}: ${error.message}`;
}

/**
 * The store's read boundary for readers (`readManifest`, `load`): what {@link storeUnavailable} classifies becomes
 * a typed real-cause `unavailable`, so a reader keeps its exact history hits. Anything else is a programming error
 * and still rejects. File damage is never decided here: it stays `corrupt` from the parsers, so a transient error
 * can never make recovery revoke anything.
 */
async function readBoundary<T>(what: string, read: () => Promise<T>): Promise<T | TranscriptSummaryStoreUnavailable> {
	try {
		return await read();
	} catch (error) {
		const unavailable = storeUnavailable(what, error);
		if (unavailable) return unavailable;
		throw error;
	}
}

/** One whole read of the manifest file: absent, parsed and valid, or damaged (with its raw bytes). */
export type ManifestRead =
	| { status: "missing" }
	| { status: "ok"; manifest: TranscriptSummaryManifest }
	| { status: "corrupt"; detail: string; raw: string };

function sessionOfHandle(handle: string): string | undefined {
	return handle.split(":")[1];
}

/** `<entryId>:<part>:<digest>`: a source's identity inside its session (the handle without `tx:<sessionId>:`). */
export function sourceKeyOfHandle(handle: string): string {
	return handle.split(":").slice(2).join(":");
}

function anchoredCount(anchors: TranscriptRetentionAnchors): number {
	let count = Object.keys(anchors.sources).length;
	for (const session of Object.values(anchors.sessions)) count += session.sources.length;
	return count;
}

/** The terminal-proof ledger file, parsed. */
interface ProofLedger {
	records: Record<string, TranscriptSummaryProofRecord>;
	/** When the record count last reached the bound; cleared as soon as a slot is free. */
	saturatedSince?: string;
	/**
	 * The latest instant terminal proof may have been lost (a full ledger from before reservations existed, damaged
	 * proof). Never cleared: which identities lost their budget is unknowable, so sessions started at or before it
	 * admit no new identity (see the scheduler's admission rule).
	 */
	lostProofSince?: string;
	/** False when the file is missing or has the shape from before reservations: the next ledger write converts it. */
	current: boolean;
}

function isInstant(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function proofStatus(ledger: ProofLedger): TranscriptSummaryProofStatus {
	let reserved = 0;
	for (const record of Object.values(ledger.records)) if (record.kind === "reserved") reserved += 1;
	const hold: TranscriptSummaryProofHold | undefined =
		ledger.lostProofSince !== undefined
			? { cause: "possibly_lost_proof", since: ledger.lostProofSince }
			: ledger.saturatedSince !== undefined
				? { cause: "capacity", since: ledger.saturatedSince }
				: undefined;
	return { recorded: Object.keys(ledger.records).length, reserved, ...(hold ? { hold } : {}) };
}

/** Keep the capacity hold in step with the record count; true when it changed. */
function noteSaturation(ledger: ProofLedger, at: number): boolean {
	const saturated = Object.keys(ledger.records).length >= TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS;
	if (saturated === (ledger.saturatedSince !== undefined)) return false;
	if (saturated) ledger.saturatedSince = new Date(at).toISOString();
	else delete ledger.saturatedSince;
	return true;
}

/**
 * Move the anchor recorded under a source's capture version 1 handle to its current handle, keeping its age and its
 * basis (a first-capture anchor stays per source; a session-timestamp membership is renamed within its session).
 * Undefined when version 1 recorded no anchor for it. The anchor count does not change.
 */
function moveLegacyAnchor(
	anchors: TranscriptRetentionAnchors,
	legacyHandle: string,
	handle: string,
): TranscriptAnchorRequest | undefined {
	const first = anchors.sources[legacyHandle];
	if (first) {
		delete anchors.sources[legacyHandle];
		anchors.sources[handle] = { at: first.at };
		return { handle, at: first.at, basis: "first_capture" };
	}
	const session = anchors.sessions[sessionOfHandle(legacyHandle) ?? ""];
	const position = session?.sources.indexOf(sourceKeyOfHandle(legacyHandle)) ?? -1;
	if (!session || position === -1) return undefined;
	session.sources[position] = sourceKeyOfHandle(handle);
	return { handle, at: session.at, basis: "session_timestamp" };
}

/** A per-kind count of held jobs: only known kinds, each a non-negative integer. */
function isHeldByKind(value: unknown): value is TranscriptSummaryHeldByKind {
	if (!isPlainRecord(value)) return false;
	return Object.entries(value).every(
		([kind, count]) => HOLD_KINDS.some((known) => known === kind) && isNonNegativeInteger(count),
	);
}

function isTerminalRecord(value: unknown): value is TranscriptSummaryTerminalRecord {
	if (!isPlainRecord(value)) return false;
	return (
		(value.heldKind === undefined || HOLD_KINDS.some((kind) => kind === value.heldKind)) &&
		(value.heldByKind === undefined || isHeldByKind(value.heldByKind)) &&
		isNonNegativeInteger(value.batchId) &&
		(value.outcome === "completed" || value.outcome === "stopped") &&
		isNonNegativeInteger(value.succeeded) &&
		isNonNegativeInteger(value.failed) &&
		isNonNegativeInteger(value.cancelled) &&
		isNonNegativeInteger(value.stale) &&
		isNonNegativeInteger(value.interrupted) &&
		typeof value.startedAt === "number" &&
		typeof value.endedAt === "number" &&
		Array.isArray(value.causes)
	);
}

export class TranscriptSummaryStore {
	readonly root: string;
	private readonly nodesDir: string;
	private readonly manifestPath: string;
	private readonly jobsPath: string;
	private readonly terminalsPath: string;
	private readonly anchorsPath: string;
	private readonly spentPath: string;
	private readonly lockPath: string;
	private readonly now: () => number;

	constructor(options: TranscriptSummaryStoreOptions) {
		if (!PROJECT_ID_PATTERN.test(options.projectId)) {
			throw new RangeError("Transcript memory project id must be a safe path segment.");
		}
		this.root = stateFile(options.agentDir, "transcript-memory", options.projectId);
		this.nodesDir = join(this.root, "nodes");
		this.manifestPath = join(this.root, "manifest.json");
		this.jobsPath = join(this.root, "jobs.json");
		this.terminalsPath = join(this.root, "terminals.json");
		this.anchorsPath = join(this.root, "retention-anchors.json");
		this.spentPath = join(this.root, "spent-attempts.json");
		this.lockPath = join(this.root, "writer.lock");
		this.now = options.now ?? Date.now;
	}

	/**
	 * Read and verify everything: the manifest schema, every accepted node file (parse, identity, agreement
	 * with its manifest entry), parent/child links, frontier references and the job list. Damage is returned
	 * as `issues`; nothing is repaired or dropped silently. Typed at the store's read boundary ({@link readBoundary}).
	 * With `deadlineAt`, waiting for the lock is bounded and the load stops between file reads once it has passed,
	 * releasing the lock; a file read already started is not preemptible, so it can settle one read past the deadline.
	 * `lockAdmissionDeadlineAt` bounds only the wait for the lock (the earlier of the two applies there); a load that
	 * was admitted runs its reads under `deadlineAt` alone. A wait past either is the typed `unavailable`.
	 */
	async load(
		options: { deadlineAt?: number; lockAdmissionDeadlineAt?: number } = {},
	): Promise<TranscriptSummaryStoreState | TranscriptSummaryStoreUnavailable> {
		const { deadlineAt, lockAdmissionDeadlineAt } = options;
		const admissionBy =
			deadlineAt === undefined
				? lockAdmissionDeadlineAt
				: lockAdmissionDeadlineAt === undefined
					? deadlineAt
					: Math.min(deadlineAt, lockAdmissionDeadlineAt);
		return readBoundary("loading the summary store", () =>
			this.locked(() => this.loadLocked(deadlineAt), admissionBy),
		);
	}

	/** Caller holds the lock. */
	private async loadLocked(deadlineAt: number | undefined): Promise<TranscriptSummaryStoreState> {
		const issues: TranscriptSummaryRecoveryIssue[] = [];
		const nodes = new Map<string, TranscriptSummaryNode>();
		const dormant = new Map<string, TranscriptSummaryNode>();
		pastDeadline(deadlineAt);
		const read = await this.readManifestFile();
		let manifest: TranscriptSummaryManifest | undefined;
		if (read.status === "corrupt") issues.push({ kind: "manifest_corrupt", detail: read.detail });
		if (read.status === "ok") manifest = read.manifest;
		if (manifest) {
			for (const [id, entry] of Object.entries(manifest.acceptedNodes)) {
				pastDeadline(deadlineAt);
				const result = await this.readNode(id);
				if (result.status === "missing") {
					issues.push({ kind: "node_missing", nodeId: id });
					continue;
				}
				if (result.status === "corrupt") {
					issues.push({ kind: "node_corrupt", nodeId: id, detail: result.reason });
					continue;
				}
				const node = result.node;
				if (
					node.level !== entry.level ||
					node.ordinal !== entry.ordinal ||
					node.sessionId !== entry.sessionId ||
					node.spanRange.fromIndex !== entry.fromIndex ||
					node.spanRange.toIndexExclusive !== entry.toIndexExclusive
				) {
					issues.push({
						kind: "node_mismatch",
						nodeId: id,
						detail: "node file disagrees with its manifest entry",
					});
					continue;
				}
				nodes.set(id, node);
			}
			for (const [id, node] of nodes) {
				if (!node.children) continue;
				const [leftId, rightId] = node.children;
				const left = nodes.get(leftId);
				const right = nodes.get(rightId);
				if (!left || !right) {
					issues.push({ kind: "child_missing", nodeId: id, childId: left ? rightId : leftId });
					continue;
				}
				const check = validateParentChildren(node, left, right);
				if (!check.ok) issues.push({ kind: "node_mismatch", nodeId: id, detail: check.reason });
			}
			for (const [name, frontier] of Object.entries(manifest.frontiers)) {
				for (const nodeId of frontier.nodeIds) {
					if (!manifest.acceptedNodes[nodeId] || !nodes.has(nodeId)) {
						issues.push({ kind: "frontier_dangling", frontier: name, nodeId });
						break;
					}
				}
			}
		}
		for (const [id, entry] of Object.entries(manifest?.dormant ?? {})) {
			pastDeadline(deadlineAt);
			const result = await this.readNode(id);
			const detail =
				result.status === "missing"
					? "file missing"
					: result.status === "corrupt"
						? result.reason
						: result.node.sessionId !== entry.sessionId
							? "file disagrees with its manifest entry"
							: undefined;
			if (detail !== undefined) issues.push({ kind: "dormant_damaged", nodeId: id, detail });
			else if (result.status === "ok") dormant.set(id, result.node);
		}
		// No new file read starts once the deadline has passed; one already started cannot be preempted.
		pastDeadline(deadlineAt);
		const jobs = await this.readJobs(issues);
		pastDeadline(deadlineAt);
		const retentionAnchors = await this.readAnchors(issues);
		pastDeadline(deadlineAt);
		const ledger = await this.readProof(issues);
		pastDeadline(deadlineAt);
		const terminals = await this.readTerminals(issues);
		const proof = { records: ledger.records, status: proofStatus(ledger) };
		return { manifest, nodes, dormant, jobs, retentionAnchors, proof, terminals, issues };
	}

	/** Read one node file, fully validated. */
	async readNode(id: string): Promise<TranscriptSummaryNodeRead> {
		if (!NODE_ID_PATTERN.test(id)) return { status: "corrupt", reason: "node id is not a SHA-256 hex digest" };
		let raw: string;
		try {
			raw = await fs.readFile(join(this.nodesDir, `${id}.json`), "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return { status: "missing" };
			throw error;
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			return {
				status: "corrupt",
				reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const parsed = parseSummaryNode(value);
		if (!parsed.ok) return { status: "corrupt", reason: parsed.reason };
		if (parsed.node.id !== id) return { status: "corrupt", reason: "file name does not match the node id" };
		return { status: "ok", node: parsed.node };
	}

	/**
	 * Take the writer lease. The fence is incremented under the lock, so any earlier writer's next
	 * transaction fails as `fenced`. A corrupt manifest is refused unless `recoverCorrupt` is set, in which
	 * case the damaged bytes are kept beside it and an empty manifest starts at a fence no earlier writer
	 * could have held (the clock, in milliseconds); derived state is then rebuilt from canonical sessions.
	 */
	async acquireWriter(options: { recoverCorrupt?: boolean } = {}): Promise<TranscriptSummaryWriterAcquisition> {
		return this.locked(async () => {
			const read = await this.readManifestFile();
			let manifest: TranscriptSummaryManifest;
			if (read.status === "missing") {
				manifest = emptyManifest(1);
			} else if (read.status === "ok") {
				manifest = { ...read.manifest, writerFence: read.manifest.writerFence + 1 };
			} else if (options.recoverCorrupt === true) {
				await writeFileAtomic(`${this.manifestPath}.corrupt.${this.now()}`, read.raw, { mode: 0o600 });
				manifest = emptyManifest(Math.max(1, this.now()));
				// A forgotten session's marker is the only durable record that it is never summarized again: it is carried
				// across the replacement from whatever the damaged bytes still hold.
				Object.assign(manifest.tombstones, salvageSessionTombstones(read.raw));
			} else {
				return { status: "manifest_corrupt" as const, detail: read.detail };
			}
			await this.writeManifest(manifest);
			return { status: "acquired" as const, writer: new TranscriptSummaryWriter(this, manifest.writerFence) };
		});
	}

	// ---- internals shared with the writer ------------------------------------------------------

	/** @internal With `deadlineAt`, waiting for the lock is bounded (`FileLockDeadlineError`); the section is not. */
	locked<T>(fn: () => Promise<T>, deadlineAt?: number): Promise<T> {
		return withFileLock(this.lockPath, fn, deadlineAt !== undefined ? { deadlineAt } : undefined);
	}

	/**
	 * One whole read of the manifest, for readers: typed at the store's read boundary ({@link readBoundary}), and not
	 * started once `deadlineAt` has passed. Correct without the lock: the manifest is only ever replaced by
	 * `writeManifest`, an atomic temporary-file-then-rename (`writeFileAtomic`), so a reader sees the previous or the
	 * next manifest, never a torn one, and a read-only owner may compare its revision unlocked. One started file read is
	 * not preemptible: it can settle after the deadline.
	 */
	async readManifest(
		options: { deadlineAt?: number } = {},
	): Promise<ManifestRead | TranscriptSummaryStoreUnavailable> {
		return readBoundary("reading the summary manifest", async () => {
			pastDeadline(options.deadlineAt);
			return this.readManifestFile();
		});
	}

	/**
	 * @internal The raw manifest read the writer's fenced sections, writer acquisition and recovery use under the lock;
	 * an I/O failure rejects there, where it ends the transaction.
	 */
	async readManifestFile(): Promise<ManifestRead> {
		let raw: string;
		try {
			raw = await fs.readFile(this.manifestPath, "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return { status: "missing" };
			throw error;
		}
		const parsed = parseManifest(raw);
		return parsed.ok
			? { status: "ok", manifest: parsed.manifest }
			: { status: "corrupt", detail: parsed.reason, raw };
	}

	/** @internal Caller holds the lock. */
	async writeManifest(manifest: TranscriptSummaryManifest): Promise<void> {
		await writeFileAtomic(this.manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
	}

	/** @internal Caller holds the lock. */
	async writeNodeFile(node: TranscriptSummaryNode): Promise<void> {
		await writeFileAtomic(join(this.nodesDir, `${node.id}.json`), `${JSON.stringify(node)}\n`, { mode: 0o600 });
	}

	/** @internal Caller holds the lock. Missing files are not failures: the node is gone either way. */
	async unlinkNodeFile(id: string): Promise<void> {
		try {
			await fs.unlink(join(this.nodesDir, `${id}.json`));
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
	}

	/** @internal Caller holds the lock. */
	async writeJobs(jobs: readonly TranscriptSummaryJob[]): Promise<void> {
		await writeFileAtomic(
			this.jobsPath,
			`${JSON.stringify({ schemaVersion: TRANSCRIPT_SUMMARY_SCHEMA_VERSION, jobs })}\n`,
			{
				mode: 0o600,
			},
		);
	}

	/**
	 * @internal Caller holds the lock. The writer never persists more than {@link TRANSCRIPT_SUMMARY_MAX_PERSISTED_JOBS}
	 * live jobs (`saveJobs` refuses with `jobs_overflow`), so a live entry past that bound is damage like any other: it is
	 * reported as `jobs_corrupt` and left out, and recovery rewrites the bounded list and records possibly lost proof.
	 */
	async readJobs(issues: TranscriptSummaryRecoveryIssue[]): Promise<TranscriptSummaryJob[]> {
		let raw: string;
		try {
			raw = await fs.readFile(this.jobsPath, "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return [];
			throw error;
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			issues.push({
				kind: "jobs_corrupt",
				detail: `jobs.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			});
			return [];
		}
		if (
			!isPlainRecord(value) ||
			value.schemaVersion !== TRANSCRIPT_SUMMARY_SCHEMA_VERSION ||
			!Array.isArray(value.jobs)
		) {
			issues.push({ kind: "jobs_corrupt", detail: "jobs.json has an unsupported shape" });
			return [];
		}
		const jobs: TranscriptSummaryJob[] = [];
		const seen = new Set<string>();
		let live = 0;
		let overLive = 0;
		for (const entry of value.jobs) {
			const parsed = parseSummaryJob(entry);
			if (!parsed.ok) {
				issues.push({ kind: "jobs_corrupt", detail: parsed.reason });
				continue;
			}
			if (seen.has(parsed.job.id)) {
				issues.push({ kind: "jobs_corrupt", detail: `duplicate job ${parsed.job.id}` });
				continue;
			}
			seen.add(parsed.job.id);
			if (!isTerminalSummaryJobState(parsed.job.state)) {
				if (live >= TRANSCRIPT_SUMMARY_MAX_PERSISTED_JOBS) {
					overLive += 1;
					continue;
				}
				live += 1;
			}
			jobs.push(parsed.job);
		}
		if (overLive > 0) {
			issues.push({
				kind: "jobs_corrupt",
				detail: `${overLive} live jobs past the bound of ${TRANSCRIPT_SUMMARY_MAX_PERSISTED_JOBS} the writer keeps`,
			});
		}
		return jobs;
	}

	/**
	 * @internal Caller holds the lock. Damaged entries are reported and left out; the rest are kept. The
	 * earlier shape (one `{at, basis}` record per source under `anchors`) is read too: its session-timestamp
	 * records fold into one record per session, so no valid anchor is lost by the change of shape.
	 */
	async readAnchors(issues: TranscriptSummaryRecoveryIssue[]): Promise<TranscriptRetentionAnchors> {
		const anchors: TranscriptRetentionAnchors = { sources: {}, sessions: {} };
		const raw = await this.readOptional(this.anchorsPath);
		if (raw === undefined) return anchors;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			issues.push({
				kind: "anchors_corrupt",
				detail: `retention-anchors.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			});
			return anchors;
		}
		if (!isPlainRecord(value) || value.schemaVersion !== TRANSCRIPT_SUMMARY_SCHEMA_VERSION) {
			issues.push({ kind: "anchors_corrupt", detail: "retention-anchors.json has an unsupported shape" });
			return anchors;
		}
		const validAt = (entry: unknown): entry is Record<string, unknown> & { at: string } =>
			isPlainRecord(entry) && typeof entry.at === "string" && !Number.isNaN(Date.parse(entry.at));
		let damaged = 0;
		const foldSession = (sessionId: string, at: string, sources: readonly string[]) => {
			const known = anchors.sessions[sessionId];
			if (!known) {
				anchors.sessions[sessionId] = { at, sources: [...sources] };
				return;
			}
			if (Date.parse(at) < Date.parse(known.at)) known.at = at;
			for (const key of sources) if (!known.sources.includes(key)) known.sources.push(key);
		};
		if (isPlainRecord(value.sources)) {
			for (const [handle, entry] of Object.entries(value.sources)) {
				if (validAt(entry)) anchors.sources[handle] = { at: entry.at };
				else damaged += 1;
			}
		}
		if (isPlainRecord(value.sessions)) {
			for (const [sessionId, entry] of Object.entries(value.sessions)) {
				if (
					validAt(entry) &&
					Array.isArray(entry.sources) &&
					entry.sources.every((key) => typeof key === "string")
				) {
					foldSession(sessionId, entry.at, entry.sources as string[]);
				} else damaged += 1;
			}
		}
		if (isPlainRecord(value.anchors)) {
			for (const [handle, entry] of Object.entries(value.anchors)) {
				if (!validAt(entry) || (entry.basis !== "session_timestamp" && entry.basis !== "first_capture")) {
					damaged += 1;
				} else if (entry.basis === "first_capture") {
					anchors.sources[handle] = { at: entry.at };
				} else {
					foldSession(sessionOfHandle(handle) ?? "", entry.at, [sourceKeyOfHandle(handle)]);
				}
			}
		}
		if (damaged > 0) {
			issues.push({ kind: "anchors_corrupt", detail: `${damaged} retention anchor entr(ies) are invalid` });
		}
		return anchors;
	}

	/** @internal Caller holds the lock. */
	async writeAnchors(anchors: TranscriptRetentionAnchors): Promise<void> {
		await writeFileAtomic(
			this.anchorsPath,
			`${JSON.stringify({ schemaVersion: TRANSCRIPT_SUMMARY_SCHEMA_VERSION, sources: anchors.sources, sessions: anchors.sessions })}\n`,
			{ mode: 0o600 },
		);
	}

	/**
	 * @internal Caller holds the lock. Damaged entries are reported and left out; the rest are kept (the recovery
	 * that rewrites them also records the possible loss, see `applyRecovery`). A file in the shape written before
	 * reservations existed reads as spent budgets; if it is full, its writer pruned failed jobs unrecorded and
	 * counted the refusals only in memory, so proof may have been lost: `lostProofSince` is set to now and
	 * persisted by the next ledger write.
	 */
	async readProof(issues: TranscriptSummaryRecoveryIssue[]): Promise<ProofLedger> {
		const ledger: ProofLedger = { records: {}, current: false };
		const raw = await this.readOptional(this.spentPath);
		if (raw === undefined) return ledger;
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			issues.push({
				kind: "spent_corrupt",
				detail: `spent-attempts.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			});
			return ledger;
		}
		if (
			!isPlainRecord(value) ||
			value.schemaVersion !== TRANSCRIPT_SUMMARY_SCHEMA_VERSION ||
			!isPlainRecord(value.jobs)
		) {
			issues.push({ kind: "spent_corrupt", detail: "spent-attempts.json has an unsupported shape" });
			return ledger;
		}
		let damaged = 0;
		for (const [id, entry] of Object.entries(value.jobs)) {
			const record = parseProofRecord(entry);
			if (record) ledger.records[id] = record;
			else damaged += 1;
		}
		if (damaged > 0) {
			issues.push({ kind: "spent_corrupt", detail: `${damaged} terminal-proof record(s) are invalid` });
		}
		ledger.current = value.proofVersion === PROOF_LEDGER_VERSION;
		if (ledger.current) {
			if (isInstant(value.saturatedSince)) ledger.saturatedSince = value.saturatedSince;
			if (isInstant(value.lostProofSince)) ledger.lostProofSince = value.lostProofSince;
		} else if (Object.keys(ledger.records).length >= TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS) {
			ledger.lostProofSince = new Date(this.now()).toISOString();
		}
		return ledger;
	}

	/** @internal Caller holds the lock. Always written in the current shape. */
	async writeProof(ledger: ProofLedger): Promise<void> {
		const { records, saturatedSince, lostProofSince } = ledger;
		await writeFileAtomic(
			this.spentPath,
			`${JSON.stringify({
				schemaVersion: TRANSCRIPT_SUMMARY_SCHEMA_VERSION,
				proofVersion: PROOF_LEDGER_VERSION,
				jobs: records,
				...(saturatedSince !== undefined ? { saturatedSince } : {}),
				...(lostProofSince !== undefined ? { lostProofSince } : {}),
			})}\n`,
			{ mode: 0o600 },
		);
		ledger.current = true;
	}

	/** @internal Caller holds the lock. Keep the damaged bytes of one derived file beside it. */
	async backupCorrupt(file: "jobs" | "anchors" | "spent"): Promise<void> {
		const path = file === "jobs" ? this.jobsPath : file === "anchors" ? this.anchorsPath : this.spentPath;
		const raw = await this.readOptional(path);
		if (raw !== undefined) await writeFileAtomic(`${path}.corrupt.${this.now()}`, raw, { mode: 0o600 });
	}

	private async readOptional(path: string): Promise<string | undefined> {
		try {
			return await fs.readFile(path, "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return undefined;
			throw error;
		}
	}

	/** @internal Caller holds the lock. */
	async readTerminals(issues: TranscriptSummaryRecoveryIssue[]): Promise<TranscriptSummaryTerminalRecord[]> {
		let raw: string;
		try {
			raw = await fs.readFile(this.terminalsPath, "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return [];
			throw error;
		}
		try {
			const value: unknown = JSON.parse(raw);
			if (
				!isPlainRecord(value) ||
				value.schemaVersion !== TRANSCRIPT_SUMMARY_SCHEMA_VERSION ||
				!Array.isArray(value.events)
			) {
				throw new Error("unsupported shape");
			}
			return value.events.filter(isTerminalRecord);
		} catch (error) {
			issues.push({
				kind: "terminals_corrupt",
				detail: `terminals.json is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			});
			return [];
		}
	}

	/** @internal Caller holds the lock. */
	async writeTerminals(events: readonly TranscriptSummaryTerminalRecord[]): Promise<void> {
		await writeFileAtomic(
			this.terminalsPath,
			`${JSON.stringify({ schemaVersion: TRANSCRIPT_SUMMARY_SCHEMA_VERSION, events })}\n`,
			{ mode: 0o600 },
		);
	}

	/** @internal Caller holds the lock. */
	async readNodeFileRaw(id: string): Promise<string | undefined> {
		try {
			return await fs.readFile(join(this.nodesDir, `${id}.json`), "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return undefined;
			throw error;
		}
	}

	/**
	 * @internal Caller holds the lock. Remove what nothing will read again once it is older than `minAgeMs`: files in
	 * `nodes/` that `referenced` does not name (node content whose publication never reached the manifest) and staged
	 * temporary files at the store root (`*.tmp`, left by a crash between writing and renaming; a write that fails removes
	 * its own). Damaged-file backups (`*.corrupt.*`), the lock and the store's own files are never touched. A younger file
	 * is kept: its writer may still be publishing it. Returns the removed paths, relative to the store root.
	 */
	async sweep(referenced: ReadonlySet<string>, minAgeMs: number): Promise<string[]> {
		const removed: string[] = [];
		const cutoff = this.now() - minAgeMs;
		for (const name of await this.listDirectory(this.nodesDir)) {
			const id = name.endsWith(".json") ? name.slice(0, -".json".length) : undefined;
			if (id !== undefined && referenced.has(id)) continue;
			if (await this.removeOlderThan(join(this.nodesDir, name), cutoff)) removed.push(`nodes/${name}`);
		}
		for (const name of await this.listDirectory(this.root)) {
			if (name.endsWith(".tmp") && (await this.removeOlderThan(join(this.root, name), cutoff))) removed.push(name);
		}
		return removed;
	}

	/** The names in a directory; none when it does not exist. */
	private async listDirectory(path: string): Promise<string[]> {
		try {
			return await fs.readdir(path);
		} catch (error) {
			if (isMissingFileError(error)) return [];
			throw error;
		}
	}

	/** Unlink `path` when its modification time is at or before `cutoff`; true when this call removed it. */
	private async removeOlderThan(path: string, cutoff: number): Promise<boolean> {
		let mtimeMs: number;
		try {
			mtimeMs = (await fs.stat(path)).mtimeMs;
		} catch (error) {
			if (isMissingFileError(error)) return false;
			throw error;
		}
		if (mtimeMs > cutoff) return false;
		try {
			await fs.unlink(path);
			return true;
		} catch (error) {
			if (isMissingFileError(error)) return false;
			throw error;
		}
	}

	/** @internal */
	clock(): number {
		return this.now();
	}
}

// ---------------------------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------------------------

/** One lease holder. Every method re-checks the fence under the lock; a superseded writer only ever gets `fenced`. */
export class TranscriptSummaryWriter {
	readonly fence: number;
	private readonly store: TranscriptSummaryStore;

	constructor(store: TranscriptSummaryStore, fence: number) {
		this.store = store;
		this.fence = fence;
	}

	/**
	 * Run `body` under the store lock with the manifest this writer's fence still owns. The one owner of the
	 * fence check: a missing or corrupt manifest and a superseded fence come back as typed refusals before
	 * the body runs. The write boundary too: an I/O or lock failure anywhere in the section (`what` names the write)
	 * comes back as the typed `unavailable` {@link storeUnavailable} classifies, so the caller handles it like any other
	 * refusal; anything else is a programming error and still rejects.
	 */
	private async fenced<T>(
		what: string,
		body: (manifest: TranscriptSummaryManifest) => Promise<T>,
	): Promise<
		| T
		| { status: "manifest_corrupt"; detail: string }
		| { status: "fenced"; currentFence: number }
		| TranscriptSummaryStoreUnavailable
	> {
		try {
			return await this.store.locked(async () => {
				const read = await this.store.readManifestFile();
				if (read.status !== "ok") {
					return read.status === "corrupt"
						? { status: "manifest_corrupt" as const, detail: read.detail }
						: { status: "fenced" as const, currentFence: 0 };
				}
				if (read.manifest.writerFence !== this.fence) {
					return { status: "fenced" as const, currentFence: read.manifest.writerFence };
				}
				return body(read.manifest);
			});
		} catch (error) {
			const unavailable = storeUnavailable(what, error);
			if (unavailable) return unavailable;
			throw error;
		}
	}

	/**
	 * Caller holds the lock under this writer's fence, after writing state a reader loads outside the manifest
	 * (anchors, a node file's admission). The manifest revision is what a reader compares to know `load()` would
	 * now return something else, so such a write advances it in the same fenced section; the returned revision
	 * is the writer's new expected revision.
	 */
	private async advanceRevision(manifest: TranscriptSummaryManifest): Promise<number> {
		const revision = manifest.revision + 1;
		await this.store.writeManifest({ ...manifest, revision });
		return revision;
	}

	/** Accept nodes, advance cursors and set frontiers in one manifest write. */
	async publish(transaction: TranscriptSummaryPublishTransaction): Promise<TranscriptSummaryPublishResult> {
		return this.fenced("publishing to the summary store", async (manifest) => {
			if (transaction.expectedRevision !== undefined && transaction.expectedRevision !== manifest.revision) {
				return { status: "stale_revision" as const, currentRevision: manifest.revision };
			}
			const incoming = [...(transaction.nodes ?? [])].sort((a, b) => a.level - b.level);
			const revoked = incoming
				.filter((node) => manifest.tombstones[node.id]?.reason === "retention")
				.map((node) => node.id);
			if (revoked.length > 0) return { status: "revoked" as const, nodeIds: revoked };

			// Validate in level order so a parent can see children accepted earlier in the same transaction.
			const known = new Map<string, TranscriptSummaryNode>();
			const lookup = async (id: string): Promise<TranscriptSummaryNode | undefined> => {
				const inTransaction = known.get(id);
				if (inTransaction) return inTransaction;
				if (!manifest.acceptedNodes[id]) return undefined;
				const result = await this.store.readNode(id);
				return result.status === "ok" ? result.node : undefined;
			};
			for (const node of incoming) {
				const parsed = parseSummaryNode(JSON.parse(JSON.stringify(node)));
				if (!parsed.ok) return { status: "invalid" as const, reason: `node ${node.id}: ${parsed.reason}` };
				// A model summary is accepted only with an admission under the current contract: an unadmitted one is
				// never published, so "accepted and unapproved" can only be a node from before the contract.
				if (needsReadmission(parsed.node)) {
					return {
						status: "invalid" as const,
						reason: `node ${node.id}: a model summary needs an admission under contract ${TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION}`,
					};
				}
				if (node.children) {
					const left = await lookup(node.children[0]);
					const right = await lookup(node.children[1]);
					if (!left || !right) {
						return {
							status: "invalid" as const,
							reason: `node ${node.id}: a child is not accepted or not readable`,
						};
					}
					const check = validateParentChildren(node, left, right);
					if (!check.ok) return { status: "invalid" as const, reason: `node ${node.id}: ${check.reason}` };
				}
				known.set(node.id, node);
			}

			// Node content first. An accepted id is immutable: different content under it is a conflict.
			for (const node of incoming) {
				if (manifest.acceptedNodes[node.id]) {
					const existing = await this.store.readNode(node.id);
					if (existing.status === "ok" && existing.node.text !== node.text) {
						return {
							status: "invalid" as const,
							reason: `node ${node.id} is already accepted with different content`,
						};
					}
					if (existing.status === "ok") continue;
				}
				await this.store.writeNodeFile(node);
			}

			// Every referenced node must be accepted and readable before any reference is published.
			const accepted = new Set([...Object.keys(manifest.acceptedNodes), ...incoming.map((node) => node.id)]);
			const referenced = new Set<string>(incoming.map((node) => node.id));
			for (const frontier of Object.values(transaction.frontiers ?? {})) {
				for (const nodeId of frontier.nodeIds) {
					if (!accepted.has(nodeId)) {
						return { status: "invalid" as const, reason: `frontier references unaccepted node ${nodeId}` };
					}
					referenced.add(nodeId);
				}
			}
			for (const id of referenced) {
				const result = await this.store.readNode(id);
				if (result.status !== "ok") {
					return {
						status: "invalid" as const,
						reason: `node ${id} is ${result.status === "missing" ? "missing" : `corrupt (${result.reason})`}`,
					};
				}
			}

			const next: TranscriptSummaryManifest = {
				...manifest,
				revision: manifest.revision + 1,
				sessions: { ...manifest.sessions, ...(transaction.sessions ?? {}) },
				acceptedNodes: { ...manifest.acceptedNodes },
				frontiers: { ...manifest.frontiers, ...(transaction.frontiers ?? {}) },
				dormant: { ...manifest.dormant },
			};
			for (const name of transaction.removeFrontiers ?? []) delete next.frontiers[name];
			for (const node of incoming) {
				// Accepting a dormant identity unparks it in the same write (its file now holds the accepted content).
				delete next.dormant[node.id];
				next.acceptedNodes[node.id] = {
					level: node.level,
					ordinal: node.ordinal,
					sessionId: node.sessionId,
					fromIndex: node.spanRange.fromIndex,
					toIndexExclusive: node.spanRange.toIndexExclusive,
					...(node.children ? { children: node.children } : {}),
					contextRefs: node.contextRefs.map(formatTranscriptSourceHandle),
					...(node.oldestDependencyAt !== undefined ? { oldestDependencyAt: node.oldestDependencyAt } : {}),
				};
			}
			await this.store.writeManifest(next);
			return { status: "published" as const, revision: next.revision, accepted: incoming.map((node) => node.id) };
		});
	}

	/**
	 * Record a current admission on an already accepted model summary (re-admission of a node accepted before
	 * the admission contract, or under an older one). The node's identity, text and coverage are untouched: the
	 * admission must be for exactly the stored text, and the file is rewritten atomically with only the record added.
	 */
	async annotateAdmission(
		nodeId: string,
		admission: TranscriptSummaryAdmissionRecord,
	): Promise<TranscriptSummaryAnnotateResult> {
		return this.fenced("recording a summary admission", async (manifest) => {
			if (!manifest.acceptedNodes[nodeId]) return { status: "not_accepted" as const };
			const read = await this.store.readNode(nodeId);
			if (read.status !== "ok") {
				return { status: "unreadable" as const, reason: read.status === "missing" ? "missing" : read.reason };
			}
			if (read.node.quality !== "model_summary") {
				return { status: "invalid" as const, reason: "only a model summary carries an admission" };
			}
			if (admission.textDigest !== summaryTextDigest(read.node.text)) {
				return { status: "invalid" as const, reason: "the admission judged different text than the node holds" };
			}
			const annotated: TranscriptSummaryNode = { ...read.node, admission };
			const parsed = parseSummaryNode(JSON.parse(JSON.stringify(annotated)));
			if (!parsed.ok) return { status: "invalid" as const, reason: parsed.reason };
			if (needsReadmission(parsed.node)) {
				return {
					status: "invalid" as const,
					reason: `the admission is not under contract ${TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION}`,
				};
			}
			await this.store.writeNodeFile(parsed.node);
			// The annotation changes the node a reader loads (it becomes approved): the revision says so.
			return { status: "annotated" as const, node: parsed.node, revision: await this.advanceRevision(manifest) };
		});
	}

	/**
	 * Revoke every accepted node the predicate matches and, transitively, every node that has a revoked
	 * node as a child. Frontiers naming a revoked node are removed, session cursors are pulled back to the
	 * earliest revoked position, and the node files are deleted after the manifest no longer references
	 * them. `retention` additionally tombstones the ids so a late result cannot republish forgotten content.
	 *
	 * Dormant nodes: with `park` (an `invalidated` revocation only: coverage that left the live lineage) the
	 * revoked nodes are parked as dormant and their files kept instead of deleted. Dormant nodes of
	 * `tombstoneSession` / `dropSessionCursor` (forgetting, a vanished session) and those `purgeDormant` matches
	 * are purged and their files deleted; a `retention` purge also tombstones them. Past
	 * {@link TRANSCRIPT_SUMMARY_MAX_DORMANT_NODES} the oldest parked are evicted. All in the same manifest write.
	 */
	async revokeNodes(
		predicate: (id: string, entry: TranscriptSummaryAcceptedNode) => boolean,
		reason: TranscriptSummaryRevocationReason,
		options: {
			dropSessionCursor?: string;
			tombstoneSession?: string;
			park?: boolean;
			purgeDormant?: (id: string, entry: TranscriptSummaryDormantEntry) => boolean;
		} = {},
	): Promise<TranscriptSummaryRevokeResult> {
		if (options.park === true && reason !== "invalidated") {
			throw new RangeError("Only an invalidated revocation parks nodes as dormant.");
		}
		return this.fenced("revoking summary nodes", async (manifest) => {
			return this.applyRevocation(manifest, predicate, reason, {
				...(options.dropSessionCursor !== undefined ? { dropSessionCursor: options.dropSessionCursor } : {}),
				...(options.tombstoneSession !== undefined ? { tombstoneSession: options.tombstoneSession } : {}),
				park: options.park === true,
				...(options.purgeDormant ? { purgeDormant: options.purgeDormant } : {}),
			});
		});
	}

	/**
	 * Drop everything derived from one session: its nodes, the nodes in other sessions that consulted it as
	 * context, all of their ancestors, and its source cursor, in a single publish.
	 */
	async invalidateSession(sessionId: string): Promise<TranscriptSummaryRevokeResult> {
		return this.revokeNodes(
			(_id, entry) =>
				entry.sessionId === sessionId || entry.contextRefs.some((handle) => sessionOfHandle(handle) === sessionId),
			"invalidated",
			{ dropSessionCursor: sessionId },
		);
	}

	/**
	 * Replace the persisted job list and keep the terminal-proof ledger in step with it, in one fenced write (the
	 * ledger first, so a crash leaves at worst a record the list no longer needs, never a list that outran its
	 * proof). In order:
	 *  1. a reservation or carried record whose job ended without spending a budget (ready, or stale/cancelled
	 *     before any attempt) is released, and so is a reservation whose job is gone; a carried record whose job
	 *     was pruned stays;
	 *  2. a failed job's record becomes its spent budget in place, and a job that went stale or was cancelled after
	 *     starting attempts keeps them as a carried record (found again, it resumes with them); one without a
	 *     record (written before reservations existed, or after damage) takes a free slot, else it has no durable
	 *     equivalent yet;
	 *  3. every live job without a record is reserved below {@link TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS}, else
	 *     `refused`: its owner must not let it reach a provider;
	 *  4. the capacity hold follows the count.
	 * Terminal jobs are then pruned oldest-first; live work is never pruned, and neither is a job whose spent or
	 * carried attempts have no durable record: it stays in the list (past its bound, counted in `retained`) until
	 * one exists.
	 */
	async saveJobs(
		jobs: readonly TranscriptSummaryJob[],
		options: { rekeys?: readonly TranscriptSummaryRekey[] } = {},
	): Promise<TranscriptSummaryJobsSaveResult> {
		return this.fenced("saving jobs", async () => {
			const live = jobs.filter((job) => !isTerminalSummaryJobState(job.state));
			if (live.length > TRANSCRIPT_SUMMARY_MAX_PERSISTED_JOBS) {
				return { status: "jobs_overflow" as const, active: live.length };
			}
			const ledger = await this.store.readProof([]);
			const { records } = ledger;
			const at = this.store.clock();
			const byId = new Map(jobs.map((job) => [job.id, job]));
			const proof: Record<string, TranscriptSummaryProofRecord> = {};
			const released: string[] = [];
			const refused: string[] = [];
			const unproven = new Set<string>();
			// Capture-version budgets the scheduler matched to their current job key move or merge first, before anything
			// is released or recorded under either key (a version 1 job's key is no longer any live job's). A merge
			// records its total on the current record and removes the version 1 record in this one ledger write, so it
			// is applied exactly once and never lost to a crash before the job list is written.
			const rekeyed: TranscriptSummaryRekey[] = [];
			for (const rekey of options.rekeys ?? []) {
				const { from, to, merged } = rekey;
				const record = records[from];
				// Nothing is left under the version 1 key (an earlier save applied this move before it failed, or the
				// session's records were dropped): the move is settled, not pending.
				if (record === undefined) {
					rekeyed.push(rekey);
					continue;
				}
				if (record.kind !== "spent" && record.kind !== "carried") continue;
				const target = records[to];
				let next: TranscriptSummaryProofRecord;
				if (target === undefined) next = record;
				else if (merged === undefined) continue;
				else if (target.kind === "reserved")
					next = { ...target, attemptsFloor: Math.max(target.attemptsFloor ?? 0, merged) };
				else if (target.kind === "carried") next = { ...target, attempts: Math.max(target.attempts, merged) };
				// A spent budget is final: only the version 1 record leaves.
				else next = target;
				records[to] = next;
				delete records[from];
				proof[to] = next;
				rekeyed.push(rekey);
			}
			for (const [id, record] of Object.entries(records)) {
				if (record.kind === "spent") continue;
				const job = byId.get(id);
				// A carried record outlives its pruned job (that is its purpose); a reservation does not.
				const needed = job ? proofKindFor(job) : record.kind === "carried" ? "carried" : undefined;
				if (needed === undefined) {
					delete records[id];
					released.push(id);
				}
			}
			let count = Object.keys(records).length;
			for (const job of jobs) {
				const needed = proofKindFor(job);
				if (needed !== "spent" && needed !== "carried") continue;
				const held = records[job.id];
				if (held?.kind === "spent") continue;
				if (needed === "carried" && held?.kind === "carried" && held.attempts >= job.attempts) continue;
				// A held record becomes the budget in its own slot; a job without one needs a free slot, else it keeps
				// its evidence in the job list (see `unproven`).
				if (held === undefined && count >= TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS) {
					unproven.add(job.id);
					continue;
				}
				if (held === undefined) count += 1;
				const endedAt = job.terminalAt ?? job.updatedAt;
				const record: TranscriptSummaryProofRecord =
					needed === "spent"
						? {
								kind: "spent",
								sessionId: job.sessionId,
								attempts: job.attempts,
								maxAttempts: job.maxAttempts,
								reason: job.lastError?.reason ?? "failed",
								message: (job.lastError?.message ?? "").slice(0, MAX_SPENT_MESSAGE_CHARS),
								at: endedAt,
							}
						: { kind: "carried", sessionId: job.sessionId, attempts: job.attempts, at: endedAt };
				records[job.id] = record;
				proof[job.id] = record;
			}
			for (const job of live) {
				if (records[job.id] !== undefined) continue;
				if (count >= TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS) {
					refused.push(job.id);
					continue;
				}
				const record: TranscriptSummaryProofRecord = { kind: "reserved", sessionId: job.sessionId, at };
				records[job.id] = record;
				proof[job.id] = record;
				count += 1;
			}
			const holdChanged = noteSaturation(ledger, at);
			if (
				!ledger.current ||
				holdChanged ||
				rekeyed.length > 0 ||
				released.length > 0 ||
				Object.keys(proof).length > 0
			) {
				await this.store.writeProof(ledger);
			}
			// Records this save found and kept are acknowledged too, after the write decision (they changed nothing on disk).
			for (const job of jobs) {
				const held = records[job.id];
				if (held !== undefined) proof[job.id] ??= held;
			}
			const terminal = jobs
				.filter((job) => isTerminalSummaryJobState(job.state))
				.sort((a, b) => (b.terminalAt ?? b.updatedAt) - (a.terminalAt ?? a.updatedAt));
			const keepTerminal = terminal.slice(0, TRANSCRIPT_SUMMARY_MAX_PERSISTED_JOBS - live.length);
			const prunable = terminal.slice(keepTerminal.length);
			const pruned = prunable.filter((job) => !unproven.has(job.id)).map((job) => job.id);
			const prunedIds = new Set(pruned);
			await this.store.writeJobs(jobs.filter((job) => !prunedIds.has(job.id)));
			return {
				status: "saved" as const,
				pruned,
				proof,
				released,
				refused,
				retained: prunable.length - pruned.length,
				rekeyed,
				ledger: proofStatus(ledger),
			};
		});
	}

	/**
	 * Record retention anchors, set-if-absent: an existing anchor is never replaced, which is what keeps a
	 * source's age across invalidation, re-admission and recipe rebuilds. Anchors live outside recipes, nodes
	 * and jobs. A session-timestamp anchor is one record per session; a first-capture anchor is per source. At
	 * the ceiling nothing is evicted; the refused handles are returned so the caller can hold the work with an
	 * explicit cause instead of treating those sources as ageless.
	 */
	async anchorSources(requests: readonly TranscriptAnchorRequest[]): Promise<TranscriptSummaryAnchorResult> {
		return this.fenced("recording retention anchors", async (manifest) => {
			const anchors = await this.store.readAnchors([]);
			let count = anchoredCount(anchors);
			let added = 0;
			const refused: string[] = [];
			const recorded: TranscriptAnchorRequest[] = [];
			const moved: string[] = [];
			for (const request of requests) {
				const { handle, at, basis } = request;
				const sessionId = sessionOfHandle(handle) ?? "";
				const key = sourceKeyOfHandle(handle);
				// Already held: reported with the age the store holds, so `recorded` names every anchor requested.
				const held = anchors.sources[handle];
				if (held) {
					recorded.push({ handle, at: held.at, basis: "first_capture" });
					continue;
				}
				const session = anchors.sessions[sessionId];
				if (session?.sources.includes(key)) {
					recorded.push({ handle, at: session.at, basis: "session_timestamp" });
					continue;
				}
				const { legacyHandle } = request;
				const carried = legacyHandle === undefined ? undefined : moveLegacyAnchor(anchors, legacyHandle, handle);
				if (carried && legacyHandle !== undefined) {
					recorded.push(carried);
					moved.push(legacyHandle);
					continue;
				}
				if (count >= TRANSCRIPT_SUMMARY_MAX_RETENTION_ANCHORS) {
					refused.push(handle);
					continue;
				}
				if (basis === "first_capture") {
					anchors.sources[handle] = { at };
					recorded.push({ handle, at, basis });
				} else {
					// A source joins its session's one anchor, and carries that anchor's age.
					const joined = session ?? { at, sources: [] };
					joined.sources.push(key);
					anchors.sessions[sessionId] = joined;
					recorded.push({ handle, at: joined.at, basis });
				}
				count += 1;
				added += 1;
			}
			let revision = manifest.revision;
			if (added > 0 || moved.length > 0) {
				await this.store.writeAnchors(anchors);
				revision = await this.advanceRevision(manifest);
			}
			return refused.length > 0
				? { status: "capacity" as const, added, recorded, moved, refused, revision }
				: { status: "saved" as const, added, recorded, moved, revision };
		});
	}

	/**
	 * Forget what is kept per session (retention anchors, spent-attempt records and dormant nodes) for sessions that are
	 * forgotten for good or no longer exist. Never by age: an age-based drop would reset a source's age or grant
	 * a spent job a fresh budget. This is the only way a spent or carried record leaves the ledger. Reservations are not
	 * dropped here: they end with their job in `saveJobs`, so a live job of such a session keeps its slot. A
	 * freed slot lifts a capacity hold, never `lostProofSince`.
	 */
	async dropSessionRecords(sessionIds: ReadonlySet<string>): Promise<TranscriptSummarySessionRecordsResult> {
		return this.fenced("dropping session records", async (manifest) => {
			const anchors = await this.store.readAnchors([]);
			let droppedAnchors = 0;
			for (const handle of Object.keys(anchors.sources)) {
				if (sessionIds.has(sessionOfHandle(handle) ?? "")) {
					delete anchors.sources[handle];
					droppedAnchors += 1;
				}
			}
			for (const sessionId of Object.keys(anchors.sessions)) {
				if (sessionIds.has(sessionId)) {
					droppedAnchors += anchors.sessions[sessionId]?.sources.length ?? 0;
					delete anchors.sessions[sessionId];
				}
			}
			const dormant = { ...manifest.dormant };
			const purged = Object.keys(dormant).filter((id) => sessionIds.has(dormant[id]?.sessionId ?? ""));
			for (const id of purged) delete dormant[id];
			let revision = manifest.revision;
			if (droppedAnchors > 0) await this.store.writeAnchors(anchors);
			if (droppedAnchors > 0 || purged.length > 0) {
				revision = await this.advanceRevision({ ...manifest, dormant });
				// The manifest no longer references them; only now remove their content.
				for (const id of purged) await this.store.unlinkNodeFile(id);
			}
			const ledger = await this.store.readProof([]);
			let droppedSpent = 0;
			for (const [id, record] of Object.entries(ledger.records)) {
				if (record.kind !== "reserved" && sessionIds.has(record.sessionId)) {
					delete ledger.records[id];
					droppedSpent += 1;
				}
			}
			const holdChanged = noteSaturation(ledger, this.store.clock());
			if (!ledger.current || holdChanged || droppedSpent > 0) await this.store.writeProof(ledger);
			return {
				status: "saved" as const,
				anchors: droppedAnchors,
				spent: droppedSpent,
				dormant: purged,
				ledger: proofStatus(ledger),
				revision,
			};
		});
	}

	/**
	 * Apply the repair for the issues `load()` reported: revoke damaged nodes and their ancestors, drop
	 * dangling frontiers, and rewrite a corrupt job list or proof ledger from its valid entries (the damaged bytes
	 * are kept), recording in the ledger that terminal proof may have been lost.
	 * A corrupt manifest is not repaired here; it is replaced through `acquireWriter({ recoverCorrupt })`.
	 */
	async applyRecovery(issues: readonly TranscriptSummaryRecoveryIssue[]): Promise<TranscriptSummaryRecoveryReport> {
		const damaged = new Set<string>();
		const frontiers = new Set<string>();
		const damagedDormant = new Set<string>();
		let jobsCorrupt = false;
		let anchorsCorrupt = false;
		let spentCorrupt = false;
		for (const issue of issues) {
			if (
				issue.kind === "node_missing" ||
				issue.kind === "node_corrupt" ||
				issue.kind === "node_mismatch" ||
				issue.kind === "child_missing"
			) {
				damaged.add(issue.nodeId);
			} else if (issue.kind === "frontier_dangling") {
				frontiers.add(issue.frontier);
			} else if (issue.kind === "dormant_damaged") {
				// A cache entry that cannot be read is purged; nothing depends on it.
				damagedDormant.add(issue.nodeId);
			} else if (issue.kind === "jobs_corrupt") {
				jobsCorrupt = true;
			} else if (issue.kind === "anchors_corrupt") {
				anchorsCorrupt = true;
			} else if (issue.kind === "spent_corrupt") {
				spentCorrupt = true;
			}
		}
		const report: TranscriptSummaryRecoveryReport = { revoked: [], removedFrontiers: [], jobsRewritten: false };
		if (damaged.size > 0 || frontiers.size > 0 || damagedDormant.size > 0) {
			const result = await this.store.locked(async () => {
				const read = await this.store.readManifestFile();
				if (read.status !== "ok") throw new Error("Recovery needs a readable manifest.");
				if (read.manifest.writerFence !== this.fence) throw new Error("Recovery writer was superseded.");
				const manifest = read.manifest;
				for (const name of frontiers) delete manifest.frontiers[name];
				return this.applyRevocation(manifest, (id) => damaged.has(id), "recovery", {
					alsoRemoveFrontiers: [...frontiers],
					park: false,
					purgeDormant: (id) => damagedDormant.has(id),
				});
			});
			if (result.status !== "published") throw new Error(`Recovery was not published: ${result.status}.`);
			report.revoked = result.revoked;
			report.removedFrontiers = result.removedFrontiers;
		}
		if (jobsCorrupt) {
			await this.rewriteValid(
				() => this.store.readJobs([]),
				() => this.store.backupCorrupt("jobs"),
				(valid) => this.store.writeJobs(valid),
			);
			report.jobsRewritten = true;
		}
		if (anchorsCorrupt) {
			// An anchor lost to damage cannot be reconstructed: that source is anchored again at its next
			// sighting, and the damage stays disclosed as a recovery issue.
			await this.rewriteValid(
				() => this.store.readAnchors([]),
				() => this.store.backupCorrupt("anchors"),
				(valid) => this.store.writeAnchors(valid),
			);
		}
		if (spentCorrupt || jobsCorrupt) {
			// A proof record or a job (and the attempts it carried) lost to damage cannot be reconstructed, and which
			// identity it was is unknowable: the ledger keeps every valid record and records that proof may have been
			// lost now, so no new identity of an existing session can start with a budget it may already have spent.
			const lostAt = new Date(this.store.clock()).toISOString();
			await this.rewriteValid(
				() => this.store.readProof([]),
				() => (spentCorrupt ? this.store.backupCorrupt("spent") : Promise.resolve()),
				(valid) => this.store.writeProof({ ...valid, lostProofSince: lostAt }),
			);
		}
		return report;
	}

	/**
	 * Append one terminal handoff record, keeping the newest {@link TRANSCRIPT_SUMMARY_MAX_TERMINALS}.
	 * Returns false when this writer was superseded (the record is then not persisted).
	 */
	async recordTerminal(record: TranscriptSummaryTerminalRecord): Promise<boolean> {
		return this.store.locked(async () => {
			const read = await this.store.readManifestFile();
			if (read.status !== "ok" || read.manifest.writerFence !== this.fence) return false;
			const events = await this.store.readTerminals([]);
			events.push(record);
			await this.store.writeTerminals(events.slice(-TRANSCRIPT_SUMMARY_MAX_TERMINALS));
			return true;
		});
	}

	/**
	 * Delete node files no accepted or dormant entry references, and staged temporary files at the store root, once they
	 * are old enough that no writer can still publish them (see `sweep`). Nothing is removed by a superseded writer.
	 * The summary coordinator runs it once per start, after recovery.
	 */
	async sweepOrphans(minAgeMs = TRANSCRIPT_SUMMARY_ORPHAN_MIN_AGE_MS): Promise<string[]> {
		return this.store.locked(async () => {
			const read = await this.store.readManifestFile();
			if (read.status !== "ok" || read.manifest.writerFence !== this.fence) return [];
			const referenced = [...Object.keys(read.manifest.acceptedNodes), ...Object.keys(read.manifest.dormant)];
			return this.store.sweep(new Set(referenced), minAgeMs);
		});
	}

	/** Keep the damaged bytes beside the file and rewrite it from its valid entries, under the lock and this writer's fence. */
	private async rewriteValid<T>(
		readValid: () => Promise<T>,
		backup: () => Promise<void>,
		write: (valid: T) => Promise<void>,
	): Promise<void> {
		await this.store.locked(async () => {
			const read = await this.store.readManifestFile();
			if (read.status !== "ok" || read.manifest.writerFence !== this.fence) {
				throw new Error("Recovery writer was superseded.");
			}
			const valid = await readValid();
			await backup();
			await write(valid);
		});
	}

	/** Caller holds the lock and has verified the fence. See {@link revokeNodes} for the dormant rules. */
	private async applyRevocation(
		manifest: TranscriptSummaryManifest,
		predicate: (id: string, entry: TranscriptSummaryAcceptedNode) => boolean,
		reason: TranscriptSummaryRevocationReason,
		options: {
			dropSessionCursor?: string;
			alsoRemoveFrontiers?: readonly string[];
			tombstoneSession?: string;
			park: boolean;
			purgeDormant?: (id: string, entry: TranscriptSummaryDormantEntry) => boolean;
		},
	): Promise<TranscriptSummaryRevokeResult> {
		const { dropSessionCursor, tombstoneSession } = options;
		const revoked = new Set<string>();
		for (const [id, entry] of Object.entries(manifest.acceptedNodes)) {
			if (predicate(id, entry)) revoked.add(id);
		}
		// Ancestors depend on their children; close over the parent edges.
		const parentsOf = new Map<string, string[]>();
		for (const [id, entry] of Object.entries(manifest.acceptedNodes)) {
			for (const child of entry.children ?? []) {
				const parents = parentsOf.get(child);
				if (parents) parents.push(id);
				else parentsOf.set(child, [id]);
			}
		}
		const pending = [...revoked];
		for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
			for (const parent of parentsOf.get(id) ?? []) {
				if (!revoked.has(parent)) {
					revoked.add(parent);
					pending.push(parent);
				}
			}
		}

		const next: TranscriptSummaryManifest = {
			...manifest,
			revision: manifest.revision + 1,
			sessions: { ...manifest.sessions },
			acceptedNodes: { ...manifest.acceptedNodes },
			frontiers: { ...manifest.frontiers },
			tombstones: { ...manifest.tombstones },
			dormant: { ...manifest.dormant },
		};
		const now = new Date(this.store.clock()).toISOString();
		// Dormant nodes of a forgotten or vanished session can never be reused; the others go only when asked.
		const purged: string[] = [];
		for (const [id, entry] of Object.entries(next.dormant)) {
			const purge =
				entry.sessionId === tombstoneSession ||
				entry.sessionId === dropSessionCursor ||
				options.purgeDormant?.(id, entry) === true;
			if (purge) {
				delete next.dormant[id];
				purged.push(id);
				if (reason === "retention") next.tombstones[id] = { revokedAt: now, reason };
			}
		}
		// Only a revoked LEAF moves a session cursor back: leaves are what the cursor counts. A revoked parent
		// leaves its children in place, so the span range it covered is still covered.
		const earliestLeafBySession = new Map<string, { fromIndex: number; ordinal: number }>();
		for (const id of revoked) {
			const entry = manifest.acceptedNodes[id];
			if (!entry) continue;
			const earliest = earliestLeafBySession.get(entry.sessionId);
			if (entry.level === 0 && (earliest === undefined || entry.fromIndex < earliest.fromIndex)) {
				earliestLeafBySession.set(entry.sessionId, { fromIndex: entry.fromIndex, ordinal: entry.ordinal });
			}
			delete next.acceptedNodes[id];
			if (reason === "retention") next.tombstones[id] = { revokedAt: now, reason };
			if (options.park) next.dormant[id] = { sessionId: entry.sessionId, parkedAt: now };
		}
		const dormantIds = Object.keys(next.dormant);
		if (dormantIds.length > TRANSCRIPT_SUMMARY_MAX_DORMANT_NODES) {
			for (const id of dormantIds
				.sort((a, b) => (next.dormant[a]?.parkedAt ?? "").localeCompare(next.dormant[b]?.parkedAt ?? ""))
				.slice(0, dormantIds.length - TRANSCRIPT_SUMMARY_MAX_DORMANT_NODES)) {
				delete next.dormant[id];
				purged.push(id);
			}
		}
		for (const [sessionId, earliest] of earliestLeafBySession) {
			const cursor = next.sessions[sessionId];
			if (cursor && cursor.coveredSpanCount > earliest.fromIndex) {
				next.sessions[sessionId] = {
					...cursor,
					coveredSpanCount: earliest.fromIndex,
					nextOrdinal: earliest.ordinal,
				};
			}
		}
		if (tombstoneSession !== undefined) {
			next.tombstones[`${SESSION_TOMBSTONE_KEY_PREFIX}${tombstoneSession}`] = {
				revokedAt: now,
				reason: "retention",
			};
		}
		if (dropSessionCursor !== undefined) delete next.sessions[dropSessionCursor];
		const removedFrontiers: string[] = [...(options.alsoRemoveFrontiers ?? [])];
		for (const [name, frontier] of Object.entries(next.frontiers)) {
			if (frontier.nodeIds.some((nodeId) => revoked.has(nodeId))) {
				delete next.frontiers[name];
				removedFrontiers.push(name);
			}
		}
		// The bound applies to per-node tombstones (a late result of a retention-revoked node must not republish). A
		// forgotten session's marker is permanent: it is the only durable record that the session is never summarized
		// again, so no amount of later node revocation may evict it.
		const tombstoneIds = Object.keys(next.tombstones).filter((id) => !id.startsWith(SESSION_TOMBSTONE_KEY_PREFIX));
		if (tombstoneIds.length > TRANSCRIPT_SUMMARY_MAX_TOMBSTONES) {
			tombstoneIds
				.sort((a, b) => (next.tombstones[a]?.revokedAt ?? "").localeCompare(next.tombstones[b]?.revokedAt ?? ""))
				.slice(0, tombstoneIds.length - TRANSCRIPT_SUMMARY_MAX_TOMBSTONES)
				.forEach((id) => {
					delete next.tombstones[id];
				});
		}
		await this.store.writeManifest(next);

		// The manifest no longer references the nodes (accepted or dormant); only now remove their content. A parked
		// node keeps its file: the dormant entry references it.
		const parked = [...revoked].filter((id) => next.dormant[id] !== undefined);
		const unlinkFailures: { id: string; error: string }[] = [];
		for (const id of new Set([...[...revoked].filter((id) => next.dormant[id] === undefined), ...purged])) {
			try {
				await this.store.unlinkNodeFile(id);
			} catch (error) {
				unlinkFailures.push({ id, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return {
			status: "published",
			revision: next.revision,
			revoked: [...revoked],
			removedFrontiers,
			parked,
			purged,
			unlinkFailures,
		};
	}
}
