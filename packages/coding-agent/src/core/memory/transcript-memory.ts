/**
 * Transcript memory coordinator: owns the summary hierarchy for one project. It builds leaf summaries
 * from committed history, merges aligned pairs into parents, publishes accepted nodes and frontier
 * selections through the store, enforces retention, and reports bounded diagnostics. It never touches the
 * filesystem, timers, models or sessions directly: everything arrives through the ports below.
 *
 * Event-driven only. Work starts from index-change events, job completions, background-available events
 * and ONE timer armed to the scheduler's earliest retry. There is no polling and no whole-tree scan on an
 * event: a completion touches its own session's nodes, a new span touches the enumeration cursor.
 *
 * Every state change runs on one serial mailbox, so there is no interleaving to reason about; only the
 * model calls and source reads of running jobs are concurrent. A result is published only if the epoch it
 * started in is still live, the memory generation is current, the writer fence still holds and the source
 * spans it summarized are still the live ones; otherwise it is discarded (marked stale), never published.
 *
 * Summaries are untrusted evidence. They carry source handles, never authority: nothing here writes
 * USER/MEMORY/OKF, declares a gate passed or marks a goal done.
 */

import { createHash } from "node:crypto";
import type { SystemOneReceipt } from "../review/system-one-review-port.ts";
import { assertMemoryReadActive, type MemoryReadContext, type MemoryReadEvidence } from "./memory-read-context.ts";
import { BatchAccount, CauseSlots, type TerminalHolds } from "./transcript-batch-account.ts";
import type { CoordinatorHost } from "./transcript-coordinator-host.ts";
import {
	applyRevocationOf,
	dropFrontierSelections,
	endRevokedReadmissionsOf,
	endSessionJobsOf,
	lineageMovedDuring,
	mirrorRevocationOf,
	sessionsOfNodes,
	staleJobsOf,
} from "./transcript-coverage-revocation.ts";
import { ForgetProgress } from "./transcript-forget-progress.ts";
import type {
	TranscriptFrontierGap,
	TranscriptFrontierResult,
	TranscriptFrontierSelection,
} from "./transcript-frontier.ts";
import {
	computeFrontierSelection,
	frontierEvidenceOf,
	frontierExpiredAt,
	frontierNotAdmittedAt,
	frontierSnapshotOf,
	isNodeDenied,
} from "./transcript-frontier-reads.ts";
import { HoldLedger } from "./transcript-hold-ledger.ts";
import type {
	DependencyVerdict,
	JobOutcome,
	PublishedRevocation,
	SourceReadFailure,
} from "./transcript-job-outcome.ts";
import { ENUMERATION_PAGE_SPANS, enumerateSummaryLeaves } from "./transcript-leaf-enumeration.ts";
import {
	formatTranscriptSourceHandle,
	isTerminalSummaryJobState,
	TRANSCRIPT_CAPTURE_VERSION,
	TRANSCRIPT_SUMMARY_CHANGED_IN_FLIGHT,
	TRANSCRIPT_SUMMARY_MAX_BYTES,
	TRANSCRIPT_SUMMARY_RECIPE_VERSION,
	type TranscriptIndexObservation,
	type TranscriptLineageSpansResult,
	type TranscriptReadUnavailable,
	type TranscriptSourceRef,
} from "./transcript-memory-contracts.ts";
import type {
	TranscriptForgetOutcome,
	TranscriptMemoryPorts,
	TranscriptMemorySettings,
	TranscriptMemoryStartResult,
	TranscriptSummarizerPort,
} from "./transcript-memory-ports.ts";
import {
	bounded,
	CLAIM_SUPERSEDED_AFTER_SUMMARY,
	CLAIM_SUPERSEDED_BEFORE_ADMISSION,
	CLAIM_SUPERSEDED_BEFORE_DISPATCH,
	CLAIM_SUPERSEDED_BEFORE_SUMMARY,
	COORDINATOR_NOT_RUNNING,
	describeAdmission,
	describeIssue,
	describeSaveRefusal,
	forgetStateBlock,
	holdReason,
	MAX_HELD_REASON_CHARS,
	READMISSION_WAIT_TEXT,
	RECONCILIATION_WAITING,
	receiptCause,
} from "./transcript-memory-reason-text.ts";
import type {
	TranscriptMemoryModelWorkBlock,
	TranscriptMemoryRevocationRecord,
	TranscriptMemoryStatus,
	TranscriptReadmissionWait,
} from "./transcript-memory-status.ts";
import {
	enqueueReadmissionJobs,
	readmissionCandidatesOf,
	readmissionFailedOf,
	readmissionSourceWaitOf,
	readmissionWaitOf,
	readmissionWriteFailure,
	readmitSummaryNode,
	unapprovedWaitOf,
} from "./transcript-readmission-flow.ts";
import {
	applyRetentionPass,
	dormantRetentionTimeOf,
	isOutsideRetentionWindow,
	nextRetentionDeadline,
	retentionCutoffAt,
	sessionTimestampOf,
	spansExpired,
	spanTimeOf,
} from "./transcript-retention-policy.ts";
import { ReceiptRetryState, RetryBackoff, StoreRetryState } from "./transcript-retry-backoff.ts";
import { TranscriptRunState } from "./transcript-run-lifecycle.ts";
import {
	abortDeniedJobInputs,
	abortSessionJobs,
	dropOrphanedRecordsOf,
	reconcileAllSessions,
	reconcileHeldSessionsOf,
	reconcileSessionOf,
	reconcileSessionReadOf,
	restartDiscoveryOf,
} from "./transcript-session-reconcile.ts";
import {
	type CoverageVerdict,
	lineageStamp,
	type SessionRuntime,
	SessionRuntimes,
	UNVERIFIED_LINEAGE_DIGEST,
	type VerifiedLineage,
	vouchesFor,
} from "./transcript-session-runtime.ts";
import type {
	TranscriptNodeExpander,
	TranscriptNodeExpansion,
	TranscriptSummaryLookup,
	TranscriptSummaryLookupResult,
	TranscriptSummaryReadOptions,
} from "./transcript-source-tools.ts";
import { admissionStatusSnapshot, modelWorkBlockOf, statusSnapshot } from "./transcript-status-snapshot.ts";
import {
	admissionRecordFromResult,
	needsReadmission,
	parseSemanticReceipt,
	receiptsOf,
	summaryTextDigest,
	TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION,
	type TranscriptSummaryAdmissionPort,
	type TranscriptSummaryAdmissionRecord,
	type TranscriptSummaryAdmissionRequest,
	type TranscriptSummaryAdmissionResult,
} from "./transcript-summary-admission.ts";
import { TranscriptBoundedRead } from "./transcript-summary-bounded-read.ts";
import {
	buildLeafNode,
	buildParentNode,
	failureFor,
	makeSummaryNode,
	readmissionRequestFor,
	readSourceText,
	readSummaryContext,
	reusableDormantNode,
} from "./transcript-summary-build.ts";
import {
	coversLiveSpans,
	forgottenNodeIds,
	TranscriptSummaryCatalog,
	type TranscriptSummaryReadContext,
	type TranscriptSummaryReadFence,
} from "./transcript-summary-catalog.ts";
import {
	isCurrentCaptureNode,
	parentJobKey,
	type TranscriptSummaryNode,
	validateSummaryText,
} from "./transcript-summary-node.ts";
import { SUMMARY_SYSTEM_PROMPT, type SummaryRequest } from "./transcript-summary-prompt.ts";
import {
	TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS,
	type TranscriptSummaryClaimToken,
	type TranscriptSummaryFailure,
	type TranscriptSummaryJob,
	type TranscriptSummaryKeptAdmission,
	type TranscriptSummaryPendingReply,
	type TranscriptSummaryPendingVerdict,
	TranscriptSummaryScheduler,
} from "./transcript-summary-scheduler.ts";
import {
	afterTerminalOf,
	forgetDenialOf,
	readLiveDependencyOf,
	readPublishedDependencyOf,
	returnsClaimOf,
	runSummaryJob,
	SummarizerCallError,
	settleAbortedJob,
	settleJobFailure,
	settlePublicationFailureOf,
	thrownPublicationFailureOf,
} from "./transcript-summary-settle.ts";
import {
	type ForgetStateRead,
	forgetRefusalCause,
	type ManifestRead,
	SESSION_TOMBSTONE_KEY_PREFIX,
	storeUnavailable,
	type TranscriptAnchorRequest,
	type TranscriptSummaryAnnotateResult,
	type TranscriptSummaryJobsSaveResult,
	type TranscriptSummaryProofStatus,
	type TranscriptSummaryPublishResult,
	type TranscriptSummaryRevokeResult,
	type TranscriptSummarySessionCursor,
	type TranscriptSummaryStoreState,
	type TranscriptSummaryStoreUnavailable,
	type TranscriptSummaryWriter,
} from "./transcript-summary-store.ts";
import { countRecorded, owedKey, resultFromVerdict, verdictOf } from "./transcript-summary-verdict.ts";

export { TRANSCRIPT_MEMORY_CONTEXT_BYTES, TRANSCRIPT_MEMORY_CONTEXT_SPANS } from "./transcript-summary-build.ts";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** `setTimeout` runs a longer delay immediately; a farther deadline is reached by re-arming. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const MAX_STATUS_ISSUES = 20;

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

export class TranscriptMemory implements TranscriptNodeExpander, TranscriptSummaryLookup {
	private readonly ports: TranscriptMemoryPorts;
	private readonly run = new TranscriptRunState();
	private tail: Promise<void> = Promise.resolve();
	private readonly unsubscribers: (() => void)[] = [];
	private timer: unknown;
	/**
	 * Work in flight, keyed per CLAIM (`claimId`): a re-claim of the same job never replaces an older claim's entry, so
	 * every running controller stays reachable for abort and stop until its own work settles.
	 */
	private readonly inFlight = new Map<number, { jobId: string; controller: AbortController; done: Promise<void> }>();

	private manifestRevision = 0;
	/** The accepted-node mirror, its retention anchors and every read-side check on them. */
	private readonly catalog = new TranscriptSummaryCatalog();
	/**
	 * Dormant nodes mirrored from the store: content of nodes revoked because their coverage left the live lineage,
	 * kept only so the identical identity is republished without paying again. Never in the catalog, never read.
	 */
	private readonly dormant = new Map<string, TranscriptSummaryNode>();
	/** The terminal handoff of a stop, awaited by `stop()` before the writer is released. */
	private stopHandoff: Promise<void> | undefined;
	private readonly cursors = new Map<string, TranscriptSummarySessionCursor>();
	private readonly frontiers = new Map<string, TranscriptFrontierSelection>();
	private readonly frontierBytes = new Map<string, { bytes: number; gap?: TranscriptFrontierGap }>();
	private readonly forgottenSessions = new Set<string>();
	/** The revision of the permanent forget state this mirror reflects (0 before any forget). */
	private forgetRevision = 0;
	private readonly forgets = new ForgetProgress();
	/** The forget revision the manifest records as fully applied (a forget file below it is unknown: rollback). */
	private forgetAppliedRevision = 0;
	/** Owed usage receipts: when they are tried again, and the claims whose provider call was paid. */
	private readonly receipts = new ReceiptRetryState(() => this.ports.now());
	private readonly sessions = new SessionRuntimes();
	/** The terminal-proof capacity the store last reported (load, save, session-record drop); status only. */
	private proofLedger: TranscriptSummaryProofStatus = { recorded: 0, reserved: 0 };
	private lastRevocation: TranscriptMemoryRevocationRecord | undefined;
	/** The save of the latest job list: a started attempt is durable before its provider call. */
	private jobsSaved: Promise<void> = Promise.resolve();
	/**
	 * The durable acknowledgement: each live job's attempt count in the job list the latest successful save of this
	 * run wrote (the snapshot taken when that save started). A claimed attempt reaches a provider only when covered.
	 */
	private readonly durableAttempts = new Map<string, number>();
	/** The kept reply (its text digest) each job had in the job list the latest successful save of this run wrote. */
	private readonly durableReplies = new Map<string, string>();
	/**
	 * The delivery fence's manifest reads: one bounded-read owner per run, created at start and dropped on stop. A
	 * caller owns its wait; the physical flight has one fixed deadline and ends when its last consumer leaves.
	 */
	private manifestReads: TranscriptBoundedRead<{ manifest: ManifestRead; forgotten: ForgetStateRead }> | undefined;
	private readsStopped: Promise<void> | undefined;
	private frontierRead:
		| {
				fence: TranscriptSummaryReadFence;
				observation?: TranscriptIndexObservation;
				context: TranscriptSummaryReadContext;
				selection: TranscriptFrontierSelection;
		  }
		| undefined;
	/** The real cause of the latest failed job save, until a save succeeds. */
	private saveFailure: string | undefined;
	/** The bounded backoff of failed job saves, tried again through the one lifecycle timer. */
	private readonly saveBackoff = new RetryBackoff(() => this.ports.now());
	/** Store work an unavailable write left undone, and the backoff that paces it; see {@link deferStoreWork}. */
	private readonly storeRetry = new StoreRetryState(() => this.ports.now());
	private readonly holds = new HoldLedger();
	private readonly batch: BatchAccount;
	private readonly causes: CauseSlots;
	private jobsDirty = false;
	/** The released-receipt queue version last made durable in `owed-receipts.json`. */
	private owedReceiptsSavedVersion = 0;
	/** Keys (owner session + report id) of the entries in the last owed queue made durable, for the stop's count of newer ones. */
	private owedSavedKeys = new Set<string>();

	private readonly host: CoordinatorHost;

	constructor(ports: TranscriptMemoryPorts) {
		this.ports = ports;
		this.batch = new BatchAccount(() => this.ports.now());
		this.causes = new CauseSlots(() => this.ports.now());
		// Reads of a forgotten session's text are refused at the catalog's one read gate from the moment it is recorded,
		// while the nodes stay indexed for the removal that follows.
		this.catalog.setDenial((node) => this.nodeDenied(node));
		const owner = this;
		this.host = {
			batch: this.batch,
			holds: this.holds,
			run: this.run,
			sessions: this.sessions,
			causes: this.causes,
			abortDeniedInputs: (...args) => abortDeniedJobInputs(this.host, ...args),
			abortSession: (...args) => abortSessionJobs(this.host, ...args),
			admissionStatus: (...args) => admissionStatusSnapshot(this.host, ...args),
			afterRevocation: (...args) => this.afterRevocation(...args),
			anchorRefs: (...args) => this.anchorRefs(...args),
			applyRetention: (...args) => applyRetentionPass(this.host, ...args),
			applyRevocation: (...args) => applyRevocationOf(this.host, ...args),
			buildLeaf: (...args) => buildLeafNode(this.host, ...args),
			buildParent: (...args) => buildParentNode(this.host, ...args),
			catalog: this.catalog,
			certifyCursor: (...args) => this.certifyCursor(...args),
			cursors: this.cursors,
			deferStoreWork: (...args) => this.deferStoreWork(...args),
			dormant: this.dormant,
			dormantRetentionTime: (...args) => dormantRetentionTimeOf(this.host, ...args),
			dropFrontiers: (...args) => dropFrontierSelections(this.host, ...args),
			dropOrphanedSessionRecords: (...args) => dropOrphanedRecordsOf(this.host, ...args),
			dropSessionRecords: (...args) => this.dropSessionRecords(...args),
			egressBlocked: (...args) => this.egressBlocked(...args),
			enqueue: (...args) => this.enqueue(...args),
			enumerateLeaves: (...args) => enumerateSummaryLeaves(this.host, ...args),
			failureFor: (...args) => failureFor(...args),
			fatal: (...args) => this.fatal(...args),
			forgetDenial: (...args) => forgetDenialOf(this.host, ...args),
			get forgetRevision() {
				return owner.forgetRevision;
			},
			forgottenSessions: this.forgottenSessions,
			frontierBytes: this.frontierBytes,
			frontierExpired: (...args) => frontierExpiredAt(this.host, ...args),
			frontierNotAdmitted: (...args) => frontierNotAdmittedAt(this.host, ...args),
			get frontierRead() {
				return owner.frontierRead;
			},
			frontiers: this.frontiers,
			inFlight: this.inFlight,
			invalidateSession: (...args) => this.invalidateSession(...args),
			isExpired: (...args) => spansExpired(this.host, ...args),
			isOutsideRetention: (...args) => isOutsideRetentionWindow(this.host, ...args),
			judge: (...args) => this.judge(...args),
			get lastRevocation() {
				return owner.lastRevocation;
			},
			lineageMoved: (...args) => lineageMovedDuring(this.host, ...args),
			live: (...args) => this.live(...args),
			makeNode: (...args) => makeSummaryNode(this.host, ...args),
			markJobsDirty: (...args) => this.markJobsDirty(...args),
			maybeFinishBatch: (...args) => this.maybeFinishBatch(...args),
			mirrorRevocation: (...args) => mirrorRevocationOf(this.host, ...args),
			modelWorkBlock: (...args) => modelWorkBlockOf(this.host, ...args),
			nextRetentionAt: (...args) => nextRetentionDeadline(this.host, ...args),
			nodeDenied: (...args) => isNodeDenied(this.host, ...args),
			ports: this.ports,
			get proofLedger() {
				return owner.proofLedger;
			},
			pump: (...args) => this.pump(...args),
			queueForgetRefresh: (...args) => this.queueForgetRefresh(...args),
			readContext: (...args) => readSummaryContext(this.host, ...args),
			readLiveDependency: (...args) => readLiveDependencyOf(this.host, ...args),
			readmissionCandidates: (...args) => readmissionCandidatesOf(this.host, ...args),
			readmissionFailed: (...args) => readmissionFailedOf(this.host, ...args),
			readmissionRequest: (...args) => readmissionRequestFor(this.host, ...args),
			readmissionSourceWait: (...args) => readmissionSourceWaitOf(this.host, ...args),
			readmissionWait: (...args) => readmissionWaitOf(this.host, ...args),
			readmitNode: (...args) => readmitSummaryNode(this.host, ...args),
			readText: (...args) => readSourceText(this.host, ...args),
			reconcileHeldSessions: (...args) => reconcileHeldSessionsOf(this.host, ...args),
			reconcileSession: (...args) => reconcileSessionOf(this.host, ...args),
			reconcileSessionRead: (...args) => reconcileSessionReadOf(this.host, ...args),
			republishFrontiers: (...args) => this.republishFrontiers(...args),
			restartDiscovery: (...args) => restartDiscoveryOf(this.host, ...args),
			resumeDeferredEnumeration: (...args) => this.resumeDeferredEnumeration(...args),
			retentionCutoff: (...args) => retentionCutoffAt(this.host, ...args),
			returnsClaim: (...args) => returnsClaimOf(this.host, ...args),
			reusableDormant: (...args) => reusableDormantNode(this.host, ...args),
			revokeDeadCoverage: (...args) => this.revokeDeadCoverage(...args),
			sessionsOf: (...args) => sessionsOfNodes(this.host, ...args),
			sessionTimestamp: (...args) => sessionTimestampOf(this.host, ...args),
			settleAborted: (...args) => settleAbortedJob(this.host, ...args),
			settleFailure: (...args) => settleJobFailure(this.host, ...args),
			spanTime: (...args) => spanTimeOf(this.host, ...args),
			summarizeChecked: (...args) => this.summarizeChecked(...args),
			unapprovedWait: (...args) => unapprovedWaitOf(this.host, ...args),
		};
	}

	/** Whether the permanent forget state denies this node: it names a forgotten session, or a summary it is built on does. */
	private nodeDenied(node: TranscriptSummaryNode, seen: Set<string> = new Set()): boolean {
		return isNodeDenied(this.host, node, seen);
	}

	// ---- lifecycle ----------------------------------------------------------------------------

	async start(): Promise<TranscriptMemoryStartResult> {
		if (this.run.started) return { enabled: true, recoveryIssues: [] };
		const settings = this.ports.settings();
		if (!settings.hierarchy) return this.disable("the summary hierarchy is off");
		if (!this.ports.summarizer) return this.disable("no summarizer is configured");
		this.run.setDisabledReason(undefined);
		this.run.setStarting(true);
		try {
			return await this.startUp(settings);
		} finally {
			this.run.setStarting(false);
		}
	}

