/**
 * The seam the moved coordinator bodies read through: one typed view of the coordinator's members. The run, the batch,
 * the causes, the holds and the session runtimes are reached through their owner objects (`run`, `batch`, `causes`,
 * `holds`, `sessions`), and those objects' commands are the only writers of that state. The mirror is not owned yet:
 * `cursors`, `dormant`, `frontiers`, `frontierBytes` and `forgottenSessions` are written directly by the moved
 * modules that own those effects, and `catalog` is a shared object mutated through its methods, until the mirror object
 * lands. `inFlight` and the other members are readonly references or calls, each made where the body used to reach it.
 */

import type { BatchAccount, CauseSlots } from "./transcript-batch-account.ts";
import type { TranscriptFrontierGap, TranscriptFrontierSelection } from "./transcript-frontier.ts";
import type { HoldLedger } from "./transcript-hold-ledger.ts";
import type {
	DependencyVerdict,
	JobOutcome,
	PublishedRevocation,
	SourceReadFailure,
} from "./transcript-job-outcome.ts";
import type {
	TranscriptCoverage,
	TranscriptIndexObservation,
	TranscriptReadUnavailable,
	TranscriptSourceRef,
	TranscriptSourceSpan,
} from "./transcript-memory-contracts.ts";
import type { TranscriptMemoryPorts, TranscriptSummarizerPort } from "./transcript-memory-ports.ts";
import type {
	TranscriptMemoryAdmissionStatus,
	TranscriptMemoryModelWorkBlock,
	TranscriptMemoryRevocationRecord,
	TranscriptReadmissionWait,
} from "./transcript-memory-status.ts";
import type { TranscriptRunState } from "./transcript-run-lifecycle.ts";
import type {
	CoverageVerdict,
	SessionRuntime,
	SessionRuntimes,
	VerifiedLineage,
} from "./transcript-session-runtime.ts";
import type {
	TranscriptSummaryAdmissionPort,
	TranscriptSummaryAdmissionRecord,
	TranscriptSummaryAdmissionRequest,
	TranscriptSummaryAdmissionResult,
} from "./transcript-summary-admission.ts";
import type {
	TranscriptSummaryCatalog,
	TranscriptSummaryReadContext,
	TranscriptSummaryReadFence,
} from "./transcript-summary-catalog.ts";
import type { TranscriptCaptureText, TranscriptSummaryNode } from "./transcript-summary-node.ts";
import type { SummaryRequest } from "./transcript-summary-prompt.ts";
import type { TranscriptSummaryClaimToken, TranscriptSummaryJob } from "./transcript-summary-scheduler.ts";
import type {
	TranscriptSummaryProofStatus,
	TranscriptSummarySessionCursor,
	TranscriptSummaryStoreUnavailable,
} from "./transcript-summary-store.ts";

export interface CoordinatorHost {
	abortDeniedInputs(): void;
	abortSession(sessionId: string): void;
	readonly batch: BatchAccount;
	readonly causes: CauseSlots;
	readonly holds: HoldLedger;
	admissionStatus(): TranscriptMemoryAdmissionStatus;
	afterRevocation(
		revoked: readonly string[],
		revision: number,
		droppedCursors: readonly string[],
		reason: TranscriptMemoryRevocationRecord["reason"],
		alreadyDroppedReady: number,
	): void;
	anchorRefs(
		sources: readonly { ref: TranscriptSourceRef; legacyHandle?: string }[],
		epoch: number,
	): Promise<boolean | TranscriptSummaryStoreUnavailable>;
	applyRetention(epoch: number): Promise<void>;
	applyRevocation(
		result: PublishedRevocation,
		epoch: number,
		options: {
			reason: TranscriptMemoryRevocationRecord["reason"];
			dropSession?: string;
			rereadSession?: { sessionId: string; verified: VerifiedLineage | undefined };
			droppedReady?: number;
		},
	): Promise<void>;
	buildLeaf(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		summarizer: TranscriptSummarizerPort,
		signal: AbortSignal,
	): Promise<JobOutcome>;
	buildParent(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		summarizer: TranscriptSummarizerPort,
		signal: AbortSignal,
	): Promise<JobOutcome>;
	readonly catalog: TranscriptSummaryCatalog;
	certifyCursor(sessionId: string, runtime: SessionRuntime, epoch: number): Promise<void>;
	readonly cursors: Map<string, TranscriptSummarySessionCursor>;
	deferStoreWork(
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
	): void;
	readonly dormant: Map<string, TranscriptSummaryNode>;
	dormantRetentionTime(node: TranscriptSummaryNode): number | undefined;
	dropFrontiers(names: readonly string[]): void;
	dropOrphanedSessionRecords(indexed: ReadonlySet<string>, coverage: TranscriptCoverage): Promise<boolean>;
	dropSessionRecords(sessionIds: ReadonlySet<string>): Promise<boolean | TranscriptSummaryStoreUnavailable>;
	egressBlocked(summarizer: TranscriptSummarizerPort): string | undefined;
	enqueue(task: () => Promise<void>): Promise<void>;
	enumerateLeaves(
		sessionId: string,
		runtime: SessionRuntime,
		epoch: number,
		stamp: string | undefined,
	): Promise<string | undefined>;
	failureFor(unavailable: TranscriptReadUnavailable): SourceReadFailure;
	fatal(reason: string): void;
	forgetDenial(sessionId: string, epoch: number): Promise<JobOutcome | undefined>;
	readonly forgetRevision: number;
	readonly forgottenSessions: Set<string>;
	readonly frontierBytes: Map<string, { bytes: number; gap?: TranscriptFrontierGap }>;
	frontierExpired(lineageKey: string): boolean;
	frontierNotAdmitted(lineageKey: string): boolean;
	readonly frontierRead:
		| {
				fence: TranscriptSummaryReadFence;
				observation?: TranscriptIndexObservation;
				context: TranscriptSummaryReadContext;
				selection: TranscriptFrontierSelection;
		  }
		| undefined;
	readonly frontiers: Map<string, TranscriptFrontierSelection>;
	readonly inFlight: Map<number, { jobId: string; controller: AbortController; done: Promise<void> }>;
	invalidateSession(sessionId: string, epoch: number): Promise<void>;
	isExpired(spans: readonly TranscriptSourceSpan[], cutoff: number | undefined): boolean;
	isOutsideRetention(span: TranscriptSourceSpan): boolean;
	judge(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		port: TranscriptSummaryAdmissionPort,
		request: TranscriptSummaryAdmissionRequest,
		inputDigest: string,
		signal: AbortSignal,
	): Promise<{ result: TranscriptSummaryAdmissionResult; reused: boolean } | { outcome: JobOutcome }>;
	readonly lastRevocation: TranscriptMemoryRevocationRecord | undefined;
	lineageMoved(sessionId: string, during: string): string;
	live(epoch: number): boolean;
	makeNode(
		fields: Omit<
			TranscriptSummaryNode,
			| "schemaVersion"
			| "recipeVersion"
			| "bytes"
			| "createdAt"
			| "coveredFrom"
			| "coveredTo"
			| "oldestDependencyAt"
			| "captureVersion"
			| "legacyIdentity"
		> & {
			coveredFrom: string | undefined;
			coveredTo: string | undefined;
			oldestDependencyAt:
				| string
				| undefined /** Every construction site states it; see {@link TranscriptSummaryNode.legacyIdentity}. */;
			legacyIdentity: string | undefined;
		},
	): TranscriptSummaryNode;
	markJobsDirty(): void;
	maybeFinishBatch(): void;
	mirrorRevocation(
		result: PublishedRevocation,
		reason: TranscriptMemoryRevocationRecord["reason"],
		dropSession: string | undefined,
		droppedReady: number,
	): void;
	modelWorkBlock(): TranscriptMemoryModelWorkBlock | undefined;
	nextRetentionAt(): number | undefined;
	nodeDenied(node: TranscriptSummaryNode, seen?: Set<string>): boolean;
	readonly ports: TranscriptMemoryPorts;
	readonly proofLedger: TranscriptSummaryProofStatus;
	pump(epoch: number): void;
	queueForgetRefresh(epoch: number): void;
	readContext(
		job: TranscriptSummaryJob,
		signal: AbortSignal,
		stamp: string | undefined,
	): Promise<{ items: TranscriptCaptureText[] } | { outcome: JobOutcome }>;
	readLiveDependency(node: TranscriptSummaryNode): Promise<DependencyVerdict>;
	readmissionCandidates(): TranscriptSummaryNode[];
	readmissionFailed(node: TranscriptSummaryNode): boolean;
	readmissionRequest(
		node: TranscriptSummaryNode,
		signal: AbortSignal,
	): Promise<{ request: TranscriptSummaryAdmissionRequest } | { wait: TranscriptReadmissionWait } | undefined>;
	readmissionSourceWait(node: TranscriptSummaryNode, outcome: SourceReadFailure): TranscriptReadmissionWait;
	readmissionWait(
		node: TranscriptSummaryNode,
		wait: TranscriptReadmissionWait,
		cause: string,
	): TranscriptReadmissionWait;
	readmitNode(job: TranscriptSummaryJob, token: TranscriptSummaryClaimToken, signal: AbortSignal): Promise<JobOutcome>;
	readText(span: TranscriptSourceSpan): Promise<{ text: string } | { outcome: SourceReadFailure }>;
	reconcileHeldSessions(visited: ReadonlySet<string>, epoch: number): Promise<void>;
	reconcileSession(sessionId: string, epoch: number): Promise<void>;
	reconcileSessionRead(sessionId: string, epoch: number): Promise<string | undefined>;
	republishFrontiers(sessionIds: readonly string[], epoch: number): Promise<void>;
	restartDiscovery(sessionId: string, runtime: SessionRuntime, verified: VerifiedLineage | undefined): void;
	resumeDeferredEnumeration(sessionId: string, epoch: number): void;
	retentionCutoff(): number | undefined;
	returnsClaim(job: TranscriptSummaryJob, paidCall: boolean): boolean;
	reusableDormant(id: string, job: TranscriptSummaryJob): TranscriptSummaryNode | undefined;
	revokeDeadCoverage(sessionId: string, epoch: number, stamp: string | undefined): Promise<CoverageVerdict>;
	readonly sessions: SessionRuntimes;
	readonly run: TranscriptRunState;
	sessionsOf(nodeIds: readonly string[]): Set<string>;
	sessionTimestamp(sessionId: string): Promise<string | null | undefined>;
	settleAborted(token: TranscriptSummaryClaimToken, epoch: number): void;
	settleFailure(
		job: TranscriptSummaryJob,
		outcome: Extract<JobOutcome, { kind: "stale" | "fail" }>,
		now: number,
		returnClaim?: boolean,
	): void;
	spanTime(span: TranscriptSourceSpan): number | undefined;
	summarizeChecked(
		job: TranscriptSummaryJob,
		token: TranscriptSummaryClaimToken,
		summarizer: TranscriptSummarizerPort,
		summary: SummaryRequest,
		signal: AbortSignal,
		sourceRefs: readonly TranscriptSourceRef[],
		contextRefs: readonly TranscriptSourceRef[],
		admissionInput: Pick<TranscriptSummaryAdmissionRequest, "level" | "target" | "context">,
	): Promise<{ text: string; model: string; admission: TranscriptSummaryAdmissionRecord } | { outcome: JobOutcome }>;
	unapprovedWait(node: TranscriptSummaryNode): TranscriptReadmissionWait | undefined;
}