	private async startUp(settings: TranscriptMemorySettings): Promise<TranscriptMemoryStartResult> {
		const epoch = this.run.nextEpoch();
		const { store } = this.ports;

		const loaded = await store.load();
		if ("status" in loaded) return this.disable(`the summary store could not be read: ${loaded.reason}`);
		const unknownForget = forgetStateBlock(loaded);
		if (unknownForget !== undefined) return this.disable(unknownForget);
		let state = loaded;
		let issues = [...state.issues];
		let acquisition = await store.acquireWriter();
		if (acquisition.status === "manifest_corrupt") {
			// Derived state only: the damaged bytes are kept beside it and the hierarchy is rebuilt from sources.
			acquisition = await store.acquireWriter({ recoverCorrupt: true });
		}
		if (acquisition.status !== "acquired") {
			const cause =
				acquisition.status === "manifest_corrupt"
					? acquisition.detail
					: acquisition.status === "forget_unknown" || acquisition.status === "unavailable"
						? acquisition.reason
						: undefined;
			return this.disable(`the store refused a writer: ${acquisition.status}${cause ? ` (${cause})` : ""}`);
		}
		const writer = acquisition.writer;
		// Another writer may have run between the first load and the lease (a claim saved, a node revoked). The first load
		// only established that the store is readable: every earlier writer is fenced now, so what the run derives from
		// (jobs and their attempts, proof, nodes) is loaded again after the lease, never carried over from before it.
		const current = await store.load();
		if ("status" in current) return this.disable(`the summary store could not be read: ${current.reason}`);
		const unknownForgetAfterLease = forgetStateBlock(current);
		if (unknownForgetAfterLease !== undefined) return this.disable(unknownForgetAfterLease);
		state = current;
		// A damaged manifest the lease replaced is still reported (the replacement loads clean).
		issues = [...issues.filter((issue) => issue.kind === "manifest_corrupt"), ...state.issues];
		if (issues.some((issue) => issue.kind !== "manifest_corrupt")) {
			await writer.applyRecovery(issues);
		}
		if (issues.length > 0) {
			const reloaded = await store.load();
			if ("status" in reloaded) return this.disable(`the summary store could not be read: ${reloaded.reason}`);
			state = reloaded;
		}
		// Files nothing will read again (node content a crash or a failed publication left unreferenced, staged
		// temporary files) are removed by age under this writer's fence, once the recovered state is final. A sweep the
		// store could not finish keeps its cause for the status and is tried again at the next start; it never keeps
		// the hierarchy off.
		try {
			await writer.sweepOrphans();
		} catch (error) {
			const unavailable = storeUnavailable("sweeping unreferenced summary files", error);
			if (!unavailable) throw error;
			this.causes.noteInternal(unavailable.reason);
		}
		this.run.setRecoveryIssues(issues.map(describeIssue).slice(0, MAX_STATUS_ISSUES));

		this.run.setWriter(writer);
		const scheduler = new TranscriptSummaryScheduler({
			...this.ports.scheduler,
			// Opened by this run's first acknowledged save, which converts version 1 budgets durably first.
			admission: "closed",
			concurrency: Math.max(1, settings.maxConcurrentSummaries),
			// Under a possibly-lost-proof hold, only a session known to have started after it admits new identities.
			sessionStartedAt: (sessionId) => {
				const stamp = this.sessions.stampOf(sessionId);
				const at = stamp ? Date.parse(stamp) : Number.NaN;
				return Number.isNaN(at) ? undefined : at;
			},
		});
		this.run.setScheduler(scheduler);
		this.sessions.clear();
		this.sessions.clearDue();
		this.proofLedger = state.proof.status;
		this.sessions.clearAnchors();
		this.sessions.clearStamps();
		this.lastRevocation = undefined;
		this.sessions.setUndatedPending(false);
		this.holds.reset();
		this.batch.resetAdmissionCounts();
		this.durableAttempts.clear();
		this.durableReplies.clear();
		this.manifestReads = new TranscriptBoundedRead<{ manifest: ManifestRead; forgotten: ForgetStateRead }>(
			async (_ticket, context) => {
				const manifest = await this.ports.store.readManifest(context);
				if (manifest.status === "unavailable") return manifest;
				const forgotten = await this.ports.store.readForgottenSessions(context);
				assertMemoryReadActive(context);
				return { manifest, forgotten };
			},
		);
		this.run.setPhase("convert");
		this.run.clearDiscoveryHold();
		this.saveFailure = undefined;
		this.saveBackoff.reset();
		this.resetRetryState();
		// Before recovery, so every recovered job keeps the durable reservation it already holds.
		scheduler.noteProof(state.proof.records);
		scheduler.setProofHold(state.proof.status.hold);
		this.batch.restoreTerminals(state.terminals);
		this.loadMirror(state);
		const now = this.ports.now();
		// The accepted nodes are the completion evidence: a job that published before a stop settles `ready` from its node.
		// Receipts owed by jobs that ended before the stop were persisted: a paid response's spend survives the restart.
		const owed: { ownerSessionId: string; receipt: SystemOneReceipt }[] = [];
		for (const entry of state.owedReceipts) {
			const receipt = parseSemanticReceipt(entry.receipt);
			if (receipt === undefined)
				this.causes.noteInternal("a persisted owed usage receipt was malformed and could not be restored");
			else owed.push({ ownerSessionId: entry.ownerSessionId, receipt });
		}
		scheduler.returnReleasedReceipts(owed);
		this.owedReceiptsSavedVersion = scheduler.releasedReceiptsState().version;
		this.owedSavedKeys = new Set(owed.map(owedKey));
		scheduler.recover(state.jobs, now, new Map([...this.catalog.values()].map((node) => [node.id, node])));
		// Jobs and nodes of an older capture version name inputs that are no longer current identities. Their jobs end
		// stale before anything is claimed (a started attempt is carried under its version 1 key, where the current job
		// finds it again), and their nodes never enter the ready index; discovery revokes and re-derives them first.
		for (const job of scheduler.snapshot()) {
			if (!isTerminalSummaryJobState(job.state) && !isCurrentCaptureNode(job)) scheduler.markStale(job.id, now);
		}
		for (const node of this.catalog.values()) if (isCurrentCaptureNode(node)) scheduler.onNodeReady(node, now);

		this.run.markStarted();
		// The first save reserves recovered live jobs and persists a converted ledger before anything is discovered.
		this.markJobsDirty();
		this.unsubscribers.push(
			this.ports.reader.onIndexChanged((event) => {
				const scheduled = this.run.epoch;
				void this.enqueue(async () => {
					if (!this.live(scheduled)) return;
					if (this.sessions.undatedPending) await this.anchorUndatedNodes(scheduled);
					// An invalidated session is revoked by its one read below, never read a second time here.
					for (const sessionId of event.invalidatedSessionIds) this.sessions.markDue(sessionId);
					const touched = new Set([...event.sessionIds, ...event.invalidatedSessionIds]);
					for (const sessionId of touched) await this.reconcileSession(sessionId, scheduled);
					// The index changed: held recovered leaves of sessions it did not name are tried again.
					await this.reconcileHeldSessions(touched, scheduled);
					this.pump(scheduled);
				});
			}),
			this.ports.onBackgroundAvailable(() => {
				const scheduled = this.run.epoch;
				void this.enqueue(async () => this.pump(scheduled));
			}),
		);
		// Source discovery runs on the mailbox in the background; the owner is not held up by it. It runs after the first
		// save (queued above) is acknowledged; when that save failed, the retry that succeeds starts it.
		void this.enqueue(async () => {
			if (!this.live(epoch)) return;
			// Derived data of sessions forgotten while no coordinator ran (or by another root) is removed before anything
			// is discovered; their jobs end and their reservations release at the first acknowledged save.
			await this.applyPendingForgets(epoch);
			if (this.run.phase !== "open") {
				this.run.holdDiscovery();
				return;
			}
			await this.discover(epoch);
		});
		return { enabled: true, recoveryIssues: issues };
	}

	/**
	 * Start-up reconciliation of recovered work (after the conversion save, before admission opens), so no claim can
	 * be taken against a version 1 budget that is still unmerged. A recovered PARENT adopts its budget now, keyed by
	 * its children's legacy identities; one whose child is gone or of an older capture version ends stale with that
	 * cause (its inputs are gone or being retired). A recovered LEAF cannot be keyed from its persisted refs (they
	 * carry no text digests), so it is held (`reconciliation`) and unclaimable until the enumeration that reads its
	 * coverage adopts its budget and releases it (see {@link enumerateLeaves}); a leaf whose coverage or session is
	 * gone leaves the hold through the stale or invalidation transition that ends it. Nothing is skipped.
	 */
	private reconcileRecovered(epoch: number): void {
		const scheduler = this.run.scheduler;
		if (!scheduler || !this.live(epoch)) return;
		const now = this.ports.now();
		for (const job of scheduler.snapshot()) {
			if (job.state === "ready" || isTerminalSummaryJobState(job.state)) continue;
			if (job.kind === "leaf") {
				this.holds.park(job.id, { scope: "reconciliation", reason: RECONCILIATION_WAITING });
				continue;
			}
			// A re-admission names an accepted node, not source coverage: nothing to reconcile.
			if (job.kind === "readmission") continue;
			const left = job.children ? this.catalog.get(job.children[0]) : undefined;
			const right = job.children ? this.catalog.get(job.children[1]) : undefined;
			if (!left || !right) {
				scheduler.markStale(job.id, now);
				this.batch.recordFailure(job, "stale", "a child node is no longer accepted");
				continue;
			}
			if (left.legacyIdentity === undefined || right.legacyIdentity === undefined) {
				scheduler.markStale(job.id, now);
				this.batch.recordFailure(job, "stale", "a child node is of an older capture version and is being retired");
				continue;
			}
			scheduler.reconcileLegacy(
				job.id,
				parentJobKey({
					sessionId: job.sessionId,
					level: job.level,
					children: [left.legacyIdentity, right.legacyIdentity],
				}),
			);
		}
		this.run.setPhase("reconciled");
		this.markJobsDirty();
	}

	/** Retire older captures, anchor, apply retention, rebuild unapproved frontiers and reconcile every session. */
	private async discover(epoch: number): Promise<void> {
		// Older captures retire before anything is enumerated; when that write cannot be served, discovery as a whole
		// is tried again after the store backoff.
		if (!(await this.retireLegacyCapture(epoch)) || !this.live(epoch)) return;
		await this.anchorUndatedNodes(epoch);
		await this.applyRetention(epoch);
		// Nodes accepted before the admission contract are not approved: frontiers published with them are rebuilt without.
		await this.republishFrontiers(
			[...this.frontiers.keys()].filter((name) => this.frontierNotAdmitted(name)),
			epoch,
		);
		await this.reconcileAll(epoch);
		this.pump(epoch);
	}

	/**
	 * Take the store's derived state into the mirror in one synchronous step: its revision with the cursors,
	 * frontiers, forgotten sessions, accepted nodes, anchors and dormant nodes it describes. The one load path of a
	 * start and of a reload after the store moved past the mirror.
	 */
	private loadMirror(state: TranscriptSummaryStoreState): void {
		const manifest = state.manifest;
		this.manifestRevision = manifest?.revision ?? 0;
		this.cursors.clear();
		this.frontiers.clear();
		this.frontierBytes.clear();
		this.forgottenSessions.clear();
		this.forgetRevision = 0;
		this.forgetAppliedRevision = manifest?.forgetRevisionApplied ?? 0;
		for (const [sessionId, cursor] of Object.entries(manifest?.sessions ?? {})) this.cursors.set(sessionId, cursor);
		for (const [name, frontier] of Object.entries(manifest?.frontiers ?? {})) this.frontiers.set(name, frontier);
		// Legacy markers still in the manifest deny exactly as the permanent state does until the store migrates them.
		for (const key of Object.keys(manifest?.tombstones ?? {})) {
			if (key.startsWith(SESSION_TOMBSTONE_KEY_PREFIX))
				this.forgottenSessions.add(key.slice(SESSION_TOMBSTONE_KEY_PREFIX.length));
		}
		if (state.forgotten.status === "ok") {
			for (const sessionId of state.forgotten.sessions) this.forgottenSessions.add(sessionId);
			this.forgetRevision = state.forgotten.revision;
		}
		// Denied nodes stay indexed (the removal of a forgotten session's data finds them there); reads refuse them at the gate.
		this.catalog.replace(state.nodes.values(), state.retentionAnchors);
		this.dormant.clear();
		for (const [id, node] of state.dormant) this.dormant.set(id, node);
	}

	/**
	 * The store moved past this mirror (`stale_revision`: a revision this coordinator did not apply). A revision is
	 * never adopted without its mirror (contract C6): the mirror is reloaded through the start's load path, discovery
	 * restarts from the reloaded cursors, and the scheduler's ready index follows the reloaded accepted set. Damage the
	 * load reports is not repaired mid-run: the coordinator stops with the real cause and recovers at its next start.
	 * Returns `stopped` when this run ended (or ended here), and the store's typed `unavailable` (its cause recorded)
	 * when the load could not be served while the run is live.
	 */
	private async reloadMirror(epoch: number): Promise<"reloaded" | "stopped" | TranscriptSummaryStoreUnavailable> {
		const state = await this.ports.store.load();
		const scheduler = this.run.scheduler;
		if (!this.live(epoch) || !scheduler) return "stopped";
		if ("status" in state) {
			// Not adopted: the mirror keeps its own revision, so reads are refused until a reload succeeds.
			this.causes.noteInternal(`reloading the summary mirror: ${state.reason}`);
			return state;
		}
		if (!state.manifest || state.issues.length > 0) {
			const detail = state.issues.map(describeIssue).join("; ") || "the manifest is missing";
			this.fatal(`the summary store moved past this coordinator and needs recovery: ${detail}`);
			return "stopped";
		}
		const unknownForget = forgetStateBlock(state);
		if (unknownForget !== undefined) {
			this.fatal(unknownForget);
			return "stopped";
		}
		const before = new Set(this.catalog.ids());
		const gone = [...before].filter((id) => !state.nodes.has(id));
		// Read before the mirror is replaced: the sessions of the nodes that are gone.
		const goneSessions = this.sessionsOf(gone);
		this.loadMirror(state);
		this.sessions.clear();
		const now = this.ports.now();
		scheduler.revokeNodes(gone, now, { readmit: false });
		this.endRevokedReadmissions(goneSessions, new Set(gone));
		for (const node of state.nodes.values()) {
			if (!before.has(node.id) && isCurrentCaptureNode(node)) scheduler.onNodeReady(node, now);
		}
		return "reloaded";
	}

	/**
	 * Capture version 2 binds every input a summary consumed into its source handles. Accepted nodes of an older
	 * version are never served or extended: they are revoked as `invalidated` (derived again from their sources, not
	 * forgotten), and older dormant nodes are purged so they stop holding the dormant cap, in one manifest write.
	 * True when discovery may go on.
	 */
	private async retireLegacyCapture(epoch: number): Promise<boolean> {
		const writer = this.run.writer;
		if (!writer || !this.live(epoch)) return false;
		const accepted = new Set(
			[...this.catalog.values()].filter((node) => !isCurrentCaptureNode(node)).map((node) => node.id),
		);
		const dormant = new Set(
			[...this.dormant.values()].filter((node) => !isCurrentCaptureNode(node)).map((node) => node.id),
		);
		if (accepted.size === 0 && dormant.size === 0) return true;
		const result = await writer.revokeNodes((id) => accepted.has(id), "invalidated", {
			purgeDormant: (id) => dormant.has(id),
		});
		if (result.status === "unavailable") {
			this.deferStoreWork(result.reason, { discover: true }, epoch);
			return false;
		}
		if (result.status !== "published") {
			if (this.live(epoch))
				this.fatal(`retiring summaries of an older capture version was refused: ${result.status}`);
			return false;
		}
		if (!this.live(epoch)) {
			// Durable already: the mirror takes it with its revision even though this run will not continue (C6).
			this.mirrorRevocation(result, "invalidated", undefined, 0);
			return false;
		}
		await this.applyRevocation(result, epoch, { reason: "invalidated" });
		return true;
	}

	/** Cancel the timer and subscriptions, abort in-flight work, requeue it for the next start, save the jobs. */
	async stop(): Promise<void> {
		if (!this.run.started && !this.run.scheduler) return;
		const running = this.haltBackground();
		await this.readsStopped;
		// Settled, never thrown past: the stop must reach its terminal signal. An unexpected rejection keeps its cause.
		const settled = await Promise.allSettled([...running.map((entry) => entry.done)]);
		for (const result of settled) {
			if (result.status === "rejected") {
				this.causes.noteInternal(
					`background work failed at stop: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
				);
			}
		}
		await this.tail;
		const scheduler = this.run.scheduler;
		const writer = this.run.writer;
		let interrupted = 0;
		if (scheduler) {
			const now = this.ports.now();
			for (const job of scheduler.snapshot()) {
				if (job.state === "running" && scheduler.interrupt(job.id, now)) interrupted += 1;
			}
		}
		let stopReason: string | undefined;
		if (scheduler && writer) {
			// The stop always reaches its terminal signal; a save that failed keeps its real cause for the status.
			try {
				const saved = await this.saveJobsInOrder(scheduler, writer, this.run.epoch, scheduler.snapshot());
				// An unsaved queue update ends this run: its terminal event names it (the host keeps it as the status cause; the warning itself is not shown on the dispose path, where the session's listeners are already cleared). Older copies
				// of a receipt (the last saved queue, the job record) are kept by a failed queue write, so only the entries newer
				// than the last saved queue are counted. An entry only this run held (carried by an aborted call, or whose job had
				// already ended) has no older copy, and the message says so.
				if (saved === undefined) {
					const newer = scheduler
						.releasedReceiptsState()
						.entries.filter((entry) => !this.owedSavedKeys.has(owedKey(entry))).length;
					stopReason = `the owed-receipt queue update was not saved (${newer} ${newer === 1 ? "entry" : "entries"} newer than the last saved queue; one that no older queue or job record holds is lost); cause: ${this.causes.last?.cause ?? "the owed usage receipts could not be saved"}`;
				} else if (saved.status !== "saved") {
					this.causes.noteInternal(`saving jobs at stop: ${describeSaveRefusal(saved)}`);
				}
			} catch (error) {
				this.causes.noteInternal(
					`saving jobs at stop failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		this.finishBatch("stopped", interrupted, stopReason);
		try {
			await this.stopHandoff;
		} finally {
			// Released however the owner's terminal callback ended; its own failure still reaches the caller.
			this.stopHandoff = undefined;
			this.inFlight.clear();
			this.run.release();
			this.manifestReads = undefined;
		}
	}

	/**
	 * Forget one session. The command is the permanent marker in the store's forget state, acknowledged before anything
	 * else: from that point every reader denies the session, the publisher refuses its nodes and no claim is made for
	 * it, whatever happens to the derived data next. Removing the derived data (jobs, nodes, cursor, anchors, spent
	 * records) then follows; if that does not finish, the outcome is still `forgotten` and carries `cleanupPending`, and
	 * the removal is retried. A session nothing knows is refused before the marker is written. Source sessions are
	 * untouched. `refused` (with the real cause) means nothing was recorded.
	 */
	async forgetSession(sessionId: string): Promise<TranscriptForgetOutcome> {
		const scheduled = this.run.epoch;
		let outcome: TranscriptForgetOutcome | undefined;
		await this.enqueue(async () => {
			if (!this.live(scheduled) || !this.run.writer || !this.run.scheduler) {
				outcome = {
					status: "refused",
					reason:
						this.readUnavailable()?.reason ??
						"the memory generation changed before the session could be forgotten",
				};
				return;
			}
			// A session nothing here or in the canonical history knows is refused before any write: a typed-wrong id
			// must not leave a permanent marker.
			if (!this.holdsSession(sessionId)) {
				const probe = await this.ports.reader.listLineageSpans({ sessionId, fromIndex: 0, maxSpans: 1 });
				if (probe.status === "not_found") {
					outcome = { status: "refused", reason: `unknown session ${sessionId}: nothing was forgotten` };
					return;
				}
				if (probe.status !== "ok") {
					outcome = {
						status: "refused",
						reason: `could not confirm that session ${sessionId} exists (${probe.status}: ${probe.reason}): nothing was forgotten`,
					};
					return;
				}
				if (!this.live(scheduled) || !this.run.writer) {
					outcome = {
						status: "refused",
						reason:
							this.readUnavailable()?.reason ??
							"the memory generation changed before the session could be forgotten",
					};
					return;
				}
			}
			const recorded = await this.ports.store.recordForget(sessionId);
			const refusal = forgetRefusalCause(recorded);
			if (refusal !== undefined || (recorded.status !== "recorded" && recorded.status !== "already")) {
				this.causes.noteInternal(refusal ?? "the forget command was not recorded");
				outcome = {
					status: "refused",
					reason: `forgetting ${sessionId} could not be recorded: ${refusal ?? "unknown cause"}`,
				};
				return;
			}
			// The marker is durable: the session is denied now. The file may also hold sessions another root forgot, so the whole
			// state is adopted (and every pending removal applied) instead of only this revision number.
			this.forgottenSessions.add(sessionId);
			// Whatever the state read and the removal do next, the session's own model work stops now.
			this.abortSession(sessionId);
			this.forgets.addEarlyDropped(this.endSessionJobs(sessionId, "cancelled"));
			let pending: string | undefined;
			try {
				pending = await this.refreshForgetState(scheduled);
			} finally {
				this.forgets.clearEarlyDropped();
			}
			outcome = pending === undefined ? { status: "forgotten" } : { status: "forgotten", cleanupPending: pending };
			this.pump(scheduled);
		});
		// The mailbox keeps a thrown error as the internal error; it is the real cause of a forget that did not finish.
		return (
			outcome ?? {
				status: "refused",
				reason: this.causes.active?.cause ?? this.causes.last?.cause ?? "forgetting did not complete",
			}
		);
	}

	/**
	 * Remove the derived data of a session whose permanent marker is durable: end its jobs (aborting running work, so
	 * recovered or parked leaves and their reservations are discharged by the existing job and ledger rules), revoke its
	 * nodes and the nodes that consulted it as context with all their ancestors, drop its cursor, then its retention
	 * anchors and spent records. Returns the cause when a step could not be written (the removal is then retried on the
	 * store backoff, and the marker keeps denying the session meanwhile), undefined when complete.
	 */
	private async applyForgottenSession(sessionId: string, epoch: number): Promise<string | undefined> {
		const writer = this.run.writer;
		if (!writer || !this.run.scheduler || !this.live(epoch))
			return "the memory generation changed before the removal ran";
		this.abortSession(sessionId);
		const droppedReady = this.forgets.takeEarlyDropped() + this.endSessionJobs(sessionId, "cancelled");
		const dormantDenied = this.deniedDormantIds();
		const result = await writer.revokeNodes(
			(_id, entry) =>
				entry.sessionId === sessionId || entry.contextRefs.some((handle) => handle.split(":")[1] === sessionId),
			"retention",
			{
				dropSessionCursor: sessionId,
				// Parked (dormant) nodes of the session and the ones that consulted it as context go with it.
				purgeDormant: (id) => dormantDenied.has(id),
			},
		);
		if (result.status === "unavailable") {
			this.deferStoreWork(result.reason, { forgets: [sessionId] }, epoch);
			return `removing the derived summaries of ${sessionId} could not be written: ${result.reason}`;
		}
		if (result.status !== "published") {
			const reason = `removing the derived summaries of ${sessionId} was refused: ${result.status}`;
			this.fatal(reason);
			return reason;
		}
		// The mirror takes the revocation in the same step as its revision, before any later write: a later write's
		// revision must never be adopted while revoked nodes are still indexed (contract C6).
		await this.applyRevocation(result, epoch, { reason: "forgotten", dropSession: sessionId, droppedReady });
		// A forgotten session is never summarized again: its anchors and spent budgets can no longer matter.
		// The session's finished jobs leave the list first: a later job save would write their carried budgets again.
		this.run.scheduler?.dropTerminalJobsOfSession(sessionId);
		const dropped = await this.dropSessionRecords(new Set([sessionId]));
		if (dropped === true) return undefined;
		if (dropped === false)
			return `dropping the retention records of ${sessionId} was refused: ${this.run.disabledReason ?? "the summary hierarchy stopped"}`;
		this.deferStoreWork(dropped.reason, { forgets: [sessionId] }, epoch);
		return `dropping the retention records of ${sessionId} could not be written: ${dropped.reason}`;
	}

	/**
	 * The parked (dormant) nodes the forget state denies (those naming a forgotten session and the summaries built on them);
	 * with `only`, the ones that session alone denies.
	 */
	private deniedDormantIds(only?: string): Set<string> {
		const forgotten = only === undefined ? this.forgottenSessions : new Set([only]);
		if (forgotten.size === 0) return new Set();
		const denied = forgottenNodeIds([...this.catalog.values(), ...this.dormant.values()], forgotten);
		return new Set([...denied].filter((id) => this.dormant.has(id)));
	}

	/** Remove the derived data of every forgotten session that still has any (start-up, a reload, another root's forget). */
	private async applyPendingForgets(epoch: number): Promise<string | undefined> {
		let first: string | undefined;
		for (const sessionId of [...this.forgottenSessions]) {
			if (!this.live(epoch)) return first;
			if (!this.holdsSessionData(sessionId)) continue;
			const pending = await this.applyForgottenSession(sessionId, epoch);
			if (pending !== undefined) {
				this.causes.noteInternal(pending);
				first ??= pending;
			}
		}
		if (first === undefined) await this.recordForgetApplied(epoch);
		return first;
	}

	/**
	 * Once every forgotten session's derived data is gone, the manifest records the forget revision as applied: from then
	 * on a forget file below that revision (lost or rolled back) reads as unknown, never as "nothing was forgotten". The
	 * write leaves the manifest revision unchanged, so the mirror needs no reload.
	 */
	private async recordForgetApplied(epoch: number): Promise<void> {
		const writer = this.run.writer;
		if (!writer || !this.live(epoch) || this.forgetRevision < 1 || this.forgetRevision <= this.forgetAppliedRevision)
			return;
		if ([...this.forgottenSessions].some((sessionId) => this.holdsSessionData(sessionId))) return;
		const recorded = await writer.markForgetApplied(this.forgetRevision);
		if (recorded.status === "applied") this.forgetAppliedRevision = recorded.forgetRevisionApplied;
		else if (recorded.status === "fenced" || recorded.status === "manifest_corrupt") {
			this.fatal(`recording the applied forget revision was refused: ${recorded.status}`);
		} else {
			this.causes.noteInternal(`recording the applied forget revision: ${recorded.reason}`);
		}
	}

	/** Ask the mailbox to adopt the permanent forget state once: requests that arrive while one is queued share it. */
	private queueForgetRefresh(epoch: number): void {
		if (!this.forgets.queueRefresh()) return;
		void this.enqueue(async () => {
			this.forgets.refreshStarted();
			await this.refreshForgetState(epoch);
		});
	}

	/** Re-read the permanent forget state (another root may have forgotten a session) and apply what is new. */
	private async refreshForgetState(epoch: number): Promise<string | undefined> {
		const read = await this.ports.store.readForgottenSessions();
		if (!this.live(epoch)) return "the memory generation changed before the removal ran";
		if (read.status !== "ok") {
			// An unknown state is never read as "nothing forgotten": the coordinator stops with the cause.
			if (read.status === "unknown") this.fatal(`the permanent forget state became unknown: ${read.reason}`);
			else this.causes.noteInternal(`reading the permanent forget state: ${read.reason}`);
			return `reading the permanent forget state: ${read.reason}`;
		}
		for (const sessionId of read.sessions) this.forgottenSessions.add(sessionId);
		this.forgetRevision = read.revision;
		return this.applyPendingForgets(epoch);
	}

	/**
	 * Whether anything durable here is keyed by this session: its tombstone, cursor or frontier, its accepted or
	 * dormant nodes, a node of another session that consulted it as context, its retention anchors, or the
	 * scheduler's jobs, terminal-proof records and held parent slots.
	 */
	private holdsSession(sessionId: string): boolean {
		return this.forgottenSessions.has(sessionId) || this.holdsSessionData(sessionId);
	}

	/** {@link holdsSession} without the marker itself: whether derived data of the session is still held. */
	private holdsSessionData(sessionId: string): boolean {
		return (
			this.cursors.has(sessionId) ||
			this.frontiers.has(sessionId) ||
			(this.catalog.sessionNodes(sessionId)?.size ?? 0) > 0 ||
			[...this.catalog.values()].some((node) => node.contextRefs.some((ref) => ref.sessionId === sessionId)) ||
			this.deniedDormantIds(sessionId).size > 0 ||
			this.catalog.anchoredSessionIds().includes(sessionId) ||
			// Finished jobs count too: applying the forget drops them, so they cannot keep it pending, and a forget skipped
			// while they remain would let their carried budgets come back with the next job save.
			(this.run.scheduler?.holdsSession(sessionId) ?? false)
		);
	}

	// ---- diagnostics --------------------------------------------------------------------------

	status(): TranscriptMemoryStatus {
		return statusSnapshot(this.host);
	}

	/** True between a successful start and a stop or a fatal condition. */
	isRunning(): boolean {
		return this.run.started;
	}

	// ---- admission ----------------------------------------------------------------------------

	/** How many jobs each kind of hold holds, so no claim made for the first hold is read as true of all of them. */
	/**
	 * Why model summary work cannot run now, or undefined when it can. Exact copies never depend on it. Checked
	 * before any provider call so a summary that admission could not follow is not paid for.
	 */
	private modelWorkBlock(): TranscriptMemoryModelWorkBlock | undefined {
		return modelWorkBlockOf(this.host);
	}

	/** True while a persisted frontier names a summary that has no admission under the current contract. */
	frontierNotAdmitted(lineageKey: string): boolean {
		return frontierNotAdmittedAt(this.host, lineageKey);
	}

	/** Parked jobs that are no longer queued (finished, stale, revoked) have nothing left to release. */
	/** The persisted selection and its accepted nodes for one lineage, for the prompt projection to render. */
	frontierSnapshot(lineageKey: string):
		| {
				selection: TranscriptFrontierSelection;
				nodes: ReadonlyMap<string, TranscriptSummaryNode>;
				gap?: TranscriptFrontierGap;
		  }
		| undefined {
		return frontierSnapshotOf(this.host, lineageKey);
	}

	/**
	 * True while a persisted frontier names a summary retention withholds: past the window and not revoked yet, or
	 * with no retention age to judge it by while retention is on (never treated as ageless). The catalog's read
	 * rule decides; approval stays with {@link frontierNotAdmitted}.
	 */
	frontierExpired(lineageKey: string): boolean {
		return frontierExpiredAt(this.host, lineageKey);
	}

	/**
	 * One level of zoom through the catalog. Typed statuses, never an empty success: `pending` while the store
	 * loads and `unavailable` while the hierarchy is off or stopped; everything else is the catalog's.
	 */
	async expand(handle: string, options: TranscriptSummaryReadOptions = {}): Promise<TranscriptNodeExpansion> {
		const unavailable = this.readUnavailable();
		return this.catalog.expand(handle, {
			...this.catalogReadContext(options),
			...(unavailable ? { unavailable } : {}),
			unapprovedReason: (node) => {
				const wait = this.unapprovedWait(node) ?? "not_yet_judged";
				return wait === "not_yet_judged"
					? (this.modelWorkBlock()?.reason ?? READMISSION_WAIT_TEXT.not_yet_judged)
					: READMISSION_WAIT_TEXT[wait];
			},
		});
	}

	/** Approved summaries covering these source hits (contract C5), through the catalog; typed like `expand` while not running. */
	async summariesFor(
		refs: readonly TranscriptSourceRef[],
		limits: { maxNodes: number },
		options: TranscriptSummaryReadOptions = {},
	): Promise<TranscriptSummaryLookupResult> {
		const unavailable = this.readUnavailable();
		if (unavailable) return unavailable;
		return this.catalog.approvedSummariesCovering(refs, limits, this.catalogReadContext(options));
	}

	/**
	 * The catalog read context of this coordinator: a tool call waits on it (foreground bound), the retention cutoff
	 * is asked at every judgment, the caller's whole-operation deadline passes through, and {@link confirmMirror} is
	 * the delivery fence.
	 */
	private catalogReadContext(options: TranscriptSummaryReadOptions): TranscriptSummaryReadContext {
		return {
			...options,
			reader: this.ports.reader,
			cutoff: () => this.retentionCutoff(),
			priority: "foreground",
			...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
			confirm: (context = options) => this.confirmMirror(context),
		};
	}

	/**
	 * The delivery fence of a catalog read: the in-place mirror may serve text only while it reflects the store as it
	 * is now. The writer lease does not prove that: another `acquireWriter` supersedes it and this writer learns only on
	 * its next write. The manifest revision does, because every write of this coordinator adopts the revision it
	 * produced in the same step as the mirror change (contract C6). A missing manifest or a revision this mirror does
	 * not reflect means the summary store moved under the read; it is refused naming the store, with the shared
	 * changed-in-flight wording the retry policy classifies.
	 */
	private async confirmMirror(
		context: MemoryReadContext,
	): Promise<TranscriptSummaryReadFence | TranscriptReadUnavailable> {
		const reads = this.manifestReads;
		const epoch = this.run.epoch;
		// The bounded reads exist exactly while a run is started (created by its start, dropped by its stop).
		if (!reads)
			return this.readUnavailable() ?? { status: "unavailable", reason: "the summary hierarchy is not running" };
		// A fence: only a manifest read that starts after this call can confirm the mirror, and this caller is settled
		// by its own deadline whatever the read does.
		const confirmed = await reads.fence(context);
		assertMemoryReadActive(context);
		if ("status" in confirmed) return confirmed;
		const { manifest: read, forgotten: forget } = confirmed;
		const unavailable = this.readUnavailable();
		if (unavailable) return unavailable;
		// The coordinator was replaced while the read was out: nothing from the earlier run is adopted.
		if (epoch !== this.run.epoch) {
			return { status: "stale_snapshot", reason: `The summary store ${TRANSCRIPT_SUMMARY_CHANGED_IN_FLIGHT}.` };
		}
		if (read.status === "corrupt") {
			return {
				status: "unavailable",
				reason: `the summary store manifest is damaged (${read.detail}); exact history recall is unaffected`,
			};
		}
		if (
			read.status === "missing" ||
			read.manifest.revision !== this.manifestRevision ||
			read.manifest.writerFence !== this.run.writer?.fence
		) {
			return {
				status: "stale_snapshot",
				reason: `The summary store ${TRANSCRIPT_SUMMARY_CHANGED_IN_FLIGHT}.`,
			};
		}
		// The permanent forget state is confirmed with the manifest: a session another root forgot since this mirror
		// loaded is never served, and the mirror then removes its derived data.
		if (forget.status === "unknown") {
			return {
				status: "unavailable",
				reason: `the permanent forget state is unknown (${forget.reason}); summaries stay unavailable and exact history recall is unaffected`,
			};
		}
		if (forget.status !== "ok") return forget;
		if (forget.revision !== this.forgetRevision) {
			this.queueForgetRefresh(epoch);
			return {
				status: "stale_snapshot",
				reason: `The summary store ${TRANSCRIPT_SUMMARY_CHANGED_IN_FLIGHT}.`,
			};
		}
		const revision = this.manifestRevision;
		const forgetRevision = this.forgetRevision;
		const writerFence = read.manifest.writerFence;
		return {
			catalog: this.catalog,
			revision: `${writerFence}:${revision}:${forgetRevision}`,
			isCurrent: () =>
				this.live(epoch) &&
				this.run.writer?.fence === writerFence &&
				this.manifestRevision === revision &&
				this.forgetRevision === forgetRevision,
		};
	}

	/** Why node reads cannot be served now: `pending` while the store loads, `unavailable` while off or stopped. */
	private readUnavailable(): TranscriptReadUnavailable | undefined {
		if (this.run.started) return undefined;
		return this.run.starting
			? { status: "pending", reason: "the summary hierarchy is still loading" }
			: { status: "unavailable", reason: this.run.disabledReason ?? "the summary hierarchy is not running" };
	}

	/** Record what re-admission found for a node; `wait` says why a judgment has not happened or was discarded. */
	/** Why an accepted node is not approved, or undefined when it is approved. Pure apart from the re-admission record. */
	private unapprovedWait(node: TranscriptSummaryNode): TranscriptReadmissionWait | undefined {
		return unapprovedWaitOf(this.host, node);
	}

	/**
	 * Whether this mirror still reflects the store (its manifest revision and the permanent forget state). A frontier is
	 * described to a model only while it does: another controller that revoked or forgot since, or a store that cannot be
	 * read, leaves the request without one (a cleared record), never with derived text the store no longer stands behind.
	 */
	async confirmFrontier(deadlineAt?: number, read: MemoryReadContext = {}): Promise<boolean> {
		const context = this.catalogReadContext({ ...read, deadlineAt });
		this.frontierRead = undefined;
		const selection = this.frontiers.get(this.ports.ownerSessionId());
		if (!selection || selection.nodeIds.length === 0) return "catalog" in (await this.confirmMirror(context));
		const checks = [];
		for (const id of selection.nodeIds) {
			const node = this.catalog.get(id);
			const dependency = node && this.catalog.dependency(node);
			if (dependency?.kind !== "range") return false;
			checks.push(dependency.check);
		}
		const verified = await this.ports.reader.verifyLineageRanges({
			checks,
			priority: "foreground",
			signal: context.signal,
			onPhysicalRead: context.onPhysicalRead,
			deadlineAt,
		});
		if (verified.status !== "ok" || verified.verdicts.some((verdict) => verdict !== "live")) return false;
		const fence = await this.confirmMirror(context);
		assertMemoryReadActive(context);
		if (
			"status" in fence ||
			this.frontiers.get(this.ports.ownerSessionId()) !== selection ||
			this.ports.reader.observationCurrent(verified.observation).status !== "current"
		)
			return false;
		this.frontierRead = { fence, observation: verified.observation, context, selection };
		return true;
	}

	/** Evidence for exactly the nodes the frontier renderer retained, without parsing its prose. */
	frontierEvidence(
		nodeIds: readonly string[],
		selection: TranscriptFrontierSelection,
		sourceHandles: readonly string[],
	): MemoryReadEvidence | undefined {
		return frontierEvidenceOf(this.host, nodeIds, selection, sourceHandles);
	}

	/** An owner outside the coordinator (the prompt planner) records a cause on the same diagnostics slot. */
	recordExternalCause(cause: string): void {
		this.causes.noteInternal(cause);
	}

	// ---- mailbox ------------------------------------------------------------------------------

	private enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.tail.then(task).catch((error: unknown) => {
			this.causes.noteInternal(error instanceof Error ? error.message : String(error));
		});
		this.tail = run;
		return run;
	}

	private live(epoch: number): boolean {
		return this.run.started && epoch === this.run.epoch && this.ports.isCurrent();
	}

	private disable(reason: string): { enabled: false; reason: string } {
		this.run.setDisabledReason(reason);
		return { enabled: false, reason };
	}

	/** Everything one run keeps in memory to retry or reuse later (store work, receipt retry timing, paid-claim marks): a start and a halt both drop it. Kept paid verdicts live on the jobs, durably. */
	private resetRetryState(): void {
		this.forgets.reset();
		this.storeRetry.reset();
		this.receipts.reset();
	}

	/**
	 * Stop all background activity at once: results of the old epoch are discarded, the retry timer and
	 * subscriptions are released and in-flight work is aborted. Returns the aborted entries so a stop can
	 * wait for them to settle.
	 */
	private haltBackground(): { controller: AbortController; done: Promise<void> }[] {
		this.run.halt();
		this.frontierRead = undefined;
		this.readsStopped = this.manifestReads?.close() ?? this.readsStopped;
		if (this.timer !== undefined) this.ports.clearTimer(this.timer);
		this.timer = undefined;
		// Store work deferred by an unavailable write, and verdicts kept across one, are dropped: the next start derives
		// that work again (its discovery reconciles every session, applies retention and republishes frontiers), and
		// nothing of this run stays resident or re-arms the timer.
		this.resetRetryState();
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		const running = [...this.inFlight.values()];
		for (const entry of running) entry.controller.abort();
		return running;
	}

	/** An unrecoverable condition (superseded writer, corrupt manifest): stop doing background work and say why. */
	private fatal(reason: string): void {
		this.run.setDisabledReason(reason);
		this.haltBackground();
		// A coordinator that stops itself still emits its terminal signal, with the real cause.
		this.finishBatch("stopped", this.run.scheduler?.counts().running ?? 0, reason);
	}

	// ---- indexing helpers ---------------------------------------------------------------------

	/**
	 * Apply a published revocation to the local mirror and reconcile the scheduler with it: the revoked
	 * nodes leave the ready index, the ready jobs that vouched for them are dropped (the rule restart recovery
	 * applies) and parents whose two children survived are admitted again.
	 */
	private afterRevocation(
		revoked: readonly string[],
		revision: number,
		droppedCursors: readonly string[],
		reason: TranscriptMemoryRevocationRecord["reason"],
		alreadyDroppedReady: number,
	): void {
		this.manifestRevision = revision;
		const revokedSet = new Set(revoked);
		this.endRevokedReadmissions(this.sessionsOf(revoked), revokedSet);
		for (const id of revoked) {
			this.catalog.unindex(id);
		}
		for (const sessionId of droppedCursors) this.cursors.delete(sessionId);
		// Only an invalidation can be derived again: a retention or forgetting revocation is permanent, so its
		// identity is never re-admitted (re-deriving it could only be refused at publication).
		const reconciled = this.run.scheduler?.revokeNodes(revoked, this.ports.now(), {
			readmit: reason === "invalidated" || reason === "admission_rejected" || reason === "admission_uncertain",
		});
		if (reconciled && reconciled.readmitted.length > 0) this.batch.noteEnqueued();
		this.lastRevocation = {
			at: this.ports.now(),
			reason,
			revokedNodes: revoked.length,
			droppedReadyJobs: alreadyDroppedReady + (reconciled?.dropped.length ?? 0),
			readmittedParents: reconciled?.readmitted.length ?? 0,
		};
	}

	/**
	 * End the re-admission jobs of revoked nodes in these sessions: a judgment of a node that is gone is no longer wanted, so
	 * its in-flight request is aborted rather than left to pay, and each ended job counts as stale.
	 */
	private endRevokedReadmissions(sessionIds: Iterable<string>, revoked: ReadonlySet<string>): void {
		endRevokedReadmissionsOf(this.host, sessionIds, revoked);
	}

	/** Sessions that own any of these nodes. Call before the nodes are unindexed. */
	private sessionsOf(nodeIds: readonly string[]): Set<string> {
		return sessionsOfNodes(this.host, nodeIds);
	}

	/** End a session's jobs and count them in the open batch. */
	private endSessionJobs(sessionId: string, to: "cancelled" | "stale"): number {
		return endSessionJobsOf(this.host, sessionId, to);
	}

	private dropFrontiers(names: readonly string[]): void {
		dropFrontierSelections(this.host, names);
	}

	// ---- reconcile ----------------------------------------------------------------------------

	private reconcileAll(epoch: number): Promise<void> {
		return reconcileAllSessions(this.host, epoch);
	}

	/**
	 * Reach every session that still owns a recovered leaf held for reconciliation and was not visited: a session
	 * deleted while pi was down, skipped or unsupported by the index, or beyond a listing that failed or was cut off.
	 * The probe in {@link reconcileSession} ends a session that is gone through invalidation (its held jobs end stale)
	 * and enumerates a readable one, which adopts and releases its held leaves. A probe that is unavailable leaves
	 * them held; this runs again on the next index change and lifecycle timer wake (never by polling), until each is
	 * reconciled or ended. Bounded by the held set.
	 */
	private reconcileHeldSessions(visited: ReadonlySet<string>, epoch: number): Promise<void> {
		return reconcileHeldSessionsOf(this.host, visited, epoch);
	}

	/**
	 * Remove anchors, spent budgets and dormant nodes of these sessions from the store and from the local mirrors. False
	 * when the writer is gone or the drop was refused (the coordinator stopped); the store's `unavailable` when it could
	 * not be written (nothing changed).
	 */
	private async dropSessionRecords(
		sessionIds: ReadonlySet<string>,
	): Promise<boolean | TranscriptSummaryStoreUnavailable> {
		const result = await this.run.writer?.dropSessionRecords(sessionIds);
		if (!result) return false;
		if (result.status === "unavailable") return result;
		if (result.status !== "saved") {
			this.fatal(`dropping session records was refused: ${result.status}`);
			return false;
		}
		this.manifestRevision = result.revision;
		this.catalog.dropSessionAnchors(sessionIds);
		for (const id of result.dormant) this.dormant.delete(id);
		this.run.scheduler?.forgetSpentOf(sessionIds);
		this.run.scheduler?.setProofHold(result.ledger.hold);
		this.proofLedger = result.ledger;
		// The only reclaim of spent budgets: a freed slot gives held work another chance (never a lost-proof scope).
		if (result.spent > 0 && this.live(this.run.epoch)) this.releaseProofHolds(this.run.epoch);
		return true;
	}

	/**
	 * Reconcile one session and project the outcome onto its recovered leaves still held for reconciliation: the
	 * one wrapper every caller uses (start-up discovery, index changes, held sessions, revocations). While the run
	 * is live, an unanswered read sets their reason to its real cause, and a read that went through resets it to the
	 * current waiting reason. It never releases a hold: only enumeration that adopts a leaf's budget does.
	 */
	private reconcileSession(sessionId: string, epoch: number): Promise<void> {
		return reconcileSessionOf(this.host, sessionId, epoch);
	}

	/**
	 * Probe, then revoke dead coverage or enumerate. Returns the real cause when the session could not be read now:
	 * the probe (neither readable nor confirmed gone), the verification read after a lineage change, the read that
	 * rediscovers the session after a revocation, or an enumeration page; undefined otherwise. It never projects:
	 * the wrapper whose read started it does. Dead coverage is revoked when the runtime does not vouch for the probe's
	 * lineage ({@link vouchesFor}: neither the verified digest nor, after a pure append, the verified stamp) or when
	 * the index invalidated the session ({@link SessionRuntimes.isDue}); a due revocation is taken only by a read that
	 * answers, and stays due when its verification does not. Every page the verification and the enumeration read
	 * must carry the probe's {@link lineageStamp}: one that does not means the lineage moved during verification,
	 * nothing is recorded and the revocation is due again. A read that enumerated certifies the cursor when the
	 * runtime vouches for a lineage the cursor does not name ({@link certifyCursor}).
	 */
	private reconcileSessionRead(sessionId: string, epoch: number): Promise<string | undefined> {
		return reconcileSessionReadOf(this.host, sessionId, epoch);
	}

	/**
	 * Discovery of a session restarts from its cursor, the end of its live prefix: groups enumeration passed over
	 * without a job (expired ones) may differ on the new lineage. The runtime vouches for `verified`, a verification
	 * of the session's whole coverage its caller just completed with nothing dead left, else for the cursor's digest
	 * as a fresh runtime does.
	 */
	private restartDiscovery(sessionId: string, runtime: SessionRuntime, verified: VerifiedLineage | undefined): void {
		restartDiscoveryOf(this.host, sessionId, runtime, verified);
	}

	/**
	 * Record durably what the runtime vouches for when the session's cursor names another lineage, so a later start
	 * trusts the cursor instead of verifying the whole coverage again. The two differ only after a verification of
	 * the whole coverage (a fresh runtime takes the cursor's digest, a certified publication writes both, and an
	 * uncertified one clears the runtime's), so this writes once per such verification and never in the steady
	 * state. Only the digest changes; nothing is written while a revocation is due, by a runtime a reload replaced,
	 * or for a session without a cursor (it has no accepted coverage to certify). A revision is never adopted
	 * without its mirror (C6).
	 */
	private async certifyCursor(sessionId: string, runtime: SessionRuntime, epoch: number): Promise<void> {
		const { writer } = this.run;
		const cursor = this.cursors.get(sessionId);
		const digest = runtime.verifiedDigest;
		if (!writer || !this.live(epoch) || this.sessions.get(sessionId) !== runtime) return;
		if (this.sessions.isDue(sessionId) || !cursor || digest === undefined || cursor.lineageDigest === digest) return;
		const certified: TranscriptSummarySessionCursor = { ...cursor, lineageDigest: digest };
		const result = await writer.publish({
			expectedRevision: this.manifestRevision,
			sessions: { [sessionId]: certified },
		});
		if (result.status === "published") {
			// Durable already: the mirror takes it with its revision whether or not this run continues (C6).
			this.manifestRevision = result.revision;
			this.cursors.set(sessionId, certified);
			return;
		}
		if (!this.live(epoch)) return;
		// Not certified: the session's next read (or the store retry) certifies it.
		if (result.status === "unavailable") this.deferStoreWork(result.reason, { sessions: [sessionId] }, epoch);
		else if (result.status === "stale_revision") await this.reloadMirror(epoch);
		else this.fatal(`certifying the cursor of ${sessionId} was refused: ${result.status}`);
	}

	/**
	 * The selected lineage of a session changed. Keep every accepted node whose coverage is still live and revoke
	 * only the rest, so switching a branch away and back never summarizes the shared prefix again:
	 * - an accepted leaf is live when its context and covered spans are exactly the live spans at its position;
	 *   a dead leaf is revoked with every ancestor (the store closes over parents) and, as before, any node of
	 *   another session that consulted this one as context; the store pulls the session cursor back to the
	 *   earliest revoked leaf, the end of the live prefix, all in one fenced write (a refusal is fatal);
	 * - a live leaf job whose spans are no longer live, and a parent job whose child was revoked, end `stale`
	 *   (their started attempts are carried); every other job is untouched.
	 * The lineage is read in pages from each check's own start (at most {@link ENUMERATION_PAGE_SPANS} spans per
	 * read, every check at most 8 spans plus its context). A session that is gone is invalidated whole; a read
	 * that does not answer decides nothing: no node is kept or revoked on missing evidence (expansion and
	 * discovery revalidate every leaf live on their own) and the next read tries again.
	 * After a change the session is read again through {@link reconcileSessionRead}, never through the wrapper:
	 * that read's unanswered cause returns as `unreadable`, so the caller's wrapper projects it once. What is left
	 * of the session passed this verification, so its runtime restarts vouching for it ({@link restartDiscovery}):
	 * the re-read verifies again only if the lineage moved since, or a mirror reload dropped the runtime.
	 * Every page must carry `stamp`, the {@link lineageStamp} of the read that started the verification; a page
	 * that does not means the lineage moved during verification: nothing is judged ({@link lineageMoved}).
	 * `unchanged` carries the digest of the newest page read, the lineage every check was verified on.
	 */
	private async revokeDeadCoverage(
		sessionId: string,
		epoch: number,
		stamp: string | undefined,
	): Promise<CoverageVerdict> {
		const { writer, scheduler } = this.run;
		if (!this.live(epoch) || !writer || !scheduler) return { kind: "unreadable", cause: COORDINATOR_NOT_RUNNING };
		const checks: { from: number; refs: readonly TranscriptSourceRef[]; nodeId?: string; jobId?: string }[] = [];
		const deadLeaves = new Set<string>();
		for (const node of this.catalog.sessionNodes(sessionId)?.values() ?? []) {
			if (node.level !== 0) continue;
			// The catalog owns a leaf's dependency range (its context and covered parts); one it cannot place on the
			// lineage (unverifiable, inconsistent) is never readable, so it is not kept either.
			const dependency = this.catalog.dependency(node);
			if (dependency?.kind !== "range") deadLeaves.add(node.id);
			else checks.push({ from: dependency.fromIndex, refs: dependency.refs, nodeId: node.id });
		}
		for (const job of scheduler.snapshot()) {
			if (job.sessionId !== sessionId || job.kind !== "leaf" || isTerminalSummaryJobState(job.state)) continue;
			checks.push({ from: job.spanRange.fromIndex, refs: job.sourceRefs ?? [], jobId: job.id });
		}
		checks.sort((a, b) => a.from - b.from);
		const deadJobs: string[] = [];
		let page: Extract<TranscriptLineageSpansResult, { status: "ok" }> | undefined;
		for (const check of checks) {
			const to = check.from + check.refs.length;
			const pageEnd = page ? page.fromIndex + page.spans.length : 0;
			if (!page || check.from < page.fromIndex || (to > pageEnd && pageEnd < page.total)) {
				const read = await this.ports.reader.listLineageSpans({
					sessionId,
					fromIndex: check.from,
					maxSpans: ENUMERATION_PAGE_SPANS,
				});
				if (!this.live(epoch)) return { kind: "unreadable", cause: COORDINATOR_NOT_RUNNING };
				if (read.status === "not_found") {
					await this.invalidateSession(sessionId, epoch);
					return { kind: "changed" };
				}
				if (read.status !== "ok") {
					this.causes.noteInternal(
						`verifying ${sessionId} after a lineage change: ${read.status}: ${read.reason}`,
					);
					return {
						kind: "unreadable",
						cause: `verifying the lineage after a change: ${read.status}: ${read.reason}`,
					};
				}
				const readStamp = lineageStamp(read);
				if (readStamp === undefined || readStamp !== stamp) {
					return {
						kind: "unreadable",
						cause: this.lineageMoved(sessionId, "verifying the lineage after a change"),
					};
				}
				page = read;
			}
			const window = page.spans.slice(check.from - page.fromIndex, to - page.fromIndex);
			if (coversLiveSpans({ ...page, spans: window }, check.refs)) continue;
			if (check.nodeId !== undefined) deadLeaves.add(check.nodeId);
			if (check.jobId !== undefined) deadJobs.push(check.jobId);
		}
		if (deadLeaves.size === 0 && deadJobs.length === 0) return { kind: "unchanged", digest: page?.lineageDigest };
		const verified: VerifiedLineage | undefined = page ? { digest: page.lineageDigest, stamp } : undefined;
		if (deadLeaves.size === 0) {
			this.staleJobs(deadJobs);
			const runtime = this.sessions.get(sessionId);
			if (runtime) this.restartDiscovery(sessionId, runtime, verified);
			this.markJobsDirty();
			const unread = await this.reconcileSessionRead(sessionId, epoch);
			return unread === undefined ? { kind: "changed" } : { kind: "unreadable", cause: unread };
		}
		const result = await writer.revokeNodes(
			(id, entry) =>
				deadLeaves.has(id) ||
				(entry.sessionId !== sessionId && entry.contextRefs.some((handle) => handle.split(":")[1] === sessionId)),
			"invalidated",
			// Their content is parked dormant: switching back republishes the identical identity without paying again.
			{ park: true },
		);
		if (!this.live(epoch)) {
			// Durable already: the mirror takes it with its revision even though this run will not continue (C6).
			if (result.status === "published") this.mirrorRevocation(result, "invalidated", undefined, 0);
			return { kind: "changed" };
		}
		if (result.status === "unavailable") {
			// Nothing was revoked, so nothing is judged: the session is read again after the store backoff.
			this.deferStoreWork(result.reason, { sessions: [sessionId] }, epoch);
			return { kind: "unreadable", cause: result.reason };
		}
		if (result.status !== "published") {
			this.fatal(`revoking the dead coverage of ${sessionId} was refused: ${result.status}`);
			return { kind: "changed" };
		}
		const revoked = new Set(result.revoked);
		for (const job of scheduler.snapshot()) {
			if (
				job.kind === "parent" &&
				!isTerminalSummaryJobState(job.state) &&
				job.children?.some((id) => revoked.has(id))
			)
				deadJobs.push(job.id);
		}
		this.staleJobs(deadJobs);
		await this.applyRevocation(result, epoch, { reason: "invalidated", rereadSession: { sessionId, verified } });
		const unread = await this.reconcileSessionRead(sessionId, epoch);
		return unread === undefined ? { kind: "changed" } : { kind: "unreadable", cause: unread };
	}

	/**
	 * The lineage of a session moved while one derivation was reading it (a page's {@link lineageStamp} differs from
	 * the read that started it): nothing that derivation gathered is recorded, and the session's next read verifies
	 * its coverage whatever the digests say. Returns the cause.
	 */
	private lineageMoved(sessionId: string, during: string): string {
		return lineageMovedDuring(this.host, sessionId, during);
	}

	/** End these jobs `stale` (their coverage is no longer live): in-flight work is aborted, the batch counts them. */
	private staleJobs(jobIds: readonly string[]): void {
		staleJobsOf(this.host, jobIds);
	}

	/** The session is gone: everything derived from it is revoked and its cursor dropped. */
	private async invalidateSession(sessionId: string, epoch: number): Promise<void> {
		const { writer, scheduler } = this.run;
		if (!this.live(epoch) || !writer || !scheduler) return;
		this.abortSession(sessionId);
		const droppedReady = this.endSessionJobs(sessionId, "stale");
		const result = await writer.invalidateSession(sessionId);
		if (result.status === "unavailable") {
			// Its jobs ended above; the probe that finds the session gone runs again after the store backoff.
			this.deferStoreWork(result.reason, { sessions: [sessionId] }, epoch);
			return;
		}
		if (result.status !== "published") return this.fatal(`invalidating ${sessionId} was refused: ${result.status}`);
		await this.applyRevocation(result, epoch, { reason: "invalidated", dropSession: sessionId, droppedReady });
	}

	/**
	 * The one local transition for a published revocation, whatever caused it (invalidation, retention,
	 * forgetting): unindex the revoked nodes, reconcile the scheduler, drop the frontiers they were in, take
	 * back the cursors the store pulled, reset discovery for every affected session, republish the frontiers
	 * of the sessions that kept nodes and discover again what the revocation uncovered. `dropSession`, when
	 * given, loses its cursor and discovery state outright; its caller discovers it again. `rereadSession`, when
	 * given, takes its pulled-back cursor like every affected session but keeps its runtime, restarted to vouch for
	 * the verification its caller just made ({@link restartDiscovery}; a reload below drops it with every runtime),
	 * and is not discovered here: its caller reads it again itself and hands the outcome to its own wrapper.
	 */
	private applyRevocation(
		result: PublishedRevocation,
		epoch: number,
		options: {
			reason: TranscriptMemoryRevocationRecord["reason"];
			dropSession?: string;
			rereadSession?: { sessionId: string; verified: VerifiedLineage | undefined };
			droppedReady?: number;
		},
	): Promise<void> {
		return applyRevocationOf(this.host, result, epoch, options);
	}

	/**
	 * The mirror side of a published revocation, in one synchronous step with its revision (contract C6): parked
	 * content is taken before the catalog lets it go, then the nodes leave the catalog and the scheduler. A durable
	 * revocation is always mirrored, even by a run that is no longer live; everything after it is the caller's.
	 */
	private mirrorRevocation(
		result: PublishedRevocation,
		reason: TranscriptMemoryRevocationRecord["reason"],
		dropSession: string | undefined,
		droppedReady: number,
	): void {
		mirrorRevocationOf(this.host, result, reason, dropSession, droppedReady);
	}

	private abortSession(sessionId: string): void {
		abortSessionJobs(this.host, sessionId);
	}

	// ---- retention ----------------------------------------------------------------------------
	//
	// `retentionDays` ages out DERIVED summaries only. A source's age is its entry event time; with none, the
	// canonical session timestamp; with none, the instant it was first captured. That anchor is persisted per
	// canonical source (not per recipe, job or node), so invalidation, re-admission and rebuilds never reset
	// it, and time is never inferred from order or digests.

	private retentionCutoff(): number | undefined {
		return retentionCutoffAt(this.host);
	}

	/** The instant the next accepted node expires; undefined when retention is off or nothing can expire. */
	private nextRetentionAt(): number | undefined {
		return nextRetentionDeadline(this.host);
	}

	/**
	 * The canonical session timestamp; `null` when the session records none. `undefined` means the listing is
	 * unavailable right now, which must not decide an anchor's basis for good.
	 */
	private sessionTimestamp(sessionId: string): Promise<string | null | undefined> {
		return sessionTimestampOf(this.host, sessionId);
	}

	/**
	 * Persist an anchor for each source that has none yet (set-if-absent in the store). Returns false when the
	 * anchor ceiling refused any of them: that work is held with a diagnostic, never treated as ageless. The store's
	 * `unavailable` when the write could not be served (nothing was anchored; the caller defers its work).
	 */
	private async anchorRefs(
		sources: readonly { ref: TranscriptSourceRef; legacyHandle?: string }[],
		epoch: number,
	): Promise<boolean | TranscriptSummaryStoreUnavailable> {
		const writer = this.run.writer;
		if (!writer || !this.live(epoch)) return false;
		const requests: TranscriptAnchorRequest[] = [];
		const seen = new Set<string>();
		for (const { ref, legacyHandle } of sources) {
			const handle = formatTranscriptSourceHandle(ref);
			if (this.catalog.anchorAt(ref) !== undefined || seen.has(handle)) continue;
			seen.add(handle);
			const stamp = await this.sessionTimestamp(ref.sessionId);
			// The listing is unavailable: hold this drain and retry, rather than settle for a weaker basis for good.
			if (stamp === undefined) return false;
			requests.push({
				...(stamp !== null
					? { handle, at: new Date(Date.parse(stamp)).toISOString(), basis: "session_timestamp" as const }
					: { handle, at: new Date(this.ports.now()).toISOString(), basis: "first_capture" as const }),
				// The store moves an anchor the same source had under capture version 1, with its age, instead.
				...(legacyHandle !== undefined ? { legacyHandle } : {}),
			});
		}
		if (requests.length === 0) return true;
		const result = await writer.anchorSources(requests);
		if (result.status === "unavailable") return result;
		if (result.status === "fenced" || result.status === "manifest_corrupt") {
			if (this.live(epoch)) this.fatal(`recording retention anchors was refused: ${result.status}`);
			return false;
		}
		// Durable already: the mirror takes the anchors with their revision whether or not this run continues (C6).
		this.manifestRevision = result.revision;
		const refused = new Set(result.status === "capacity" ? result.refused : []);
		for (const handle of refused) this.sessions.holdAnchor(handle);
		for (const { handle } of result.recorded) this.sessions.releaseAnchor(handle);
		// The anchors as the store holds them now: a moved one leaves its version 1 handle and carries its age.
		this.catalog.forgetAnchors(result.moved);
		this.catalog.recordAnchors(result.recorded);
		return this.live(epoch) && refused.size === 0;
	}

	/**
	 * Nodes accepted before anchors existed, and nodes whose anchors were lost to damage, depended only on
	 * undated sources (a dated one would have left a dependency time). They are anchored now, at first sight,
	 * so no accepted node stays unable to age.
	 */
	private async anchorUndatedNodes(epoch: number): Promise<void> {
		const refs: { ref: TranscriptSourceRef }[] = [];
		for (const node of this.catalog.values()) {
			// A parent's coverage is its leaves', which are visited here themselves.
			if (node.oldestDependencyAt !== undefined || node.children) continue;
			for (const ref of [...node.sourceRefs, ...node.contextRefs]) {
				if (this.catalog.anchorAt(ref) === undefined) refs.push({ ref });
			}
		}
		// A listing that was unavailable leaves the rest pending; the next index event tries again. A write that could
		// not be served is tried again after the store backoff.
		const anchored = refs.length > 0 ? await this.anchorRefs(refs, epoch) : true;
		this.sessions.setUndatedPending(anchored !== true);
		if (anchored !== true && anchored !== false) this.deferStoreWork(anchored.reason, { anchors: true }, epoch);
	}

	/**
	 * Revoke the accepted nodes that depend on a source past the retention window, with every ancestor and
	 * frontier built on them. At most {@link RETENTION_REVOKE_BATCH} expired roots are taken per drain; the
	 * rest follow through the mailbox. Revoked ids are tombstoned, so a late result can never republish them.
	 */
	private applyRetention(epoch: number): Promise<void> {
		return applyRetentionPass(this.host, epoch);
	}

	// ---- frontier -----------------------------------------------------------------------------

	private computeFrontier(sessionId: string, extra?: TranscriptSummaryNode) {
		return computeFrontierSelection(this.host, sessionId, extra);
	}

	/** Recompute and publish frontiers for sessions whose nodes changed outside a normal completion. */
	private async republishFrontiers(sessionIds: readonly string[], epoch: number): Promise<void> {
		const writer = this.run.writer;
		if (!writer || !this.live(epoch)) return;
		const frontiers: Record<string, TranscriptFrontierSelection> = {};
		const removeFrontiers: string[] = [];
		for (const sessionId of new Set(sessionIds)) {
			const nodes = this.catalog.sessionNodes(sessionId);
			if (!nodes?.size) continue;
			// Nothing approved is left to describe: the persisted frontier is removed rather than left naming withheld nodes.
			if (!this.catalog.hasApproved(sessionId)) {
				if (this.frontiers.has(sessionId)) removeFrontiers.push(sessionId);
				continue;
			}
			const result = this.computeFrontier(sessionId);
			this.frontierBytes.set(sessionId, { bytes: result.bytes, ...(result.gap ? { gap: result.gap } : {}) });
			if (result.changed) frontiers[sessionId] = result.selection;
		}
		if (Object.keys(frontiers).length === 0 && removeFrontiers.length === 0) return;
		const published = await writer.publish({
			expectedRevision: this.manifestRevision,
			frontiers,
			...(removeFrontiers.length > 0 ? { removeFrontiers } : {}),
		});
		if (published.status !== "published") {
			// A revision is never adopted without its mirror (C6): the store moved past it, so the mirror is reloaded. A
			// write that could not be served is tried again after the store backoff.
			if (published.status === "unavailable")
				this.deferStoreWork(published.reason, { frontiers: sessionIds }, epoch);
			else if (published.status === "stale_revision") await this.reloadMirror(epoch);
			else this.fatal(`publishing frontiers was refused: ${published.status}`);
			return;
		}
		this.manifestRevision = published.revision;
		this.dropFrontiers(removeFrontiers);
		for (const [name, selection] of Object.entries(frontiers)) {
			this.frontiers.set(name, selection);
			this.ports.onFrontierChanged(name, selection.revision);
		}
	}

	// ---- running jobs -------------------------------------------------------------------------

	private pump(epoch: number): void {
		const scheduler = this.run.scheduler;
		const summarizer = this.ports.summarizer;
		if (!this.live(epoch) || !scheduler || !summarizer) return;
		// Model work becoming possible again releases the jobs held for it and gives re-admission its turn.
		const blocked = this.modelWorkBlock() !== undefined;
		this.holds.modelWork(blocked);
		if (this.receipts.at === undefined && scheduler.hasReleasedReceipts(this.ports.ownerSessionId())) {
			this.retryReleasedReceipts();
		}
		this.enqueueReadmissions();
		this.holds.prune((id) => this.run.scheduler?.get(id)?.state);
		// Parents held at the live-job cap come back once live work fell below it.
		if (scheduler.admitBelowLiveBound(this.ports.now()).length > 0) this.batch.noteEnqueued();
		// Nothing is claimed before admission opens: recovered work has not adopted its version 1 budgets yet.
		while (this.run.phase === "open" && this.ports.canRunBackground()) {
			// Dispatch is the one place the attempt budget is enforced: an exhausted job never reaches a provider.
			// Held jobs wait for their condition; claiming them again would only hold them again.
			const claim = scheduler.claimNext(this.ports.now(), (candidate) => {
				if (this.holds.parked.has(candidate.id)) return true;
				// A kept paid verdict (current admission contract) whose receipt is owed to ANOTHER session can only be recorded by a
				// coordinator of that session, which also owns any replacement of that verdict (changed input or text: the owner claims
				// the job, judges again and setPendingVerdict hands the replaced receipt to the owed queue). A claim here would only save
				// a started attempt, then return it, for a call this coordinator never makes: write churn on every start, and an attempt
				// kept if a stop or crash lands between the claim and its settle (interrupt and recover leave attempts alone). A verdict
				// under another contract version is not reused by any session, so it stays claimable and is judged again.
				const verdict = candidate.pendingVerdict;
				if (
					verdict !== undefined &&
					verdict.contractVersion === TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION &&
					verdict.ownerSessionId !== this.ports.ownerSessionId() &&
					verdict.receipts.some((receipt) => receipt.status === "unrecorded")
				) {
					this.holds.park(candidate.id, {
						scope: "usage_receipt",
						reason: `the paid answer's usage receipt belongs to session ${verdict.ownerSessionId}, which is not this session; it is recorded when a coordinator starts in it`,
					});
					return true;
				}
				return false;
			});
			for (const spent of claim.exhausted) this.settleExhausted(spent, epoch);
			if (!claim.claimed) break;
			const { job, token } = claim.claimed;
			this.batch.noteEnqueued();
			this.markJobsDirty();
			// The started attempt is durable before its provider call, so a crash cannot grant another one: the save that
			// includes this claim must ACKNOWLEDGE its attempt count (a failed save only leaves the barrier settled). That
			// same save reserved the job's terminal proof or refused it: only a job holding its record may reach a
			// provider (a recovered job included), so its failure can always be kept. Both are required.
			const persisted = this.jobsSaved;
			const controller = new AbortController();
			const done = persisted
				.then((): JobOutcome | Promise<JobOutcome> =>
					controller.signal.aborted || !this.live(epoch)
						? { kind: "aborted" }
						: (this.durableAttempts.get(job.id) ?? -1) < job.attempts
							? { kind: "held", scope: "persistence", reason: this.persistenceHoldReason() }
							: !scheduler.hasProof(job.id)
								? { kind: "held", scope: "proof", reason: this.proofHoldReason() }
								: // The claim itself must still be the job's authority: a merge or any other change since the
									// claim (while its save was pending) makes it stale, whatever the acknowledged count says.
									!scheduler.isClaimCurrent(token)
									? { kind: "abandoned", reason: CLAIM_SUPERSEDED_BEFORE_DISPATCH }
									: this.runJob(job, token, summarizer, controller.signal, epoch),
				)
				.then((outcome) => this.enqueue(async () => this.settle(job, token, outcome, epoch)));
			this.inFlight.set(token.claimId, { jobId: job.id, controller, done });
			void done.finally(() => this.inFlight.delete(token.claimId));
		}
		this.maybeFinishBatch();
		this.armTimer(epoch);
	}

	/** Why a claimed attempt was not made durable: the real cause of the failed save. */
	private persistenceHoldReason(): string {
		return holdReason(
			this.saveFailure ?? "no save acknowledged the job list holding this attempt",
			"the job list holding this attempt was not saved, so it waits for the next successful save, retried with backoff",
		);
	}

	/** Why a claimed job could not get its terminal-proof record, from the capacity the store last reported. */
	private proofHoldReason(): string {
		const { recorded, hold } = this.proofLedger;
		const since = hold ? `; ${hold.cause} hold since ${hold.since}` : "";
		return `the terminal-proof ledger has no slot for this job (${recorded} of ${TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS} records${since}); it waits so its attempt budget can always be kept`;
	}

	/**
	 * A terminal-proof slot freed (a released reservation, a reclaimed session): jobs and parents held for one
	 * get another chance, and enumeration stopped at the bound resumes. What still does not fit is held again.
	 */
	private releaseProofHolds(epoch: number): void {
		const scheduler = this.run.scheduler;
		if (!scheduler) return;
		this.holds.release("proof");
		if (scheduler.retryProofHolds(this.ports.now()).length > 0) this.batch.noteEnqueued();
		for (const [sessionId, runtime] of this.sessions.entries()) {
			if (runtime.backpressured) this.resumeDeferredEnumeration(sessionId, epoch);
		}
		this.pump(epoch);
	}

	/** A queued job whose attempts were all spent: terminal `failed` / `attempts_exhausted`, reported like any failure. */
	private settleExhausted(job: TranscriptSummaryJob, epoch: number): void {
		const message = job.lastError?.message ?? "the attempt budget was spent before the job completed";
		this.batch.noteEnqueued();
		this.batch.recordFailure(job, "attempts_exhausted", message);
		this.batch.countTerminal("failed", job, "attempts_exhausted", message);
		this.markJobsDirty();
		this.resumeDeferredEnumeration(job.sessionId, epoch);
	}

	/**
	 * ONE lifecycle-owned wake for the earliest of the next job retry, the next retention deadline and the next
	 * re-admission retry. A delay past
	 * the timer ceiling re-arms on firing; a stop or reload cancels it; a restart recomputes both from
	 * persisted state.
	 */
	private armTimer(epoch: number): void {
		if (this.timer !== undefined) this.ports.clearTimer(this.timer);
		this.timer = undefined;
		if (!this.live(epoch)) return;
		const candidates = [
			this.run.scheduler?.nextWakeAt(),
			// Deferred retention waits for the store retry, so a due deadline cannot re-arm the timer at once.
			this.storeRetry.work.retention ? undefined : this.nextRetentionAt(),
			this.saveBackoff.at,
			this.storeRetry.at,
			this.receipts.at,
		].filter((value): value is number => value !== undefined);
		if (candidates.length === 0) return;
		const at = Math.min(...candidates);
		this.timer = this.ports.setTimer(
			() => {
				this.timer = undefined;
				void this.enqueue(async () => {
					if (!this.live(epoch) || !this.run.scheduler) return;
					this.run.scheduler.promoteDue(this.ports.now());
					// A failed job save that is due is tried again by this save.
					if (this.saveBackoff.at !== undefined && this.saveBackoff.at <= this.ports.now())
						this.saveBackoff.disarm();
					// Owed usage receipts are tried again: the held jobs are released and claim the kept verdict, not the provider.
					if (this.receipts.at !== undefined && this.receipts.at <= this.ports.now()) {
						this.receipts.disarm();
						this.holds.release("usage_receipt");
						this.retryReleasedReceipts();
					}
					this.markJobsDirty();
					try {
						const due = this.nextRetentionAt();
						if (!this.storeRetry.work.retention && due !== undefined && due <= this.ports.now()) {
							try {
								await this.applyRetention(epoch);
							} catch (error) {
								// Retention that threw stays due: it is retried on the store backoff, not on a timer that is
								// due again at once.
								this.deferStoreWork(
									error instanceof Error ? error.message : String(error),
									{ retention: true },
									epoch,
								);
							}
						}
						// A lifecycle wake also retries held recovered leaves whose sessions could not be read before.
						if (this.run.phase === "open") {
							try {
								await this.reconcileHeldSessions(new Set(), epoch);
							} catch (error) {
								// Its cause is recorded and the next wake reads those sessions again; the store retry below still runs,
								// so a due backoff is never left to re-arm the timer at once.
								this.causes.noteInternal(
									`reading held sessions: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}
						if (this.storeRetry.at !== undefined && this.storeRetry.at <= this.ports.now())
							await this.retryStoreWork(epoch);
					} finally {
						// The one wake path: pump claims what is due and re-arms the timer, so a step that threw (the mailbox
						// records its cause) never leaves a due retry or the next wake unscheduled. Claims still wait for their
						// durable attempt save and held jobs stay parked.
						this.pump(epoch);
					}
				});
			},
			Math.min(MAX_TIMER_DELAY_MS, Math.max(0, at - this.ports.now())),
		);
	}

	private runJob(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		summarizer: TranscriptSummarizerPort,
		signal: AbortSignal,
		epoch: number,
	): Promise<JobOutcome> {
		return runSummaryJob(this.host, job, token, summarizer, signal, epoch);
	}

	/**
	 * One summary call and its two admissions. First the deterministic checks (an invalid reply is retried within
	 * the job's existing attempt budget, never clipped), then the evidence-quality judgment of the exact input (model summaries only: an
	 * exact copy never gets here). Only an accepted judgment returns text; every other disposition ends or
	 * retries the job with its real cause and publishes nothing.
	 *
	 * Rejected and uncertain end the job: they are verdicts on this exact input, and sampling again until a
	 * judgment passes would turn the gate into a lottery (a changed input is a different job). An evaluator that
	 * did not answer is temporary and retried within the attempt budget, reusing the validated reply so the
	 * summarizer is not paid again; one that refuses this exact input (a credential in it, an invalid request,
	 * an input over the ceiling) would refuse it every time and ends the job.
	 */
	private async summarizeChecked(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		summarizer: TranscriptSummarizerPort,
		summary: SummaryRequest,
		signal: AbortSignal,
		sourceRefs: readonly TranscriptSourceRef[],
		contextRefs: readonly TranscriptSourceRef[],
		admissionInput: Pick<TranscriptSummaryAdmissionRequest, "level" | "target" | "context">,
	): Promise<{ text: string; model: string; admission: TranscriptSummaryAdmissionRecord } | { outcome: JobOutcome }> {
		const port = this.ports.admission;
		if (!port) {
			return {
				outcome: { kind: "held", scope: "model_work", reason: "no summary admission evaluator is configured" },
			};
		}
		// A validated reply kept on the job (an evaluator retry, a restart between reply and judgment) is used instead
		// of paying the summarizer again, but only for the exact input and recipe it answered, and only if it still
		// passes the deterministic checks. It is judged again unless its acceptance was kept with it (below). The input is
		// named by its logical key ({@link summaryRequest}), never by the rendered prompt, whose fences carry a fresh nonce.
		const { prompt, inputKey } = summary;
		const checks = { projectId: sourceRefs[0]?.projectId ?? "", sourceRefs, contextRefs };
		const kept = job.pendingReply;
		let reply: { text: string; model: string };
		let paid = false;
		if (
			kept !== undefined &&
			kept.inputKey === inputKey &&
			kept.recipeVersion === TRANSCRIPT_SUMMARY_RECIPE_VERSION &&
			validateSummaryText(kept.text, checks).ok
		) {
			reply = { text: kept.text, model: kept.model };
		} else {
			// The provider boundary: checked synchronously, with nothing awaited between this check and the call.
			if (!this.run.scheduler?.isClaimCurrent(token)) {
				return { outcome: { kind: "abandoned", reason: CLAIM_SUPERSEDED_BEFORE_SUMMARY } };
			}
			paid = true;
			this.receipts.markPaid(token.claimId);
			try {
				reply = await summarizer.summarize(
					{ system: SUMMARY_SYSTEM_PROMPT, prompt, maxOutputBytes: TRANSCRIPT_SUMMARY_MAX_BYTES },
					signal,
				);
			} catch (error) {
				throw new SummarizerCallError(summarizer.model, error);
			}
			const check = validateSummaryText(reply.text, checks);
			if (!check.ok) {
				return {
					outcome: {
						kind: "fail",
						failure: {
							kind: "transient",
							reason: "summary_shape_invalid",
							message: `${check.reason}: ${check.detail}`,
						},
					},
				};
			}
			// Kept durably before the judgment starts when the save acknowledges it, so the paid reply survives whatever
			// happens to the evaluator or the process; otherwise it is judged un-kept, with the cause recorded.
			await this.keepReply(token, {
				text: reply.text,
				model: reply.model,
				textDigest: summaryTextDigest(reply.text),
				inputKey,
				recipeVersion: TRANSCRIPT_SUMMARY_RECIPE_VERSION,
				captureVersion: TRANSCRIPT_CAPTURE_VERSION,
			});
		}
		// The second paid call, checked the same way. A claim superseded after its summarizer call has spent that
		// attempt: the round ends with the paid reply kept, the increment is not returned.
		if (!this.run.scheduler?.isClaimCurrent(token)) {
			return {
				outcome: paid
					? { kind: "superseded", reason: CLAIM_SUPERSEDED_AFTER_SUMMARY }
					: { kind: "abandoned", reason: CLAIM_SUPERSEDED_BEFORE_ADMISSION },
			};
		}
		// An acceptance kept with the reused reply (a retry after the judgment: an index that did not answer at
		// publication, a restart before it) is the verdict on this exact reply, input and contract. It is published
		// again, not asked again, so the evaluator is neither paid twice nor able to flip it, and is counted as reused,
		// never as a judgment. Publication re-checks the policy and contract fences whatever produced the judgment.
		const request = { recipeVersion: TRANSCRIPT_SUMMARY_RECIPE_VERSION, ...admissionInput };
		const inputDigest = createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
		const keptAdmission = paid ? undefined : kept?.admission;
		if (
			keptAdmission !== undefined &&
			keptAdmission.inputDigest === inputDigest &&
			keptAdmission.record.contractVersion === TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION &&
			keptAdmission.record.textDigest === summaryTextDigest(reply.text)
		) {
			this.batch.countReuse();
			return { ...reply, admission: keptAdmission.record };
		}
		const judged = await this.judge(job, token, port, { ...request, candidate: reply.text }, inputDigest, signal);
		if ("outcome" in judged) return { outcome: judged.outcome };
		const result = judged.result;
		if (result.disposition === "accepted") {
			this.batch.countJudgment(result.disposition, judged.reused);
			const admission = admissionRecordFromResult(result, reply.text, new Date(this.ports.now()).toISOString());
			// A broken invariant, not a provider failure: it ends the job with its own class instead of reaching
			// `runJob`'s provider classification.
			if (!admission) {
				return {
					outcome: {
						kind: "fail",
						failure: {
							kind: "internal",
							reason: "internal_error",
							message: "an accepted admission produced no record",
						},
					},
				};
			}
			await this.keepAdmission(token, { record: admission, inputDigest });
			return { ...reply, admission };
		}
		const detail = describeAdmission(result);
		if (result.disposition === "unavailable" && result.cause === "invalid_output") {
			// A paid answer that failed the evaluator contract is evidence of nothing: never reused, never approved, and not an
			// outage to retry. The job ends with that cause.
			this.batch.countJudgment("unavailable", judged.reused);
			return {
				outcome: {
					kind: "fail",
					failure: { kind: "malformed", reason: "admission_invalid_output", message: detail },
				},
			};
		}
		if (
			result.disposition === "unavailable" &&
			result.cause !== "input_too_large" &&
			result.cause !== "request_refused"
		) {
			// Temporary: the validated reply stays on the job for the retry.
			this.batch.countJudgment("unavailable", judged.reused);
			return {
				outcome: { kind: "fail", failure: { kind: "transient", reason: "admission_unavailable", message: detail } },
			};
		}
		if (result.disposition === "unavailable") {
			this.batch.countJudgment("unavailable", judged.reused);
			return {
				outcome: {
					kind: "fail",
					failure: { kind: "policy", reason: `admission_${result.cause}`, message: detail },
				},
			};
		}
		this.batch.countJudgment(result.disposition, judged.reused);
		return {
			outcome: {
				kind: "fail",
				failure: { kind: "malformed", reason: `admission_${result.disposition}`, message: detail },
			},
		};
	}

	/**
	 * One evaluator judgment of `candidate` under a claim, with the paid response's usage receipt settled. A kept paid
	 * verdict on the job (its receipt was owed) is reused after recording the receipt again, never bought again. When a
	 * receipt stays unrecorded the verdict is kept on the job and the outcome is a hold. Callers see logical results
	 * only: semantic requests, transport attempts, receipts and reused verdicts are counted separately on the job.
	 */
	private async judge(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		port: TranscriptSummaryAdmissionPort,
		request: TranscriptSummaryAdmissionRequest,
		inputDigest: string,
		signal: AbortSignal,
	): Promise<{ result: TranscriptSummaryAdmissionResult; reused: boolean } | { outcome: JobOutcome }> {
		const scheduler = this.run.scheduler;
		const textDigest = summaryTextDigest(request.candidate);
		const verdictKey = { inputDigest, textDigest, contractVersion: TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION };
		// A paid answer whose usage receipt was owed (the write failed) is kept on the job: the receipt is recorded again
		// (same id, so totals count it once) and the answer is used, never bought again.
		const owed = scheduler?.pendingVerdictFor(job.id, verdictKey);
		if (owed !== undefined) {
			const settled = this.settleReceipts(port, owed.receipts, owed.ownerSessionId);
			scheduler?.setPendingVerdict(job.id, { ...owed, receipts: settled });
			const recordedNow = countRecorded(settled) - countRecorded(owed.receipts);
			if (settled.some((receipt) => receipt.status === "unrecorded")) {
				scheduler?.addWork(job.id, { receiptsRecorded: recordedNow });
				return { outcome: this.receiptHold(settled, owed.ownerSessionId !== this.ports.ownerSessionId()) };
			}
			scheduler?.addWork(job.id, { reused: 1, receiptsRecorded: recordedNow });
			const result = resultFromVerdict(owed, settled);
			scheduler?.setPendingVerdict(job.id, undefined);
			this.markJobsDirty();
			this.receipts.clearFailures();
			return { result, reused: true };
		}
		// The evaluator call is paid work of this claim too: its attempt is not given back by a later failure.
		this.receipts.markPaid(token.claimId);
		let result: Awaited<ReturnType<TranscriptSummaryAdmissionPort["admit"]>>;
		try {
			result = await port.admit(request, signal);
		} catch (error) {
			// An aborted call that had already been answered by some transport attempt still owes those usage receipts.
			this.settleCarriedReceipts(port, error, job.id);
			throw error;
		}
		// The unit of work is counted as it happened: one semantic request, one transport attempt per paid response.
		const receipts = this.settleReceipts(port, result.receipts, this.ports.ownerSessionId());
		// The job may have ended (and left the list) while the call was in flight: its receipts are still settled below.
		// Counted only when a provider request was sent: a result produced before any send (no evaluator, input too large, a
		// refusal of the exact input, a usage lease refused before payment) reports no semantic request and no transport attempt.
		// Its logical claim attempt is still consumed (a conservative policy): the counters above are the only thing it leaves at zero.
		if (scheduler?.get(job.id) !== undefined && result.requestSent)
			scheduler.addWork(job.id, {
				semanticRequests: 1,
				// At least one per counted request, even when no usage sink is bound and no response carried a receipt.
				transportAttempts: Math.max(1, receipts.length),
				receiptsRecorded: countRecorded(receipts),
			});
		if (receipts.some((receipt) => receipt.status === "unrecorded")) {
			// Kept on the job whatever the disposition: a verdict is not lost, and no receipt is dropped.
			const kept = await this.keepVerdict(
				token,
				verdictOf(result, receipts, token.attempt, this.ports.ownerSessionId(), verdictKey),
			);
			// The job ended while its paid call was in flight: its receipts went to the owed queue and nothing is held.
			if (!kept) return { outcome: { kind: "aborted" } };
			return { outcome: this.receiptHold(receipts) };
		}
		// The result carries the receipts as they stand now (recorded), not as the evaluator returned them.
		return { result: { ...result, receipts }, reused: false };
	}

	/**
	 * The receipts a failed (aborted) call carried are recorded now; the ones that cannot be written go to the owed queue.
	 * Never dropped. A call that carried paid receipts was paid work of the job, counted once here like an answered one; an
	 * abort that carried none is not counted (nothing was paid), and a job that already left the list has no counters.
	 */
	private settleCarriedReceipts(port: TranscriptSummaryAdmissionPort, error: unknown, jobId: string): void {
		const carried = receiptsOf(error);
		const scheduler = this.run.scheduler;
		if (carried.length === 0 || !scheduler) return;
		const owner = this.ports.ownerSessionId();
		const settled = this.settleReceipts(port, carried, owner);
		if (scheduler.get(jobId) !== undefined) {
			scheduler.addWork(jobId, {
				semanticRequests: 1,
				transportAttempts: Math.max(1, settled.length),
				receiptsRecorded: countRecorded(settled),
			});
			// The counters are made durable with the next save, also when every receipt was recorded.
			this.markJobsDirty();
		}
		const unrecorded = settled.filter((receipt) => receipt.status === "unrecorded");
		if (unrecorded.length === 0) return;
		scheduler.returnReleasedReceipts(unrecorded.map((receipt) => ({ ownerSessionId: owner, receipt })));
		this.markJobsDirty();
	}

	/**
	 * Record each owed usage receipt through the admission port (same receipt id, so the usage totals count it once);
	 * the ones that still cannot be written stay `unrecorded` with their real cause. A receipt owed to another session
	 * is never written here: it waits for its own session.
	 */
	private settleReceipts(
		port: TranscriptSummaryAdmissionPort,
		receipts: readonly SystemOneReceipt[],
		ownerSessionId: string,
	): SystemOneReceipt[] {
		return receipts.map((receipt) => {
			if (receipt.status === "recorded") return receipt;
			if (ownerSessionId !== this.ports.ownerSessionId()) {
				return { ...receipt, cause: `the receipt belongs to session ${ownerSessionId}, which is not this session` };
			}
			try {
				port.recordReceipt(receipt);
				const { cause: _cause, ...recorded } = receipt;
				return { ...recorded, status: "recorded" as const };
			} catch (error) {
				return { ...receipt, cause: receiptCause(error) };
			}
		});
	}

	/** The hold for a paid answer whose usage receipt is owed: the real cause of the first receipt that is still unwritten. */
	private receiptHold(receipts: readonly SystemOneReceipt[], foreignOwner = false): JobOutcome {
		const owed = receipts.find((receipt) => receipt.status === "unrecorded");
		const cause = owed?.cause ?? "the usage receipt was not recorded";
		this.causes.noteInternal(`a paid evaluator answer is held for its usage receipt: ${cause}`);
		return {
			kind: "held",
			scope: "usage_receipt",
			reason: holdReason(
				cause,
				foreignOwner
					? "the paid answer is kept; its usage receipt belongs to another session and is recorded when a coordinator starts in that session"
					: "the paid answer is kept and its usage receipt is retried; it is not bought again",
			),
			...(foreignOwner ? { waitsForOwnerSession: true as const } : {}),
		};
	}

	/** Keep the paid verdict on the job, for the claim that still owns it, and wait for the save that makes it durable. */
	private async keepVerdict(
		token: TranscriptSummaryClaimToken,
		verdict: TranscriptSummaryPendingVerdict,
	): Promise<boolean> {
		let kept = false;
		await this.enqueue(async () => {
			const scheduler = this.run.scheduler;
			if (scheduler?.ownsClaim(token)) {
				scheduler.setPendingVerdict(token.jobId, verdict);
				kept = true;
				this.markJobsDirty();
			} else if (scheduler) {
				// The job ended while its paid call was in flight, so no verdict can be kept on it: the receipts still owed go to
				// the owner's queue, as a job that ends holding them hands them over (see releaseOwedReceipts). Never dropped.
				scheduler.returnReleasedReceipts(
					verdict.receipts
						.filter((receipt) => receipt.status === "unrecorded")
						.map((receipt) => ({ ownerSessionId: verdict.ownerSessionId, receipt })),
				);
				this.markJobsDirty();
			}
		});
		await this.jobsSaved;
		return kept;
	}

	/** Arm the bounded retry of owed usage receipts (1 s doubling to one minute while writes keep failing). */
	private armReceiptRetry(): void {
		// One failed round, not one failed job: several held jobs advance the backoff once.
		this.receipts.arm();
		this.armTimer(this.run.epoch);
	}

	/**
	 * Record the usage receipts of jobs that have ended while a paid response's receipt was still owed (the scheduler
	 * queues them): ending a job never drops spend that was not recorded. A receipt that still cannot be written goes back
	 * to the queue and the bounded receipt backoff applies once for the round; one owed to another session waits for it.
	 */
	private retryReleasedReceipts(): void {
		const scheduler = this.run.scheduler;
		const port = this.ports.admission;
		if (!scheduler || !port) return;
		const owed = scheduler.takeReleasedReceipts();
		if (owed.length === 0) return;
		const still: typeof owed = [];
		for (const entry of owed) {
			const [settled] = this.settleReceipts(port, [entry.receipt], entry.ownerSessionId);
			if (settled?.status === "unrecorded") still.push({ ownerSessionId: entry.ownerSessionId, receipt: settled });
		}
		if (still.length === 0) {
			this.receipts.clearFailures();
			this.markJobsDirty();
			return;
		}
		scheduler.returnReleasedReceipts(still);
		this.markJobsDirty();
		this.causes.noteInternal(
			`${still.length} usage receipt(s) of ended jobs are still owed: ${still[0]?.receipt.cause ?? "not recorded"}`,
		);
		if (still.some((entry) => entry.ownerSessionId === this.ports.ownerSessionId())) this.armReceiptRetry();
	}

	/**
	 * Record the validated reply on the running job and wait for the save of the job list holding it. Kept only when
	 * that save acknowledged it ({@link durableReplies}). Otherwise the real cause is recorded and the reply is taken
	 * off the job again: it is used for this judgment un-kept, never reported as saved, and its summarizer call stays
	 * charged to the attempt (which was durable before the call).
	 */
	private async keepReply(token: TranscriptSummaryClaimToken, reply: TranscriptSummaryPendingReply): Promise<void> {
		const { jobId } = token;
		// Only while this claim still owns the job: a late claim never attaches to (or takes from) a replacement.
		await this.enqueue(async () => {
			const scheduler = this.run.scheduler;
			if (!scheduler?.ownsClaim(token)) return;
			scheduler.setPendingReply(jobId, reply);
			this.markJobsDirty();
		});
		await this.jobsSaved;
		if (this.durableReplies.get(jobId) === reply.textDigest) return;
		await this.enqueue(async () => {
			const scheduler = this.run.scheduler;
			if (!scheduler?.ownsClaim(token)) return;
			if (scheduler.get(jobId)?.pendingReply?.textDigest === reply.textDigest)
				scheduler.setPendingReply(jobId, undefined);
			this.causes.noteInternal(
				`the summary reply of job ${jobId.slice(0, 16)} was not kept: ${this.saveFailure ?? "the save holding it was not acknowledged"}`,
			);
		});
	}

	/**
	 * Attach an acceptance to the kept reply it judged, for the claim that still owns the job and only while that same
	 * reply is kept (a reply that was not kept carries nothing). No save of its own: the job's settlement saves the job
	 * list ({@link afterTerminal}), so the acceptance is durable with the retry state it serves, and one lost before
	 * that save (a crash before settlement) is only judged again.
	 */
	private async keepAdmission(
		token: TranscriptSummaryClaimToken,
		admission: TranscriptSummaryKeptAdmission,
	): Promise<void> {
		await this.enqueue(async () => {
			const scheduler = this.run.scheduler;
			if (!scheduler?.ownsClaim(token)) return;
			const pending = scheduler.get(token.jobId)?.pendingReply;
			if (pending?.textDigest !== admission.record.textDigest) return;
			scheduler.setPendingReply(token.jobId, { ...pending, admission });
		});
	}

	private egressBlocked(summarizer: TranscriptSummarizerPort): string | undefined {
		return summarizer.egress === "external" && !this.ports.settings().allowExternalSummaryEgress
			? "external summary egress is not allowed by settings (allowExternalSummaryEgress is off)"
			: undefined;
	}

	// ---- settling -----------------------------------------------------------------------------

	/** Apply a finished job on the mailbox: publish a node, or record why not. Late results are discarded. */
	private async settle(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		outcome: JobOutcome,
		epoch: number,
	): Promise<void> {
		const { scheduler, writer } = this.run;
		// Taken once, whatever the outcome: the claim is over.
		const paidCall = this.receipts.takePaid(token.claimId);
		if (!scheduler || !writer) return;
		const now = this.ports.now();
		// Settled only by the claim that owns the job: a late callback of an older claim (the job was replaced and
		// claimed again under the same id) mutates and records nothing.
		if (!scheduler.ownsClaim(token)) return;
		if (outcome.kind === "aborted" || !this.live(epoch)) {
			if (this.run.started && epoch === this.run.epoch) scheduler.interrupt(job.id, now);
			return;
		}
		if (outcome.kind === "readmitted") {
			await this.settleReadmitted(job, token, outcome, epoch);
			this.afterTerminal(job, epoch);
			return;
		}
		if (outcome.kind === "approved") {
			// No provider call was made under this claim, so its attempt is returned (as for a reused verdict).
			scheduler.completeReadmission(job.id, now, { reused: true });
			this.afterTerminal(job, epoch);
			return;
		}
		if (outcome.kind === "stale" || outcome.kind === "fail") {
			// A re-admission that failed before any paid call gives its claim back; a summary job's failure keeps its attempt.
			this.settleFailure(job, outcome, now, job.kind === "readmission" && !paidCall);
			this.afterTerminal(job, epoch);
			return;
		}
		if (outcome.kind === "held" && outcome.scope === "usage_receipt") {
			// A valid paid answer is kept on the job and its usage receipt is owed: the attempt stays counted (the calls were
			// made), nothing is bought again, and the job waits for the receipt's own bounded retry.
			// A claim that made the paid call keeps its attempt; a retry claim that only re-recorded the receipt returns its own.
			if (paidCall) scheduler.interrupt(job.id, now);
			else scheduler.abandonClaim(token, { message: outcome.reason, reason: "usage_receipt_pending" }, now);
			this.holds.park(job.id, { scope: "usage_receipt", reason: outcome.reason });
			// A receipt owed to THIS session is retried on the bounded backoff. One owed to another session cannot be recorded
			// here, ever (a coordinator's session never changes): it waits for the event that can settle it, the start of a
			// coordinator in the owning session, where the persisted job and its kept verdict are claimed and recorded.
			if (outcome.waitsForOwnerSession !== true) this.armReceiptRetry();
			this.markJobsDirty();
			this.pump(epoch);
			return;
		}
		if (outcome.kind === "held") {
			// Not a failure and not terminal: no provider call was made, so the attempt is returned and the job waits.
			const reason =
				outcome.scope === "children"
					? "admission_children_pending"
					: outcome.scope === "proof"
						? "proof_capacity"
						: outcome.scope === "persistence"
							? "persistence_unacknowledged"
							: "admission_held";
			if (scheduler.abandonClaim(token, { message: outcome.reason, reason }, now)) {
				this.holds.park(job.id, { scope: outcome.scope, reason: outcome.reason });
				// A failed save is retried on its backoff, not at once; that save carries this returned attempt too.
				if (outcome.scope !== "persistence" || this.saveBackoff.at === undefined) this.markJobsDirty();
			}
			this.pump(epoch);
			return;
		}
		if (outcome.kind === "abandoned") {
			// No provider call was made under this claim: it is returned (never below the durable floor) and the job is
			// judged again under its current budget, which ends it exhausted when nothing is left.
			if (scheduler.abandonClaim(token, { message: outcome.reason, reason: "claim_superseded" }, now)) {
				this.markJobsDirty();
			}
			this.pump(epoch);
			return;
		}
		if (outcome.kind === "superseded") {
			// The summarizer was paid under this claim: the attempt stays counted and the kept reply is judged next time.
			scheduler.interrupt(job.id, now);
			this.causes.noteInternal(outcome.reason);
			this.markJobsDirty();
			this.pump(epoch);
			return;
		}
		try {
			await this.publishResult(job, token, outcome.node, epoch, paidCall);
		} catch (error) {
			// A rejection from any step between the claim and its settlement (a port that rejects instead of answering
			// typed) ends the owning claim with its real cause; a claim already settled or replaced settles nothing.
			this.settlePublicationFailure(
				job,
				token,
				epoch,
				paidCall,
				this.thrownPublicationFailure("settling the summary publication", error),
			);
		}
		this.afterTerminal(job, epoch);
	}

	/**
	 * End the owning claim's run on a stale or failed outcome, with its real cause: `stale` is terminal; a failure
	 * goes through the scheduler's retry rule (a transient one keeps the job's kept reply for the retry) and is
	 * recorded once it is final. The caller checked ownership with no await since, and runs {@link afterTerminal}.
	 */
	private settleFailure(
		job: TranscriptSummaryJob,
		outcome: Extract<JobOutcome, { kind: "stale" | "fail" }>,
		now: number,
		returnClaim = false,
	): void {
		settleJobFailure(this.host, job, outcome, now, returnClaim);
	}

	/**
	 * Publish a built node for the claim that owns its job. Ownership is checked synchronously after every await and
	 * right before every mutation (no await between the check and the change): a claim that lost its job never
	 * publishes and never settles or records anything for the job's replacement. A publication that did land is
	 * mirrored regardless (C6); only the job's own settlement is the owner's.
	 */
	private async publishResult(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		node: TranscriptSummaryNode,
		epoch: number,
		paidCall: boolean,
	): Promise<void> {
		const { scheduler, writer } = this.run;
		if (!scheduler || !writer) return;
		const now = this.ports.now();
		// The summarized sources and their context must still be the live ones at the moment of publication, by one
		// read ({@link readLiveDependency}). The lineage they were verified against vouches for this leaf only; the
		// cursor records it only when the rest of the session was verified on that same lineage ({@link advanceCursor}).
		let live: Extract<TranscriptLineageSpansResult, { status: "ok" }> | undefined;
		if (job.kind === "leaf") {
			live = await this.readPublishedDependency(job, token, node, epoch, paidCall);
			if (!live) return;
		} else if (!job.children?.every((id) => this.catalog.has(id))) {
			this.settleFailure(job, { kind: "stale", reason: "a child node was revoked before publication" }, now);
			return;
		} else if (
			node.quality === "model_summary" &&
			!job.children.every((id) => this.catalog.isApproved(this.catalog.get(id)))
		) {
			this.settleFailure(
				job,
				{ kind: "stale", reason: "a child summary lost its admission before publication" },
				now,
			);
			return;
		}
		// The policy fence is read again after the asynchronous admission: if the evaluator can no longer be used (an
		// egress setting withdrawn, System One unbound), the admitted text is discarded, never published on a
		// judgment the owner has since stopped permitting. The call was made, so the attempt stays counted.
		if (node.quality === "model_summary" && this.modelWorkBlock() !== undefined)
			return this.settleAborted(token, epoch);
		if (needsReadmission(node)) {
			const reason = "the model summary carries no admission under the current contract; it is not published";
			const failed = scheduler.failJob(
				job.id,
				{ kind: "malformed", reason: "admission_missing", message: reason },
				now,
			);
			this.batch.recordFailure(job, "admission_missing", reason);
			if (failed) this.batch.countTerminal("failed", job, "admission_missing", reason);
			return;
		}
		if (this.forgottenSessions.has(job.sessionId)) {
			scheduler.markStale(job.id, now);
			this.batch.countTerminal("stale");
			return;
		}
		// A result that depends on a source past the retention window is never published, however late it arrives.
		// The job ends `failed` (not `stale`, which a rediscovery would replace and rebuild in a loop).
		if (this.catalog.isNodeExpired(node, this.retentionCutoff())) {
			const reason =
				"the summary depends on a source past the retention window (retentionDays); it is not published";
			const failed = scheduler.failJob(job.id, { kind: "policy", message: reason }, now);
			this.batch.recordFailure(job, "retention_expired", reason);
			if (failed) this.batch.countTerminal("failed", job, failed.lastError?.reason ?? "policy", reason);
			return;
		}

		let result: TranscriptSummaryPublishResult | undefined;
		let cursorUpdate: TranscriptSummarySessionCursor | undefined;
		let frontier: TranscriptFrontierResult | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			// A change the index learned since the dependency was read (across the reload below) is read again: the
			// publication stands on one current answer.
			if (live && this.ports.reader.observationCurrent(live.observation).status !== "current") {
				live = await this.readPublishedDependency(job, token, node, epoch, paidCall);
				if (!live) return;
			}
			try {
				cursorUpdate = live ? this.advanceCursor(node, live) : undefined;
				frontier = this.computeFrontier(node.sessionId, node);
			} catch (error) {
				return this.settlePublicationFailure(
					job,
					token,
					epoch,
					paidCall,
					this.thrownPublicationFailure("preparing the publication", error),
				);
			}
			// A claim that no longer owns its job never publishes (a reload below can end the job, too).
			if (!scheduler.ownsClaim(token)) return;
			try {
				result = await writer.publish({
					expectedRevision: this.manifestRevision,
					nodes: [node],
					...(cursorUpdate ? { sessions: { [node.sessionId]: cursorUpdate } } : {}),
					...(frontier.changed ? { frontiers: { [node.sessionId]: frontier.selection } } : {}),
				});
			} catch (error) {
				return this.settlePublicationFailure(
					job,
					token,
					epoch,
					paidCall,
					this.thrownPublicationFailure("publishing the summary node", error),
				);
			}
			if (result.status === "unavailable") {
				this.causes.noteInternal(result.reason);
				return this.settlePublicationFailure(job, token, epoch, paidCall, {
					kind: "transient",
					reason: "store_unavailable",
					message: result.reason,
				});
			}
			if (result.status !== "stale_revision") break;
			// A revision is never adopted without its mirror (C6): reload it, then compute the publication again.
			let reloaded: "reloaded" | "stopped" | TranscriptSummaryStoreUnavailable;
			try {
				reloaded = await this.reloadMirror(epoch);
			} catch (error) {
				return this.settlePublicationFailure(
					job,
					token,
					epoch,
					paidCall,
					this.thrownPublicationFailure("reloading the summary mirror", error),
				);
			}
			if (reloaded === "stopped") return this.settleAborted(token, epoch);
			// The store could not be read: the same cause as a write that failed, retried on the same backoff (the reload
			// recorded it), never an interrupt that is claimed again at once and spends the budget with no backoff.
			if (reloaded !== "reloaded") {
				return this.settlePublicationFailure(job, token, epoch, paidCall, {
					kind: "transient",
					reason: "store_unavailable",
					message: `reloading the summary mirror: ${reloaded.reason}`,
				});
			}
		}
		if (!result || !frontier) return;
		const owned = scheduler.ownsClaim(token);
		if (result.status === "published") {
			let frontierPublished = false;
			// Synchronous from here on, but an invariant that breaks (an index conflict, a coverage mismatch at
			// completion, a frontier listener) must not leave the claim running: it ends `internal_error` instead.
			try {
				this.manifestRevision = result.revision;
				// The store unparked a dormant identity in the same write.
				this.dormant.delete(node.id);
				this.catalog.index(node);
				// A parent held for an unapproved child may be able to run now (a rebuilt child keeps its identity, so the
				// scheduler would not admit the parent again). Released jobs re-check on claim and hold again if still blocked.
				this.holds.release("children");
				if (cursorUpdate) {
					this.cursors.set(node.sessionId, cursorUpdate);
					// Certified: the runtime vouched for the leaf's lineage ({@link advanceCursor}) and now names it, as the
					// cursor does; its stamp still names the same positions. Otherwise the rest of the session was not
					// verified on the lineage this leaf was: the runtime no longer vouches for the whole coverage, and its next
					// read verifies it.
					const runtime = this.sessions.get(node.sessionId);
					if (runtime && cursorUpdate.lineageDigest !== UNVERIFIED_LINEAGE_DIGEST)
						this.sessions.setDigest(runtime, cursorUpdate.lineageDigest);
					else if (runtime) {
						this.sessions.setDigest(runtime, undefined);
						this.sessions.setStamp(runtime, undefined);
					}
				}
				this.frontierBytes.set(node.sessionId, {
					bytes: frontier.bytes,
					...(frontier.gap ? { gap: frontier.gap } : {}),
				});
				if (frontier.changed) {
					this.frontiers.set(node.sessionId, frontier.selection);
					frontierPublished = true;
				}
				if (owned) {
					scheduler.completeJob(job.id, node, this.ports.now());
					this.batch.countTerminal("succeeded");
				}
				// The listener is told last, once the job settled: whatever it does, the job is already done.
				if (frontierPublished) {
					frontierPublished = false;
					this.ports.onFrontierChanged(node.sessionId, frontier.selection.revision);
				}
			} catch (error) {
				this.settlePublicationFailure(
					job,
					token,
					epoch,
					paidCall,
					this.thrownPublicationFailure("adopting the published summary node", error),
				);
				// The mirror already holds the new frontier (the publication is durable and indexed): its listener is told
				// even though the job's completion failed, so the exposed view never lags the accepted state.
				if (frontierPublished) this.ports.onFrontierChanged(node.sessionId, frontier.selection.revision);
			}
			return;
		}
		if (result.status === "fenced" || result.status === "manifest_corrupt") {
			this.fatal(`publication refused: ${result.status}`);
			return;
		}
		if (!owned) return;
		if (result.status === "revoked") {
			// Forgotten by retention: the identity is permanently refused, so the job ends `failed` and is not rebuilt.
			const reason = "the node was forgotten by retention; it is not republished";
			const failed = scheduler.failJob(job.id, { kind: "policy", message: reason }, this.ports.now());
			this.batch.recordFailure(job, "revoked", reason);
			if (failed) this.batch.countTerminal("failed", job, failed.lastError?.reason ?? "policy", reason);
			return;
		}
		const reason = result.status === "invalid" ? result.reason : `the revision moved twice (${result.status})`;
		const failed = scheduler.failJob(
			job.id,
			result.status === "invalid"
				? { kind: "malformed", message: reason }
				: { kind: "transient", reason: "store_revision_moved", message: reason },
			this.ports.now(),
			{ returnClaim: this.returnsClaim(job, paidCall) },
		);
		if (failed?.state === "failed") {
			this.batch.recordFailure(job, failed.lastError?.reason ?? "publish", reason);
			this.batch.countTerminal("failed", job, failed.lastError?.reason ?? "publish", reason);
		}
	}

	private settleAborted(token: TranscriptSummaryClaimToken, epoch: number): void {
		settleAbortedJob(this.host, token, epoch);
	}

	/**
	 * The failure a publication step that threw settles with, classified by the store ({@link storeUnavailable}) and
	 * recorded as the internal cause: an I/O or lock failure is `transient` (`store_unavailable`); anything else broke
	 * an invariant (a programming error) and is `internal` (`internal_error`), which is never retried.
	 */
	private thrownPublicationFailure(what: string, error: unknown): TranscriptSummaryFailure {
		return thrownPublicationFailureOf(this.host, what, error);
	}

	/**
	 * Settle a claim whose publication could not be completed, checked with no await since the step that failed: a run
	 * that is no longer live interrupts it as a stop does, a claim that lost its job settles nothing, and the owning
	 * claim ends this attempt through the scheduler's retry rule ({@link settleFailure}). A transient failure keeps the
	 * job's kept reply and kept acceptance for the retry, so neither paid call is made again; a reply whose own save was
	 * never acknowledged is not kept ({@link keepReply}), and that retry pays for it again. The caller returns to
	 * {@link settle}, which runs {@link afterTerminal}: the job list is saved and the batch can end.
	 *
	 * A write that landed before it threw (the manifest renamed, then a failure) is retried safely: the mirror kept its
	 * older revision, so a publication answers `stale_revision` and the mirror is reloaded with the node accepted, and
	 * publishing the same node with the same text again keeps its file and is accepted, never refused as a conflict.
	 */
	private settlePublicationFailure(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		epoch: number,
		paidCall: boolean,
		failure: TranscriptSummaryFailure,
	): void {
		settlePublicationFailureOf(this.host, job, token, epoch, paidCall, failure);
	}

	/**
	 * One read of a leaf's whole dependency, its context and covered spans as the catalog places them (the one
	 * validity rule), judged from that one observation ({@link DependencyVerdict}). A read the index did not answer
	 * is classified as for a build ({@link failureFor}): `pending` and `unavailable` are `unanswered`, any other refusal
	 * (the session is gone, a source expired) is an answer that the spans are not live.
	 */
	private readLiveDependency(node: TranscriptSummaryNode): Promise<DependencyVerdict> {
		return readLiveDependencyOf(this.host, node);
	}

	/**
	 * Whether a retryable failure gives its claim's attempt back: the claim made no paid call and only reused the job's
	 * kept paid reply, so the budget that bounds paid calls is not spent by republishing it. A claim with no kept reply
	 * (an exact copy builds locally) has no paid work to protect and keeps its counted attempt.
	 */
	private returnsClaim(job: TranscriptSummaryJob, paidCall: boolean): boolean {
		return returnsClaimOf(this.host, job, paidCall);
	}

	/**
	 * {@link readLiveDependency} for the claim publishing `node`: the covering read, or undefined when the publication
	 * must stop, already settled: an aborted run, a lost claim, the job ended `stale` because the index answered that
	 * its spans or their context are not live, or a transient failure because the index did not answer (the job
	 * retries with its kept reply).
	 */
	private readPublishedDependency(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		node: TranscriptSummaryNode,
		epoch: number,
		paidCall: boolean,
	): Promise<Extract<TranscriptLineageSpansResult, { status: "ok" }> | undefined> {
		return readPublishedDependencyOf(this.host, job, token, node, epoch, paidCall);
	}

	/**
	 * The cursor after accepting `leaf`, advanced across every contiguous accepted leaf. Its digest says that every
	 * accepted node of the session was verified live on that lineage, which a fresh runtime trusts without reading.
	 * `leafRead` is the read that verified the leaf's own dependency at publication; its digest (not the node's
	 * build-time field: a reused dormant node carries the one from when it was built) is recorded only when the rest
	 * of the session was verified on the same lineage, and never while a revocation is due: the runtime vouches for
	 * that read's lineage ({@link vouchesFor}: it is the verified digest, or the verified stamp is that read's, so the
	 * nodes verified then sit at the same positions of the leaf's lineage), else, with no runtime, the cursor's digest
	 * is that digest. Otherwise the cursor is marked {@link UNVERIFIED_LINEAGE_DIGEST}.
	 */
	private advanceCursor(
		leaf: TranscriptSummaryNode,
		leafRead: Extract<TranscriptLineageSpansResult, { status: "ok" }>,
	): TranscriptSummarySessionCursor {
		const current = this.cursors.get(leaf.sessionId);
		const runtime = this.sessions.get(leaf.sessionId);
		const leafDigest = leafRead.lineageDigest;
		const verifiedThere =
			!this.sessions.isDue(leaf.sessionId) &&
			(runtime ? vouchesFor(runtime, leafRead) : current?.lineageDigest === leafDigest);
		const lineageDigest = verifiedThere ? leafDigest : UNVERIFIED_LINEAGE_DIGEST;
		let covered = current?.coveredSpanCount ?? 0;
		let nextOrdinal = current?.nextOrdinal ?? 0;
		for (;;) {
			const candidate = leaf.spanRange.fromIndex === covered ? leaf : this.catalog.leafAt(leaf.sessionId, covered);
			if (!candidate) break;
			covered = candidate.spanRange.toIndexExclusive;
			nextOrdinal = candidate.ordinal + 1;
		}
		return { lineageDigest, coveredSpanCount: covered, nextOrdinal };
	}

	/** After any terminal transition: resume deferred enumeration, save jobs, close the batch, arm the timer. */
	private afterTerminal(job: TranscriptSummaryJob, epoch: number): void {
		afterTerminalOf(this.host, job, epoch);
	}

	/** A finished job frees room: enumeration that stopped at the active-job ceiling resumes. */
	private resumeDeferredEnumeration(sessionId: string, epoch: number): void {
		if (!this.sessions.get(sessionId)?.backpressured) return;
		void this.enqueue(async () => {
			if (!this.live(epoch)) return;
			// Through the one wrapper: an enumeration page that does not answer is projected onto the session's
			// held leaves like any other read.
			if (this.sessions.has(sessionId)) await this.reconcileSession(sessionId, epoch);
			this.pump(epoch);
		});
	}

	// ---- jobs persistence ---------------------------------------------------------------------

	/**
	 * Save the job list on the mailbox. Every outcome is handled here, inside the persistence owner: a thrown save,
	 * an overflow or any other refusal is recorded with its real cause and retried on a bounded backoff, so the
	 * mailbox's generic catch can never turn a failed save into a met barrier. Only a `saved` outcome of this run
	 * acknowledges attempts ({@link durableAttempts}), opens admission and releases persistence holds; a superseded
	 * writer or a corrupt manifest stops the coordinator.
	 */
	private markJobsDirty(): void {
		if (this.jobsDirty) return;
		this.jobsDirty = true;
		const epoch = this.run.epoch;
		this.jobsSaved = this.enqueue(async () => {
			this.jobsDirty = false;
			const { scheduler, writer } = this.run;
			if (!scheduler || !writer) return;
			// The acknowledgement covers exactly this snapshot: a claim made after it waits for the next save.
			const snapshot = scheduler.snapshot();
			// Receipts an ended job handed out of its record are owned by the queue read in the same turn as the snapshot. They are
			// made durable BEFORE the jobs that no longer carry them: a stop between the two writes finds the receipt in both
			// places (recording is idempotent by receipt id), never in neither. A refused or failed receipt save acknowledges nothing.
			let saved: TranscriptSummaryJobsSaveResult | undefined;
			try {
				saved = await this.saveJobsInOrder(scheduler, writer, epoch, snapshot);
			} catch (error) {
				this.jobSaveFailed(`saving jobs failed: ${error instanceof Error ? error.message : String(error)}`, epoch);
				return;
			}
			if (saved === undefined) return;
			if (saved.status === "saved") {
				scheduler.rekeysSaved(saved.rekeyed);
				const freed = saved.released.length > 0 || saved.ledger.recorded < this.proofLedger.recorded;
				scheduler.noteProof(saved.proof, saved.released);
				scheduler.setProofHold(saved.ledger.hold);
				// Only what the store pruned leaves memory: a failed job it kept for lack of a proof record stays.
				scheduler.forgetTerminal(saved.pruned);
				this.proofLedger = saved.ledger;
				// A forget whose last reservation this save released may now be recordable as applied: the save is the event
				// that frees it, so the check follows it (no timer, no polling; it writes nothing while session data remains).
				if (this.live(epoch) && this.forgetRevision > this.forgetAppliedRevision) {
					void this.enqueue(async () => this.recordForgetApplied(epoch));
				}
				// A refused job needs nothing here: its pre-call check finds no record and holds it before any call.
				if (freed && this.live(this.run.epoch)) this.releaseProofHolds(this.run.epoch);
				if (this.live(epoch)) this.acknowledgeSave(snapshot, scheduler, epoch);
			} else if (saved.status === "fenced" || saved.status === "manifest_corrupt") {
				this.fatal(`saving jobs was refused: ${describeSaveRefusal(saved)}`);
			} else if (saved.status === "unavailable") this.jobSaveFailed(saved.reason, epoch);
			else this.jobSaveFailed(`saving jobs was refused: ${describeSaveRefusal(saved)}`, epoch);
		});
	}

	/**
	 * The one persistence order for the job list, used by every save (ordinary and at stop): the owed-receipt queue first,
	 * then the jobs that no longer carry those receipts. Returns undefined when the queue is not durable, in which case the
	 * jobs are not written and the older job record stays the receipt's durable copy.
	 */
	private async saveJobsInOrder(
		scheduler: TranscriptSummaryScheduler,
		writer: TranscriptSummaryWriter,
		epoch: number,
		snapshot: readonly TranscriptSummaryJob[],
	): Promise<TranscriptSummaryJobsSaveResult | undefined> {
		if (!(await this.saveOwedReceipts(scheduler, writer, epoch))) return undefined;
		return writer.saveJobs(snapshot, { rekeys: scheduler.rekeysToSave() });
	}

	/**
	 * Persist the queue of receipts owed by ended jobs when it changed since the last durable copy. Returns whether the
	 * queue is durable as of now; a refusal or a thrown write records its real cause, schedules the bounded retry and
	 * returns false so the caller acknowledges nothing and releases no hold.
	 */
	private async saveOwedReceipts(
		scheduler: TranscriptSummaryScheduler,
		writer: TranscriptSummaryWriter,
		epoch: number,
	): Promise<boolean> {
		const state = scheduler.releasedReceiptsState();
		if (state.version === this.owedReceiptsSavedVersion) return true;
		try {
			const saved = await writer.saveOwedReceipts(state.entries);
			// Durable is durable, also when this run has stopped meanwhile: the stop's own save relies on it.
			if (saved.status === "saved") {
				this.owedReceiptsSavedVersion = state.version;
				this.owedSavedKeys = new Set(state.entries.map(owedKey));
				return true;
			}
			// The real cause is kept whether or not this run is still live (a stop reports through it).
			this.causes.noteInternal(
				`saving the owed usage receipts: ${saved.status === "unavailable" ? saved.reason : saved.status}`,
			);
			if (!this.live(epoch)) return false;
			if (saved.status === "fenced" || saved.status === "manifest_corrupt") {
				this.fatal(`saving the owed usage receipts was refused: ${saved.status}`);
				return false;
			}
			this.jobSaveFailed(
				`saving the owed usage receipts: ${saved.status === "unavailable" ? saved.reason : `${saved.status} (bound ${saved.bound})`}`,
				epoch,
			);
			return false;
		} catch (error) {
			this.jobSaveFailed(
				`saving the owed usage receipts failed: ${error instanceof Error ? error.message : String(error)}`,
				epoch,
			);
			return false;
		}
	}

	/**
	 * A save of this run succeeded: the attempts in its snapshot are durable (an overwrite, so an attempt a later
	 * save returned is no longer covered), the first one opens admission and starts discovery, and jobs held for
	 * persistence may be claimed again.
	 */
	private acknowledgeSave(
		snapshot: readonly TranscriptSummaryJob[],
		scheduler: TranscriptSummaryScheduler,
		epoch: number,
	): void {
		this.durableAttempts.clear();
		this.durableReplies.clear();
		for (const job of snapshot) {
			if (isTerminalSummaryJobState(job.state)) continue;
			this.durableAttempts.set(job.id, job.attempts);
			if (job.pendingReply) this.durableReplies.set(job.id, job.pendingReply.textDigest);
		}
		this.saveFailure = undefined;
		this.saveBackoff.reset();
		if (this.run.phase === "convert") {
			// Version 1 budgets are durable carried records now: recovered parents adopt theirs and recovered leaves are
			// held until enumeration adopts theirs, before anything runs.
			this.run.setPhase("reconcile");
			void this.enqueue(async () => {
				this.reconcileRecovered(epoch);
			});
		} else if (this.run.phase === "reconciled") {
			this.run.setPhase("open");
			if (scheduler.openAdmission(this.ports.now()).length > 0) this.batch.noteEnqueued();
			if (this.run.takeHeldDiscovery()) {
				void this.enqueue(async () => {
					if (this.live(epoch)) await this.discover(epoch);
				});
			}
		}
		this.holds.release("persistence");
		this.pump(epoch);
	}

	/**
	 * A store write of a mailbox task could not be served (the store's typed `unavailable`): record the real cause and
	 * keep the work it left undone for {@link retryStoreWork}, on a backoff of 1 s doubling to one minute while writes
	 * keep failing. The task goes on with what does not depend on the write, so one outage never loses discovery,
	 * reconciliation or a frontier for the rest of the run.
	 */
	private deferStoreWork(
		cause: string,
		work: {
			discover?: boolean;
			retention?: boolean;
			anchors?: boolean;
			sessions?: Iterable<string>;
			frontiers?: Iterable<string>;
			forgets?: Iterable<string>;
		},
		epoch: number,
	): void {
		this.causes.noteInternal(cause);
		if (!this.live(epoch)) return;
		this.storeRetry.defer(work);
		this.armTimer(epoch);
	}

	/**
	 * Run the store work deferred by unavailable writes, once its backoff is due (on the mailbox, from the lifecycle
	 * timer). What fails again is deferred again with a longer backoff; a pass that defers nothing resets it.
	 */
	private async retryStoreWork(epoch: number): Promise<void> {
		const work = this.storeRetry.take();
		const failures = this.storeRetry.failures;
		const remaining = {
			...work,
			sessions: new Set(work.sessions),
			frontiers: new Set(work.frontiers),
			forgets: new Set(work.forgets),
		};
		try {
			if (work.discover) {
				await this.discover(epoch);
				remaining.discover = false;
			} else {
				if (work.anchors && this.sessions.undatedPending) await this.anchorUndatedNodes(epoch);
				remaining.anchors = false;
				if (work.retention) await this.applyRetention(epoch);
				remaining.retention = false;
			}
			for (const sessionId of work.sessions) {
				if (!this.live(epoch)) return;
				await this.reconcileSession(sessionId, epoch);
				remaining.sessions.delete(sessionId);
			}
			if (work.frontiers.size > 0) await this.republishFrontiers([...work.frontiers], epoch);
			remaining.frontiers.clear();
			for (const sessionId of work.forgets) {
				if (!this.live(epoch)) return;
				const pending = await this.applyForgottenSession(sessionId, epoch);
				if (pending === undefined) remaining.forgets.delete(sessionId);
			}
		} catch (error) {
			// A thrown error is not an unavailable write: the stage that threw and the stages after it stay deferred for
			// the next round, and the mailbox records the real cause.
			this.deferStoreWork(error instanceof Error ? error.message : String(error), remaining, epoch);
			throw error;
		}
		if (this.storeRetry.failures === failures) this.storeRetry.clearFailures();
	}

	/** A job save of this run failed: record the real cause and try again on the bounded backoff. */
	private jobSaveFailed(cause: string, epoch: number): void {
		this.causes.noteInternal(cause);
		if (!this.live(epoch)) return;
		this.saveFailure = cause;
		this.saveBackoff.fail();
		this.armTimer(epoch);
	}

	// ---- re-admission -------------------------------------------------------------------------
	//
	// A model summary accepted before the admission contract (or under an older one) is not approved. It is
	// judged again from its own text against its freshly re-read, digest-verified sources: no summarizer call,
	// no change of identity or coverage. Admitted: the record is added to the node. Rejected: the node is derived
	// data that a judge found unsupported, so it is revoked and rebuilt through the normal pipeline. Uncertain: the
	// same, since the verdict is on this exact text. Unavailable or waiting on a child: it stays
	// accepted-but-unapproved, with the cause in the diagnostics.

	/**
	 * Each unapproved model summary is a scheduler job: its attempts, retry waits, reservation and kept paid verdict are
	 * the scheduler's and the store's, so re-admission is bounded, durable across a restart and counted like every other
	 * paid work. The job identity binds the node, the contract, the recipe and the exact text.
	 */
	private enqueueReadmissions(): void {
		enqueueReadmissionJobs(this.host);
	}

	/**
	 * Apply a re-admission judgment (behind the source and policy fences, in {@link applyReadmission}) and settle its
	 * job from what that left: approved, revoked as rejected or uncertain (the job is done), or waiting. A judgment that
	 * is valid but could not be applied (a source that did not answer, a store write that failed) stays kept on the job,
	 * so its retry applies it again and never buys it again.
	 */
	private async settleReadmitted(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		outcome: Extract<JobOutcome, { kind: "readmitted" }>,
		epoch: number,
	): Promise<void> {
		const scheduler = this.run.scheduler;
		if (!scheduler) return;
		const { node, result, reused, inputDigest } = outcome;
		// A kept verdict applied again is a reuse event, never a new judgment; a fresh one is counted once. Only an acceptance
		// is reused as one (status.reused): a kept rejection or outage is replayed without a judgment and counts nowhere.
		this.batch.countJudgment(result.disposition, reused);
		this.holds.beginSettling(job.id);
		try {
			await this.applyReadmission(node, result, epoch);
		} finally {
			this.holds.endSettling(job.id);
		}
		if (!this.live(epoch) || !scheduler.ownsClaim(token)) return;
		const now = this.ports.now();
		const state = this.holds.readmission.get(node.id);
		if (state?.state === "admitted" || state?.state === "rejected" || state?.state === "uncertain") {
			scheduler.completeReadmission(job.id, now, { reused });
			return;
		}
		const keepJudgment = () => {
			if (result.disposition === "unavailable") return;
			scheduler.setPendingVerdict(
				job.id,
				verdictOf(result, result.receipts, token.attempt, this.ports.ownerSessionId(), {
					inputDigest,
					textDigest: summaryTextDigest(node.text),
					contractVersion: TRANSCRIPT_SUMMARY_ADMISSION_CONTRACT_VERSION,
				}),
			);
		};
		if (state?.state === "unavailable" && result.disposition === "unavailable") {
			if (result.cause === "not_bound" || result.cause === "not_calibrated") {
				scheduler.abandonClaim(token, { message: result.reason, reason: result.cause }, now);
				this.holds.park(job.id, { scope: "model_work", reason: result.reason });
			} else if (result.cause === "evaluator_error") {
				// A replayed outage made no paid call, so its claim's attempt is returned; a fresh one keeps it (its call was paid).
				this.settleFailure(
					job,
					{
						kind: "fail",
						failure: { kind: "transient", reason: "admission_unavailable", message: result.reason },
					},
					now,
					reused,
				);
			} else {
				this.settleFailure(
					job,
					{
						kind: "fail",
						failure: {
							kind: result.cause === "invalid_output" ? "malformed" : "policy",
							reason: `admission_${result.cause}`,
							message: result.reason,
						},
					},
					now,
				);
			}
			this.markJobsDirty();
			return;
		}
		const wait = state?.wait;
		if (state?.state === "waiting" && wait === "child_not_approved") {
			// A judgment that was paid for survives the wait: it is kept and the attempt stays counted; only a claim that made
			// no call returns its attempt.
			if (result.disposition !== "unavailable") {
				keepJudgment();
				if (reused)
					scheduler.abandonClaim(token, { message: "a child summary is not approved yet", reason: wait }, now);
				else scheduler.interrupt(job.id, now);
			} else scheduler.abandonClaim(token, { message: "a child summary is not approved yet", reason: wait }, now);
			this.holds.park(job.id, { scope: "children", reason: "a child summary is not approved yet" });
		} else if (state?.state === "waiting" && (wait === "source_unreadable" || wait === "store_unavailable")) {
			keepJudgment();
			this.settleFailure(
				job,
				{
					kind: "fail",
					failure: {
						kind: "transient",
						reason: wait === "store_unavailable" ? "store_unavailable" : "source_not_ready",
						message: `the judgment waits: ${wait}`,
					},
				},
				now,
				reused,
			);
		} else if (state?.state === "waiting" && wait === "judgment_discarded" && this.modelWorkBlock() !== undefined) {
			keepJudgment();
			scheduler.interrupt(job.id, now);
			this.holds.park(job.id, { scope: "model_work", reason: "the judgment waits for the policy fence" });
		} else if (state === undefined) {
			// The apply ended without a state (a run that is ending): the judgment stays for the next claim.
			keepJudgment();
			scheduler.interrupt(job.id, now);
		} else {
			// The source changed, was refused for good, or the judgment cannot be used: the identity is spent. It ends as a
			// failed job (remembered with its budget), not a stale one that the next pump would recreate and pay again.
			this.settleFailure(
				job,
				{
					kind: "fail",
					failure: {
						kind: "policy",
						reason: `readmission_${wait ?? state.state}`,
						message: `the re-admission judgment was not applied: ${wait ?? state.state}`,
					},
				},
				now,
			);
		}
		this.markJobsDirty();
	}

	/**
	 * Why a re-admission source read that returned no text, or a lineage read that answered the sources are not
	 * covered (passed as `stale` with that answer's reason), waits: the one place every re-admission source wait is
	 * decided, classified as for a build ({@link failureFor} and {@link readText}), with its cause recorded. Only a
	 * transient failure (the index did not answer: nothing is known yet) is `source_unreadable`, read again after the
	 * backoff. Anything else is an answer, not retried on the backoff: a source that changed, is gone or is no longer
	 * covered (`stale`) is `source_coverage_changed`, a part the read refuses for good (beyond the read bound) is
	 * `source_read_refused`.
	 */
	private readmissionSourceWait(node: TranscriptSummaryNode, outcome: SourceReadFailure): TranscriptReadmissionWait {
		return readmissionSourceWaitOf(this.host, node, outcome);
	}

	/**
	 * Record why `node` waits and return that wait: the one writer of a re-admission cause, for the source waits
	 * ({@link readmissionSourceWait}) and for a judgment a live fence discarded (`judgment_discarded`).
	 */
	private readmissionWait(
		node: TranscriptSummaryNode,
		wait: TranscriptReadmissionWait,
		cause: string,
	): TranscriptReadmissionWait {
		return readmissionWaitOf(this.host, node, wait, cause);
	}

	/**
	 * A re-admission's store write did not record its verdict. When the store could not serve it (`transient`), the node
	 * waits `store_unavailable` and the verdict is kept with the text it judged: after the re-admission backoff it is
	 * applied again, never asked of the evaluator again. Any other failure broke an invariant: the judgment is discarded
	 * with its cause and not tried again this run. A run that ended, or a node the mirror replaced meanwhile, only
	 * records the cause.
	 */
	private readmissionWriteFailed(node: TranscriptSummaryNode, epoch: number, cause: string, transient: boolean): void {
		readmissionWriteFailure(this.host, node, epoch, cause, transient);
	}

	/**
	 * Apply a re-admission judgment on the mailbox, behind the same fences as a publication.
	 */
	private async applyReadmission(
		node: TranscriptSummaryNode,
		result: TranscriptSummaryAdmissionResult,
		epoch: number,
	): Promise<void> {
		const { writer } = this.run;
		// The outcome this judgment records is its own: a hold an earlier attempt left on the node is never read as its result.
		this.holds.clearReadmission(node.id);
		if (!writer || !this.live(epoch) || this.catalog.get(node.id) !== node) return;
		// Source and policy fences, read again after the asynchronous judgment.
		const block = this.modelWorkBlock();
		if (block !== undefined) {
			this.holds.setReadmission(
				node.id,
				"waiting",
				this.readmissionWait(node, "judgment_discarded", `judgment discarded by the policy fence: ${block.reason}`),
			);
			return;
		}
		if (node.children) {
			if (node.children.some((id) => !this.catalog.isApproved(this.catalog.get(id)))) {
				this.holds.setReadmission(node.id, "waiting", "child_not_approved");
				return;
			}
		} else {
			const verdict = await this.readLiveDependency(node);
			if (!this.live(epoch) || this.catalog.get(node.id) !== node) return;
			if (verdict.kind === "unanswered") {
				// Nothing is known about the sources: the judgment is not recorded, and the node is judged again later. The
				// verdict itself was paid for and says nothing about the read, so it is kept with the text it judged and applied
				// again after the backoff (behind these same fences), never asked of the evaluator again.
				this.holds.setReadmission(node.id, "waiting", this.readmissionSourceWait(node, verdict.outcome));
				return;
			}
			if (verdict.kind === "not_covered") {
				this.holds.setReadmission(
					node.id,
					"waiting",
					this.readmissionSourceWait(node, { kind: "stale", reason: verdict.reason }),
				);
				return;
			}
		}
		const subject = { id: `readmit:${node.id.slice(0, 16)}`, level: node.level, sessionId: node.sessionId };
		if (result.disposition === "accepted") {
			const admission = admissionRecordFromResult(result, node.text, new Date(this.ports.now()).toISOString());
			if (!admission) {
				this.holds.setReadmission(
					node.id,
					"waiting",
					this.readmissionWait(node, "judgment_discarded", "an accepted re-admission produced no record"),
				);
				return;
			}
			let annotated: TranscriptSummaryAnnotateResult;
			try {
				annotated = await writer.annotateAdmission(node.id, admission);
			} catch (error) {
				return this.readmissionWriteFailed(
					node,
					epoch,
					`recording an admission failed: ${error instanceof Error ? error.message : String(error)}`,
					false,
				);
			}
			if (annotated.status === "unavailable")
				return this.readmissionWriteFailed(node, epoch, annotated.reason, true);
			// Durable already: the mirror takes it with its revision whether or not this run continues (C6).
			if (annotated.status === "annotated") {
				this.manifestRevision = annotated.revision;
				this.catalog.index(annotated.node);
			}
			if (!this.live(epoch)) return;
			if (annotated.status === "fenced" || annotated.status === "manifest_corrupt") {
				this.fatal(`recording an admission was refused: ${annotated.status}`);
				return;
			}
			if (annotated.status !== "annotated") {
				this.holds.setReadmission(node.id, "waiting", "store_refused");
				this.batch.recordFailure(
					subject,
					"readmission_refused",
					`the store refused the admission: ${annotated.status}`,
				);
				return;
			}
			this.holds.setReadmission(node.id, "admitted");
			this.batch.countTerminal("succeeded");
			// Approval changed: parents that waited on this child may be judged, parked parent jobs may run, and the
			// frontier may now include the summary.
			this.holds.clearWaiting();
			this.holds.release("children");
			await this.republishFrontiers([node.sessionId], epoch);
			return;
		}
		const detail = describeAdmission(result);
		if (result.disposition === "rejected" || result.disposition === "uncertain") {
			// Both are verdicts on this exact text, as for a job: the node is derived data that no judge could stand
			// behind, so it is revoked and derived again through the normal pipeline, where the new summary is judged
			// once and a second failure ends that job with its spent budget on record. Re-judging the same text on every
			// start would only pay the evaluator again for the same answer.
			const reason = result.disposition === "rejected" ? "admission_rejected" : "admission_uncertain";
			this.holds.setReadmission(node.id, result.disposition);
			this.batch.recordFailure(subject, reason, detail);
			let revoked: TranscriptSummaryRevokeResult;
			try {
				revoked = await writer.revokeNodes((id) => id === node.id, "recovery");
			} catch (error) {
				return this.readmissionWriteFailed(
					node,
					epoch,
					`revoking a ${result.disposition} summary failed: ${error instanceof Error ? error.message : String(error)}`,
					false,
				);
			}
			if (revoked.status === "unavailable") return this.readmissionWriteFailed(node, epoch, revoked.reason, true);
			// Counted once, here: the verdict is final for this text once its revocation is durable. An outage, a refused or a
			// failed store write is counted when its job ends, and a replay of the same verdict is not counted again.
			if (revoked.status === "published") this.batch.countTerminal("failed", subject, reason, detail);
			if (!this.live(epoch)) {
				// Durable already: the mirror takes it with its revision even though this run will not continue (C6).
				if (revoked.status === "published") this.mirrorRevocation(revoked, reason, undefined, 0);
				return;
			}
			if (revoked.status !== "published") {
				this.fatal(`revoking a ${result.disposition} summary was refused: ${revoked.status}`);
				return;
			}
			await this.applyRevocation(revoked, epoch, { reason });
			return;
		}
		this.holds.setReadmission(node.id, "unavailable");
		this.batch.recordFailure(subject, "admission_unavailable", detail);
	}

	// ---- batch accounting ---------------------------------------------------------------------

	private maybeFinishBatch(): void {
		const counts = this.run.scheduler?.counts();
		if (!counts || !this.batch.isOpen()) return;
		// Held jobs wait for a condition outside the batch; they do not keep it open, and its handoff names them.
		this.holds.prune((id) => this.run.scheduler?.get(id)?.state);
		if (counts.queued - this.holds.parked.size + counts.running + counts.retry_wait > 0) return;
		this.finishBatch("completed", 0);
	}

	private finishBatch(outcome: "completed" | "stopped", interrupted: number, stopReason?: string): void {
		const event = this.batch.close(outcome, interrupted, stopReason, () => this.terminalHolds());
		if (!event) return;
		const writer = this.run.writer;
		const handoff = async (): Promise<void> => {
			// The record is persisted under the writer fence first; the owner is told either way, with the
			// persistence failure stated in the diagnostics rather than hidden.
			try {
				if (writer && !(await writer.recordTerminal(event))) {
					this.causes.noteInternal("terminal handoff was not persisted: the writer was superseded");
				}
			} catch (error) {
				this.causes.noteInternal(
					`terminal handoff was not persisted: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			this.ports.onTerminal(event);
		};
		if (outcome === "stopped") this.stopHandoff = handoff();
		else void this.enqueue(handoff);
	}

	/** The hold summary a closing batch's terminal event carries: read at the close, from the parked holds only. */
	private terminalHolds(): TerminalHolds | undefined {
		const held = this.holds.first();
		if (!held) return undefined;
		return {
			held: this.holds.parked.size,
			heldKind: held.scope,
			heldReason: bounded(held.reason, MAX_HELD_REASON_CHARS),
			heldByKind: this.holds.counts(),
		};
	}
}
