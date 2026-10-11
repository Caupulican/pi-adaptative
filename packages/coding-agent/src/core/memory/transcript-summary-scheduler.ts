/**
 * Bounded summary job state: the one owner of every job transition, the ready queue and merge-candidate
 * detection. Pure and event-driven: no timers, filesystem, provider clients or clock reads (callers pass
 * `now`), and no whole-tree scan on any event.
 *
 * Leaf jobs are enqueued from committed-input events. A parent job becomes admissible the moment both
 * aligned siblings are ready, found by an O(1) lookup of the sibling slot. Retries are armed through
 * {@link TranscriptSummaryScheduler.nextWakeAt}: the owner keeps ONE timer for the earliest `retry_wait`
 * and calls {@link TranscriptSummaryScheduler.promoteDue} when it fires. Completion is driven by the
 * result of the work, never by polling it.
 *
 * Attempts versus usage. An ATTEMPT is one claim of a job ({@link TranscriptSummaryScheduler.claimNext}):
 * the authorization for that job identity to do its chargeable work once (read its sources, and for a model
 * summary call the summarizer and the admission evaluator). Attempts are counted per identity, bounded by
 * `maxAttempts`, and never reset: not by an interrupt, a stop, a mode switch, a restart or pruning. USAGE is
 * what the provider calls inside an attempt cost (tokens, money); it is charged per response by the
 * summarizer adapter and by the evaluator's `semantic_usage` receipt, never counted or reset here. One
 * attempt can make zero summarizer calls (an exact copy, or a validated reply kept on the job) and still
 * spend an evaluator call.
 *
 * Terminal proof. Every identity admitted for chargeable work holds one record in the store's bounded
 * terminal-proof ledger: a reservation while its job lives, its spent budget once it failed, its carried
 * attempts once it went stale or was cancelled after starting one (found again, it resumes with them). A new identity
 * is admitted only when its record fits under {@link TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS} (and outside a
 * possibly-lost-proof scope); otherwise it is held, never started with a budget the ledger could not keep.
 */

import {
	classifyFailure,
	computeRetryDelayMs,
	RetryDelayExceededError,
	type RetryPolicy,
} from "../../kernel/reliability/index.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	canTransitionSummaryJob,
	isTerminalSummaryJobState,
	TRANSCRIPT_CAPTURE_VERSION,
	TRANSCRIPT_SUMMARY_MAX_BYTES,
	TRANSCRIPT_SUMMARY_RECIPE_VERSION,
	type TranscriptSourceRef,
	type TranscriptSummaryJobState,
	utf8ByteLength,
} from "./transcript-memory-contracts.ts";
import {
	parseSummaryAdmission,
	summaryTextDigest,
	type TranscriptSummaryAdmissionRecord,
} from "./transcript-summary-admission.ts";
import {
	isCurrentCaptureNode,
	isNonNegativeInteger,
	leafJobKey,
	parentIdentity,
	parentJobKey,
	parseChildPair,
	parseSourceRefs,
	parseSummaryHeader,
	type TranscriptSummaryNode,
	type TranscriptSummarySpanRange,
} from "./transcript-summary-node.ts";

export const TRANSCRIPT_SUMMARY_DEFAULT_CONCURRENCY = 2;
export const TRANSCRIPT_SUMMARY_MAX_ATTEMPTS = 3;
/** New leaf work is refused beyond this many non-terminal jobs; the producer must back off. */
export const TRANSCRIPT_SUMMARY_MAX_ACTIVE_JOBS = 1_500;
/**
 * Jobs held for an outside condition do not count toward the active ceiling (a long hold must not stop exact
 * copies from being discovered), but live jobs stay bounded below the store's persisted-job ceiling.
 */
export const TRANSCRIPT_SUMMARY_MAX_LIVE_JOBS = 1_900;
/**
 * The most non-terminal jobs the store persists (`saveJobs` refuses more with `jobs_overflow`). Leaf and parent
 * admission both stop at {@link TRANSCRIPT_SUMMARY_MAX_LIVE_JOBS} below it (parents bypass only the active ceiling),
 * so admission never makes a save overflow.
 */
export const TRANSCRIPT_SUMMARY_MAX_PERSISTED_JOBS = 2_000;
/**
 * Terminal-proof records the store keeps: reservations, spent budgets and carried attempts. A record leaves only
 * when its job ends without spending any budget (ready, or stale/cancelled before any attempt) or with a forgotten
 * or confirmed-absent session.
 */
export const TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS = 20_000;

export const TRANSCRIPT_SUMMARY_RETRY_POLICY: RetryPolicy = {
	maxAttempts: TRANSCRIPT_SUMMARY_MAX_ATTEMPTS,
	baseDelayMs: 10_000,
	maxDelayMs: 300_000,
	jitterRatio: 0.2,
};

export type TranscriptSummaryJobKind = "leaf" | "parent";

export interface TranscriptSummaryJobError {
	/** The real cause, verbatim from the failing call. */
	message: string;
	/** `provider` classification reason, or `malformed` / `policy`; `<reason>_attempts_exhausted` when a failure ended the retry budget, `attempts_exhausted` when dispatch refused a job whose attempts were already spent. */
	reason: string;
	transient: boolean;
}

/**
 * A summarizer reply that passed the deterministic checks and awaits (or lost) its admission, kept on the job
 * so a retry or a restart uses it instead of paying the summarizer again. Bound to the exact input it answered
 * (`inputKey`, the digest of the prompt) and to the recipe; used only while both still match and it still passes
 * the checks. It is judged again unless an acceptance kept with it ({@link TranscriptSummaryKeptAdmission}) still
 * matches its admission input, the contract version and its text, in which case that verdict is published without
 * asking the evaluator again. It is not a node: it is never read as summary content, and it is dropped when the
 * job leaves the queue.
 */
export interface TranscriptSummaryPendingReply {
	text: string;
	model: string;
	/** SHA-256 hex of `text`. */
	textDigest: string;
	/** Digest of the prompt (the exact input) this reply answered. */
	inputKey: string;
	recipeVersion: number;
	/** The capture identity version of the sources it answered; a reply of another version is never judged. */
	captureVersion: number;
	/** The acceptance this reply already received, once judged: see {@link TranscriptSummaryKeptAdmission}. */
	admission?: TranscriptSummaryKeptAdmission;
}

/**
 * The accepted judgment of a kept reply, so a retry after the judgment (an index that did not answer at
 * publication, a restart before it) publishes that verdict instead of asking the evaluator again, which would pay
 * it twice and could flip it. Bound to the exact admission input it judged (`inputDigest`) and, through the
 * record's own `textDigest` and `contractVersion`, to the reply text and the contract: reused only while all of
 * them still match. Publication re-checks the policy and contract fences whatever produced the judgment.
 */
export interface TranscriptSummaryKeptAdmission {
	record: TranscriptSummaryAdmissionRecord;
	/** SHA-256 hex of the admission input (recipe, level, target and context) the record judged. */
	inputDigest: string;
}

export interface TranscriptSummaryJob {
	/** Scheduling key: {@link leafJobKey} / {@link parentJobKey}. The produced node id is `nodeId`, known once built. */
	id: string;
	kind: TranscriptSummaryJobKind;
	sessionId: string;
	/** Level of the node this job produces. */
	level: number;
	ordinal: number;
	spanRange: TranscriptSummarySpanRange;
	/** Leaf only: the exact covered parts. */
	sourceRefs?: TranscriptSourceRef[];
	/** Parent only: the two aligned sibling node ids. */
	children?: [string, string];
	state: TranscriptSummaryJobState;
	/** Attempts started so far (claims, not provider calls); an interrupted attempt stays counted. */
	attempts: number;
	maxAttempts: number;
	nextRetryAt?: number;
	lastError?: TranscriptSummaryJobError;
	/** Set when the job is `ready`: the accepted node it produced. */
	nodeId?: string;
	/** Queued, running or retrying jobs only: see {@link TranscriptSummaryPendingReply}. */
	pendingReply?: TranscriptSummaryPendingReply;
	/**
	 * The capture identity version its source handles (or children) were taken under; absent means 1. A job of an
	 * older version names inputs that are no longer the current identity, so the owner ends it stale at start.
	 */
	captureVersion?: number;
	createdAt: number;
	updatedAt: number;
	terminalAt?: number;
}

/** What the scheduler needs to know about a ready node. */
export type TranscriptSummaryReadyNode = Pick<
	TranscriptSummaryNode,
	"id" | "level" | "ordinal" | "sessionId" | "spanRange" | "legacyIdentity"
>;

export interface TranscriptSummaryLeafInput {
	sessionId: string;
	ordinal: number;
	spanRange: TranscriptSummarySpanRange;
	sourceRefs: TranscriptSourceRef[];
	/** The job key the same coverage had under capture version 1 (its refs' text-only digests), to find its budget. */
	legacyKey: string;
}

/**
 * What one dispatch produced: the job to run (if a slot and a queued job were available) and the queued jobs
 * the dispatch refused because their attempt budget was already spent. Exhausted jobs are terminal `failed`
 * with reason `attempts_exhausted`; the owner reports them like any other terminal failure.
 */
export interface TranscriptSummaryClaim {
	/** The claimed job (a copy, never the truth about its budget) and the token that authorizes its attempt. */
	claimed?: { job: TranscriptSummaryJob; token: TranscriptSummaryClaimToken };
	exhausted: TranscriptSummaryJob[];
}

/**
 * What one claim is authorized to spend: exactly attempt `attempt` of job `jobId`, under the job's spending
 * authority `authority` at claim time. `claimId` and `authority` come from scheduler-wide monotone counters, so a token
 * never matches a later claim or a replaced job. Checked with {@link TranscriptSummaryScheduler.isClaimCurrent}.
 */
export interface TranscriptSummaryClaimToken {
	jobId: string;
	claimId: number;
	authority: number;
	attempt: number;
}

export type TranscriptSummaryEnqueueResult =
	| { status: "created" | "exists"; job: TranscriptSummaryJob }
	/** Admission is closed until the owner opens it (the start's first job save); nothing was created. */
	| { status: "admission_closed" }
	| { status: "backpressure"; active: number }
	/** A new identity whose terminal proof the ledger cannot take now; nothing was created. */
	| { status: "held"; cause: TranscriptSummaryProofHoldCause };

/**
 * `provider`: classify the message and retry only a transient failure. `transient`: the caller has already
 * established the cause is temporary (a source that is not ready yet, a store that could not be written) and asks
 * for a bounded retry. `malformed` / `policy`: never retried. `internal`: an invariant of the owner broke (a
 * programming error); never retried, so it cannot loop.
 */
export interface TranscriptSummaryFailure {
	message: string;
	kind: "provider" | "transient" | "malformed" | "policy" | "internal";
	provider?: string;
	/** A more precise fixed class than the kind's default (`source_not_ready`, `malformed`, `policy`, `internal`); recorded as the job's error reason. */
	reason?: string;
}

/**
 * The compact, persisted budget of a terminal `failed` job, recorded when it fails and kept after the job list
 * prunes the job: enough that an identical job key found again cannot be granted a fresh attempt budget.
 */
export interface TranscriptSummarySpentAttempt {
	sessionId: string;
	/** Attempts started before the job ended. */
	attempts: number;
	maxAttempts: number;
	/** The job's terminal failure class. */
	reason: string;
	/** The real cause, bounded. */
	message: string;
	/** When the job ended (epoch ms). */
	at: number;
}

/**
 * One identity's record in the terminal-proof ledger, by job key. `reserved`: the identity was admitted and its
 * job has not ended; the slot is held so its failure can always be recorded. `spent`: the job failed; its
 * budget outlives the job. `carried`: the job went stale or was cancelled after starting `attempts`; the same
 * identity found again (a branch switched away and back gives the same job key) resumes with them instead of
 * a fresh budget. Spent and carried records leave only with a forgotten or confirmed-absent session.
 */
export type TranscriptSummaryProofRecord =
	/**
	 * `attemptsFloor`: attempts the live job is known to have started at least, written in the same ledger write
	 * that removed a version 1 budget merged into it ({@link TranscriptSummaryScheduler.recover} applies it), so the
	 * merge survives a crash before the job list carrying the merged count is written.
	 */
	| { kind: "reserved"; sessionId: string; at: number; attemptsFloor?: number }
	| ({ kind: "spent" } & TranscriptSummarySpentAttempt)
	| { kind: "carried"; sessionId: string; attempts: number; at: number };

/**
 * The proof record a job needs: `reserved` while it lives, `spent` once it failed, `carried` once it went stale
 * or was cancelled after starting an attempt; none for a ready job (it completed) or one that ended before any
 * attempt (it spent nothing). The one rule the store and the scheduler both apply.
 */
export function proofKindFor(
	job: Pick<TranscriptSummaryJob, "state" | "attempts">,
): TranscriptSummaryProofRecord["kind"] | undefined {
	if (!isTerminalSummaryJobState(job.state)) return "reserved";
	if (job.state === "failed") return "spent";
	if ((job.state === "stale" || job.state === "cancelled") && job.attempts > 0) return "carried";
	return undefined;
}

/**
 * `capacity`: the ledger reached its bound, so new identities wait for a slot. `possibly_lost_proof`: terminal
 * proof may have been lost before `since` (a full ledger from before reservations existed, or damaged proof),
 * so no new identity of a session started at or before `since` is admitted: it might be one whose budget was lost.
 */
export type TranscriptSummaryProofHoldCause = "capacity" | "possibly_lost_proof";

export interface TranscriptSummaryProofHold {
	cause: TranscriptSummaryProofHoldCause;
	/** ISO instant the hold took effect. */
	since: string;
}

/**
 * A version 1 budget record moved or merged to its current job key, to be applied durably by the next save.
 * `merged`: the current key already held a record, so the version 1 attempts were added to it (capped at the job's
 * `maxAttempts`); the total the current record carries afterwards. Absent: the record moves unchanged.
 */
export interface TranscriptSummaryRekey {
	from: string;
	to: string;
	merged?: number;
}

export interface TranscriptSummarySchedulerOptions {
	/**
	 * `closed`: no new identity is admitted (leaves answer `admission_closed`, parents wait in the held slots) until
	 * {@link TranscriptSummaryScheduler.openAdmission}. The owner closes it until the start's first job save is
	 * acknowledged, so version 1 budgets are converted durably before any current identity can need them.
	 */
	admission?: "open" | "closed";
	concurrency?: number;
	maxAttempts?: number;
	maxActiveJobs?: number;
	retryPolicy?: RetryPolicy;
	/** Jitter source; injectable so a retry schedule is reproducible. */
	random?: () => number;
	/**
	 * The canonical start (epoch ms) of a session, undefined when unknown or unparseable. Read only under a
	 * `possibly_lost_proof` hold: a session started after it admits new identities, any other is held.
	 */
	sessionStartedAt?: (sessionId: string) => number | undefined;
}

/** What a batch of revoked nodes did to the scheduler. */
export interface TranscriptSummaryRevocation {
	/** `ready` jobs removed because their accepted node is gone: a ready job is proof of completion only while its node is accepted. */
	dropped: TranscriptSummaryJob[];
	/** Parent jobs enqueued again because both aligned children are still ready. */
	readmitted: TranscriptSummaryJob[];
}

export interface TranscriptSummaryRecovery {
	/** Jobs that were `running` when the process stopped and are queued again with their attempts kept. */
	interrupted: string[];
	/**
	 * Jobs that were `running` when the process stopped although their node had already been published and accepted
	 * (a stop between publication and the save of the `ready` state): settled `ready` from that exact node.
	 */
	completed: string[];
	/** `ready` jobs whose node was never accepted; they are discarded so the work can be enqueued afresh. */
	dropped: TranscriptSummaryJob[];
}

const JOB_STATES: readonly TranscriptSummaryJobState[] = [
	"queued",
	"running",
	"ready",
	"retry_wait",
	"failed",
	"cancelled",
	"stale",
];

function slotKey(sessionId: string, level: number, ordinal: number): string {
	return `${sessionId}\u0000${level}\u0000${ordinal}`;
}

/** Process-wide monotone sequences for claim ids and spending authorities (see {@link TranscriptSummaryClaimToken}). */
let claimSequence = 0;
let authoritySequence = 0;

function nextClaimId(): number {
	claimSequence += 1;
	return claimSequence;
}

function nextAuthority(): number {
	authoritySequence += 1;
	return authoritySequence;
}

export class TranscriptSummaryScheduler {
	private readonly jobs = new Map<string, TranscriptSummaryJob>();
	private readonly queued = new Set<string>();
	/** Claims returned per job by {@link failJob} (no provider call was made); bounds the refund. In memory only. */
	private readonly returnedClaims = new Map<string, number>();
	private readonly running = new Set<string>();
	private readonly retryWait = new Set<string>();
	private readonly jobsBySession = new Map<string, Set<string>>();
	/** Ready nodes by slot, so sibling lookup is one map read. */
	private readonly readyBySlot = new Map<string, TranscriptSummaryReadyNode>();
	private readonly slotByNode = new Map<string, string>();
	/** The `ready` job that produced each ready node: a job is `ready` exactly while its node is in `slotByNode`. */
	private readonly readyJobByNode = new Map<string, string>();
	/**
	 * The store's terminal-proof records by job key, mirrored from every save: a spent budget means identical work
	 * found again is not given a fresh budget; a reservation means the identity already holds its slot.
	 */
	private readonly proof = new Map<string, TranscriptSummaryProofRecord>();
	/** Jobs that need a proof record (live, or failed) and have none yet: each takes a ledger slot at the next save. */
	private readonly unproven = new Set<string>();
	/** Parent slots a proof hold refused, by slot key, admitted again by {@link retryProofHolds}. */
	private readonly heldParents = new Map<string, { sessionId: string; level: number; ordinal: number }>();
	/** Version 1 budget records moved or merged to their current job key here, waiting for the next save. */
	private readonly pendingRekeys = new Map<string, { to: string; merged?: number }>();
	private admissionOpen: boolean;
	/**
	 * Each job's spending authority: a value from the process-wide {@link nextAuthority}, given when the job is
	 * created or recovered and replaced whenever anything other than its own claim changes what it may spend (see
	 * {@link bumpAuthority}). Process-wide values mean a token from another scheduler (a stopped run whose work is
	 * still settling) never matches this one. Claims do not survive a restart (a running job is recovered queued).
	 */
	private readonly authorityOf = new Map<string, number>();
	/** The claim each running job is under, by its process-wide `claimId`. */
	private readonly claims = new Map<string, number>();
	/** Set when a parent was held at {@link TRANSCRIPT_SUMMARY_MAX_LIVE_JOBS}; see {@link admitBelowLiveBound}. */
	private liveBoundHeld = false;
	/** Set under a `possibly_lost_proof` hold: sessions started at or before it admit no new identity. */
	private lostProofSince: number | undefined;
	private readonly concurrency: number;
	private readonly maxAttempts: number;
	private readonly maxActiveJobs: number;
	private readonly retryPolicy: RetryPolicy;
	private readonly random: () => number;
	private readonly sessionStartedAt: ((sessionId: string) => number | undefined) | undefined;

	constructor(options: TranscriptSummarySchedulerOptions = {}) {
		this.concurrency = options.concurrency ?? TRANSCRIPT_SUMMARY_DEFAULT_CONCURRENCY;
		this.maxAttempts = options.maxAttempts ?? TRANSCRIPT_SUMMARY_MAX_ATTEMPTS;
		this.maxActiveJobs = options.maxActiveJobs ?? TRANSCRIPT_SUMMARY_MAX_ACTIVE_JOBS;
		this.retryPolicy = options.retryPolicy ?? TRANSCRIPT_SUMMARY_RETRY_POLICY;
		this.random = options.random ?? Math.random;
		this.sessionStartedAt = options.sessionStartedAt;
		this.admissionOpen = options.admission !== "closed";
		if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
			throw new RangeError("Summary concurrency must be a positive integer.");
		}
		if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
			throw new RangeError("Summary maxAttempts must be a positive integer.");
		}
	}

	// ---- enqueue ------------------------------------------------------------------------------

	/**
	 * Enqueue the leaf for a committed run of spans. Idempotent per coverage: a job that already exists
	 * (in any state but `cancelled` / `stale`, which are replaced by a fresh one) is returned unchanged. A new
	 * identity the terminal-proof ledger cannot take is `held` and nothing is created; the producer stops and
	 * resumes when a slot frees (see {@link retryProofHolds}).
	 */
	enqueueLeaf(
		input: TranscriptSummaryLeafInput,
		now: number,
		held?: ReadonlyMap<string, unknown>,
	): TranscriptSummaryEnqueueResult {
		if (!this.admissionOpen) return { status: "admission_closed" };
		const id = leafJobKey({ sessionId: input.sessionId, sourceRefs: input.sourceRefs });
		// Before an existing job is returned: its version 1 budget merges into it (see adoptLegacyBudget).
		this.adoptLegacyBudget(id, input.legacyKey);
		const existing = this.jobs.get(id);
		if (existing && existing.state !== "cancelled" && existing.state !== "stale") {
			return { status: "exists", job: { ...existing } };
		}
		const base = {
			id,
			kind: "leaf" as const,
			sessionId: input.sessionId,
			level: 0,
			ordinal: input.ordinal,
			spanRange: { ...input.spanRange },
			sourceRefs: [...input.sourceRefs],
		};
		// A terminal job whose budget was spent comes back as that same failure, not as new work.
		const revived = this.reviveSpent(base, now);
		if (revived) return { status: "exists", job: revived };
		const live = this.activeCount();
		let heldQueued = 0;
		if (held) for (const id of held.keys()) if (this.queued.has(id)) heldQueued += 1;
		const active = live - heldQueued;
		if (active >= this.maxActiveJobs || live >= TRANSCRIPT_SUMMARY_MAX_LIVE_JOBS) {
			return { status: "backpressure", active };
		}
		const refusal = this.proofRefusal(id, input.sessionId);
		if (refusal) return { status: "held", cause: refusal };
		return { status: "created", job: this.insert(base, now) };
	}

	// ---- terminal proof -----------------------------------------------------------------------

	/**
	 * Mirror what the store persisted: proof records it wrote (reservations, spent budgets) and reservations it
	 * released because their job ended without spending a budget. Called with every save result and with the
	 * loaded ledger at start, before {@link recover}, so recovered jobs keep the reservations they already hold.
	 */
	noteProof(records: Readonly<Record<string, TranscriptSummaryProofRecord>>, released: readonly string[] = []): void {
		for (const [id, record] of Object.entries(records)) this.proof.set(id, { ...record });
		for (const id of released) {
			if (this.proof.get(id)?.kind === "spent") continue;
			this.proof.delete(id);
			if (this.jobs.has(id)) this.bumpAuthority(id);
		}
		for (const id of [...Object.keys(records), ...released]) {
			const job = this.jobs.get(id);
			if (!job) continue;
			this.applyDurableFloor(job);
			this.track(job);
		}
	}

	/**
	 * A live job never starts fewer attempts than its durable record says it already started: a merged version 1
	 * budget (`attemptsFloor`), the attempts a replaced job carried, or a spent budget. Idempotent (a maximum); raising
	 * the count changes the job's spending authority.
	 */
	private applyDurableFloor(job: TranscriptSummaryJob): void {
		if (isTerminalSummaryJobState(job.state)) return;
		const floor = Math.min(this.durableFloor(job.id), job.maxAttempts);
		if (floor <= job.attempts) return;
		job.attempts = floor;
		this.bumpAuthority(job.id);
	}

	/** The attempts this identity's durable record says were already started; 0 without one. */
	private durableFloor(jobId: string): number {
		const record = this.proof.get(jobId);
		if (record?.kind === "reserved") return record.attemptsFloor ?? 0;
		return record ? record.attempts : 0;
	}

	/**
	 * Anything other than a job's own claim changed what it may spend (a merge or floor, a revive or insert, an
	 * exhaustion, a transition the claim did not make, a dropped record): a claim taken before is no longer current.
	 */
	private bumpAuthority(jobId: string): void {
		this.authorityOf.set(jobId, nextAuthority());
	}

	/**
	 * Whether this claim still authorizes its attempt: the job is running under THIS claim, nothing changed its
	 * spending authority since, its count is still the claimed attempt, and that attempt is within the budget. A final
	 * attempt (`attempt === maxAttempts`) that was claimed under unchanged authority is current.
	 */
	isClaimCurrent(token: TranscriptSummaryClaimToken): boolean {
		const job = this.jobs.get(token.jobId);
		return (
			job !== undefined &&
			this.ownsClaim(token) &&
			this.authorityOf.get(job.id) === token.authority &&
			job.attempts === token.attempt &&
			token.attempt <= job.maxAttempts
		);
	}

	/**
	 * Return a claim that made no provider call (it is no longer current, or its work is held): the job is queued
	 * again and its own increment returned, but never below what its durable record says was already started, so a
	 * merged or spent budget is never given back. A token that is not the job's running claim changes nothing.
	 */
	abandonClaim(
		token: TranscriptSummaryClaimToken,
		cause: { message: string; reason: string },
		now: number,
	): TranscriptSummaryJob | undefined {
		if (!this.ownsClaim(token)) return undefined;
		return this.defer(token.jobId, cause, now);
	}

	/**
	 * Whether this claim still owns its job: the job is running under exactly this `claimId`. The one ownership test
	 * for every asynchronous effect of a claim (settling, returning, keeping a reply, publishing): an old claim's late
	 * callback never mutates a replacement claim of the same job id. Distinct from {@link isClaimCurrent}: an authority
	 * change does not end ownership, so the owning claim still settles or returns itself (floor-clamped).
	 */
	ownsClaim(token: TranscriptSummaryClaimToken): boolean {
		const job = this.jobs.get(token.jobId);
		return job?.state === "running" && this.claims.get(job.id) === token.claimId;
	}

	/**
	 * Re-key or merge this recovered job's version 1 budget now (start-up reconciliation, before admission opens), the
	 * same adoption discovery performs when it finds the coverage again.
	 */
	reconcileLegacy(jobId: string, legacyKey: string): void {
		this.adoptLegacyBudget(jobId, legacyKey);
	}

	/**
	 * Apply the ledger's hold; only `possibly_lost_proof` changes admission, a capacity hold is the count itself. An
	 * unreadable instant is refused: it would compare false against every session and admit them all.
	 */
	setProofHold(hold: TranscriptSummaryProofHold | undefined): void {
		if (hold?.cause !== "possibly_lost_proof") {
			this.lostProofSince = undefined;
			return;
		}
		const since = Date.parse(hold.since);
		if (Number.isNaN(since))
			throw new RangeError(`The possibly-lost-proof hold has no readable instant: ${hold.since}`);
		this.lostProofSince = since;
	}

	/** True when the store holds this job's proof record: only then may a claimed attempt reach a provider. */
	hasProof(jobId: string): boolean {
		return this.proof.has(jobId);
	}

	/**
	 * Sessions that still have a budget record (spent or carried), so the owner can drop the records of vanished
	 * sessions.
	 */
	spentSessionIds(): Set<string> {
		const sessions = new Set<string>();
		for (const record of this.proof.values()) if (record.kind !== "reserved") sessions.add(record.sessionId);
		return sessions;
	}

	/**
	 * Forget the budget records (spent and carried) of sessions that are forgotten for good or no longer exist, as
	 * the store's `dropSessionRecords` does. Reservations stay: they end with their job.
	 */
	forgetSpentOf(sessionIds: ReadonlySet<string>): void {
		for (const [id, record] of this.proof) {
			if (record.kind !== "reserved" && sessionIds.has(record.sessionId)) {
				this.proof.delete(id);
				if (this.jobs.has(id)) this.bumpAuthority(id);
			}
		}
	}

	/**
	 * Whether this scheduler holds anything for the session: a job, a terminal-proof record (reservation, spent or
	 * carried budget) or a parent slot a proof hold refused.
	 */
	holdsSession(sessionId: string): boolean {
		if ((this.jobsBySession.get(sessionId)?.size ?? 0) > 0) return true;
		for (const record of this.proof.values()) if (record.sessionId === sessionId) return true;
		for (const slot of this.heldParents.values()) if (slot.sessionId === sessionId) return true;
		return false;
	}

	/**
	 * After a slot freed or a hold changed: admit again the parent jobs a proof hold refused (bounded by the ready
	 * nodes that produce them). Leaf identities are not remembered here; their producer resumes enumeration.
	 */
	retryProofHolds(now: number): TranscriptSummaryJob[] {
		const held = [...this.heldParents.values()];
		this.heldParents.clear();
		return held.flatMap(({ sessionId, level, ordinal }) => this.admitParent(sessionId, level, ordinal, now));
	}

	/**
	 * The one admission rule for a NEW job identity: its terminal proof must fit. Under a `possibly_lost_proof`
	 * hold, a session not known to have started after the hold admits none, whatever records it still has: any
	 * new identity of it might be one whose budget was lost. Otherwise an identity whose record the ledger
	 * already holds needs no new slot, and any other needs one below the bound, counting the jobs that take a
	 * slot at the next save.
	 */
	private proofRefusal(id: string, sessionId: string): TranscriptSummaryProofHoldCause | undefined {
		if (this.lostProofSince !== undefined) {
			const started = this.sessionStartedAt?.(sessionId);
			if (started === undefined || started <= this.lostProofSince) {
				return "possibly_lost_proof";
			}
		}
		if (this.proof.has(id)) return undefined;
		return this.proof.size + this.unproven.size >= TRANSCRIPT_SUMMARY_MAX_SPENT_ATTEMPTS ? "capacity" : undefined;
	}

	/**
	 * Capture version 2 changed every handle digest, so every job key. A spent or carried budget recorded under the
	 * job's version 1 key (`legacyKey`, the same coverage with text-only digests: validated, since identical text is
	 * identical work) follows the current key, so the upgrade never grants a fresh budget. The terminal version 1 job
	 * that produced a carried record is dropped with it, or the next save would record its attempts under the old key
	 * again. Reservations are never adopted: admission is closed until the start's first save converted every version
	 * 1 job (they end stale at start) into a carried record or released it, so a live version 1 job cannot be found
	 * here once admission is open.
	 *
	 * When the current key holds no record, the version 1 record moves there unchanged. When it already holds one,
	 * the version 1 attempts MERGE into it once: a reservation of a live job gets `attemptsFloor` (and the job its
	 * count), a carried record its attempts, both capped at the job's `maxAttempts`; a spent one is final and only the
	 * version 1 record leaves. The version 1 record is removed in the same ledger write that records the merge, so a
	 * second merge cannot happen, and the floor keeps a crash before the job list is written from losing it.
	 */
	private adoptLegacyBudget(id: string, legacyKey: string): void {
		if (legacyKey === id) return;
		const record = this.proof.get(legacyKey);
		if (record?.kind !== "spent" && record?.kind !== "carried") return;
		const legacyJob = this.jobs.get(legacyKey);
		if (legacyJob && !isTerminalSummaryJobState(legacyJob.state)) return;
		if (legacyJob) this.removeJob(legacyJob);
		this.proof.delete(legacyKey);
		const current = this.proof.get(id);
		const job = this.jobs.get(id);
		if (current === undefined) {
			this.proof.set(id, record);
			this.pendingRekeys.set(legacyKey, { to: id });
			// A job already here starts no fewer attempts than the budget it now holds.
			if (job) {
				this.bumpAuthority(id);
				this.applyDurableFloor(job);
			}
			return;
		}
		if (current.kind === "spent") {
			// Final already: the version 1 record only leaves.
			this.pendingRekeys.set(legacyKey, { to: id, merged: current.attempts });
			return;
		}
		const own = Math.max(current.kind === "carried" ? current.attempts : 0, job?.attempts ?? 0);
		const merged = Math.min(job?.maxAttempts ?? this.maxAttempts, own + record.attempts);
		this.proof.set(
			id,
			current.kind === "carried"
				? { ...current, attempts: merged }
				: { ...current, attemptsFloor: Math.max(current.attemptsFloor ?? 0, merged) },
		);
		if (job) {
			this.bumpAuthority(id);
			this.applyDurableFloor(job);
		}
		this.pendingRekeys.set(legacyKey, { to: id, merged });
	}

	/** Budget records moved or merged in memory and not yet durably, for the next save to apply. */
	rekeysToSave(): TranscriptSummaryRekey[] {
		return [...this.pendingRekeys].map(([from, pending]) => ({ from, ...pending }));
	}

	/** A save applied these moves: they are durable now. Ones a save skipped or a failed save did not apply stay pending. */
	rekeysSaved(rekeys: readonly TranscriptSummaryRekey[]): void {
		for (const { from, to } of rekeys) if (this.pendingRekeys.get(from)?.to === to) this.pendingRekeys.delete(from);
	}

	/**
	 * Open admission (the start's first job save was acknowledged): parents that arrived while it was closed are
	 * admitted now, and the leaf producer resumes. Returns the parents admitted.
	 */
	openAdmission(now: number): TranscriptSummaryJob[] {
		this.admissionOpen = true;
		return this.retryProofHolds(now);
	}

	/**
	 * Parents held at {@link TRANSCRIPT_SUMMARY_MAX_LIVE_JOBS} are admitted again once live work fell below it.
	 * The owner calls this whenever it dispatches; it is a no-op unless a parent was held for the bound.
	 */
	admitBelowLiveBound(now: number): TranscriptSummaryJob[] {
		if (!this.liveBoundHeld || this.activeCount() >= TRANSCRIPT_SUMMARY_MAX_LIVE_JOBS) return [];
		this.liveBoundHeld = false;
		return this.retryProofHolds(now);
	}

	/** The failed job a spent record stands for, tracked like any other terminal job; undefined without a record. */
	private reviveSpent(
		base: Pick<
			TranscriptSummaryJob,
			"id" | "kind" | "sessionId" | "level" | "ordinal" | "spanRange" | "sourceRefs" | "children"
		>,
		now: number,
	): TranscriptSummaryJob | undefined {
		const record = this.proof.get(base.id);
		if (record?.kind !== "spent") return undefined;
		const job: TranscriptSummaryJob = {
			...base,
			state: "failed",
			attempts: record.attempts,
			maxAttempts: record.maxAttempts,
			lastError: { message: record.message, reason: record.reason, transient: false },
			captureVersion: TRANSCRIPT_CAPTURE_VERSION,
			createdAt: record.at,
			updatedAt: now,
			terminalAt: record.at,
		};
		this.jobs.set(job.id, job);
		this.bumpAuthority(job.id);
		this.track(job);
		return { ...job };
	}

	/**
	 * A node became ready (a job finished, or an accepted node was restored). When its aligned sibling is
	 * ready too, the parent job is enqueued and returned; otherwise nothing is. Registering the same node
	 * again does not register twice, but still admits the parent when that is missing. Parent jobs are bounded
	 * by the ready nodes that produce them and bypass backpressure, so a pair of ready children can never be
	 * stranded; a parent a proof hold refuses is remembered and admitted by {@link retryProofHolds}.
	 */
	onNodeReady(node: TranscriptSummaryReadyNode, now: number): TranscriptSummaryJob[] {
		const key = slotKey(node.sessionId, node.level, node.ordinal);
		const registered = this.readyBySlot.get(key);
		if (registered && registered.id !== node.id) {
			throw new Error(
				`Slot ${node.sessionId} level ${node.level} ordinal ${node.ordinal} already holds ready node ${registered.id}; refusing ${node.id}.`,
			);
		}
		if (!registered) {
			this.readyBySlot.set(key, { ...node, spanRange: { ...node.spanRange } });
			this.slotByNode.set(node.id, key);
		}
		return this.admitParent(node.sessionId, node.level + 1, Math.floor(node.ordinal / 2), now);
	}

	/**
	 * The one admission rule for a parent job: both aligned children ready, no live job for that pair, and room
	 * for a new identity's terminal proof. A `ready` job here is live because the ready index only holds accepted
	 * nodes (see {@link revokeNodes}).
	 */
	private admitParent(sessionId: string, level: number, ordinal: number, now: number): TranscriptSummaryJob[] {
		const left = this.readyBySlot.get(slotKey(sessionId, level - 1, ordinal * 2));
		const right = this.readyBySlot.get(slotKey(sessionId, level - 1, ordinal * 2 + 1));
		if (!left || !right) return [];
		if (left.spanRange.toIndexExclusive !== right.spanRange.fromIndex) {
			throw new Error(`Sibling nodes ${left.id} and ${right.id} are not adjacent on session ${sessionId}.`);
		}
		const slot = slotKey(sessionId, level, ordinal);
		if (!this.admissionOpen) {
			this.heldParents.set(slot, { sessionId, level, ordinal });
			return [];
		}
		const children: [string, string] = [left.id, right.id];
		const id = parentJobKey({ sessionId, level, children });
		// Before an existing job is returned: its version 1 budget merges into it (see adoptLegacyBudget).
		if (left.legacyIdentity !== undefined && right.legacyIdentity !== undefined) {
			this.adoptLegacyBudget(
				id,
				parentJobKey({ sessionId, level, children: [left.legacyIdentity, right.legacyIdentity] }),
			);
		}
		const existing = this.jobs.get(id);
		if (existing && existing.state !== "cancelled" && existing.state !== "stale") return [];
		const base = {
			id,
			kind: "parent" as const,
			sessionId,
			level,
			ordinal,
			spanRange: { fromIndex: left.spanRange.fromIndex, toIndexExclusive: right.spanRange.toIndexExclusive },
			children,
		};
		// A current node always carries its legacy identity; a parent whose children lack one cannot reach its
		// version 1 budget, so it is held rather than started on a budget that may already be spent.
		if (left.legacyIdentity === undefined || right.legacyIdentity === undefined) {
			this.heldParents.set(slot, { sessionId, level, ordinal });
			return [];
		}
		if (this.reviveSpent(base, now)) return [];
		if (this.proofRefusal(id, sessionId)) {
			this.heldParents.set(slot, { sessionId, level, ordinal });
			return [];
		}
		// The same live-job cap as leaf admission, below the store's persisted bound: a parent past it waits (and is
		// admitted again once live work drops) instead of making a save overflow.
		if (this.activeCount() >= TRANSCRIPT_SUMMARY_MAX_LIVE_JOBS) {
			this.heldParents.set(slot, { sessionId, level, ordinal });
			this.liveBoundHeld = true;
			return [];
		}
		return [this.insert(base, now)];
	}

	// ---- run ----------------------------------------------------------------------------------

	/** Move retry waits that are due back to the queue. The owner calls this when its single timer fires. */
	promoteDue(now: number): TranscriptSummaryJob[] {
		const promoted: TranscriptSummaryJob[] = [];
		for (const id of [...this.retryWait]) {
			const job = this.mustGet(id);
			if (job.nextRetryAt !== undefined && job.nextRetryAt <= now) {
				this.transition(job, "queued", now);
				delete job.nextRetryAt;
				promoted.push({ ...job });
			}
		}
		return promoted;
	}

	/**
	 * Start the oldest queued job when a slot is free and count the attempt. The attempt budget is enforced
	 * here, the one place a provider call is authorized: a queued job that has already started
	 * `maxAttempts` attempts (an interrupt, stop or restart keeps the count) is never started again and ends
	 * `failed` with reason `attempts_exhausted`. Identical work is a retry of the same job; a changed recipe
	 * or input is a different job key and starts with a fresh budget. The claimed attempt reaches a provider
	 * only after the save that persists it, and only when that save left the job a proof record
	 * ({@link hasProof}); a claim the ledger refused is returned through {@link defer} before any call.
	 */
	claimNext(now: number, skip?: (job: TranscriptSummaryJob) => boolean): TranscriptSummaryClaim {
		this.promoteDue(now);
		const exhausted: TranscriptSummaryJob[] = [];
		if (this.running.size >= this.concurrency) return { exhausted };
		for (const id of this.queued) {
			const job = this.mustGet(id);
			if (skip?.(job)) continue;
			if (job.attempts >= job.maxAttempts) {
				const spent = job.lastError ? ` Last failure: ${job.lastError.message}` : "";
				exhausted.push(
					this.finishFailed(
						job,
						{
							message: `The attempt budget is spent: ${job.attempts} of ${job.maxAttempts} attempts were started and none completed.${spent}`,
							reason: "attempts_exhausted",
							transient: true,
						},
						now,
					),
				);
				continue;
			}
			// The claim's own increment: it does not change the job's authority, the token records it.
			this.transition(job, "running", now, { byClaim: true });
			job.attempts += 1;
			const claimId = nextClaimId();
			this.claims.set(job.id, claimId);
			const token: TranscriptSummaryClaimToken = {
				jobId: job.id,
				claimId,
				authority: this.mustAuthority(job.id),
				attempt: job.attempts,
			};
			return { claimed: { job: { ...job }, token }, exhausted };
		}
		return { exhausted };
	}

	/**
	 * Put a running job back on the queue because the work it reached cannot run yet for a reason outside the
	 * job (an evaluator that is not bound, an egress setting, an unadmitted child summary, a terminal-proof
	 * reservation the ledger refused), BEFORE any provider
	 * call was made for it. The attempt this claim counted is returned, since no call was authorized by it,
	 * and the cause is recorded on the job. Anything that did reach a provider is never deferred: use
	 * {@link interrupt} or {@link failJob}, which keep the count. The owner must stop claiming the job until
	 * its condition clears (the `skip` of {@link claimNext}), or it would only be claimed and deferred again.
	 */
	defer(jobId: string, cause: { message: string; reason: string }, now: number): TranscriptSummaryJob | undefined {
		const job = this.mustGet(jobId);
		if (job.state !== "running") return undefined;
		this.transition(job, "queued", now, { byClaim: true });
		// Only the claim's own increment comes back: what the durable record says was started stays spent.
		job.attempts = Math.max(this.durableFloor(job.id), job.attempts - 1, 0);
		job.lastError = { message: cause.message, reason: cause.reason, transient: true };
		return { ...job };
	}

	/**
	 * The job's node was built, validated and accepted. Marks the job `ready`, registers the node and
	 * returns any parent job it unlocks. A duplicate completion of a terminal job is ignored.
	 */
	completeJob(jobId: string, node: TranscriptSummaryReadyNode, now: number): TranscriptSummaryJob[] {
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`Unknown summary job ${jobId}.`);
		if (isTerminalSummaryJobState(job.state)) return [];
		if (!sameCoverage(job, node))
			throw new Error(`Node ${node.id} does not match the coverage of summary job ${jobId}.`);
		this.settleReady(job, node, now);
		return this.onNodeReady(node, now);
	}

	/** The completion itself, shared by {@link completeJob} and recovery: the job is `ready` for exactly this node. */
	private settleReady(job: TranscriptSummaryJob, node: Pick<TranscriptSummaryNode, "id">, now: number): void {
		this.transition(job, "ready", now);
		this.returnedClaims.delete(job.id);
		job.nodeId = node.id;
		this.readyJobByNode.set(node.id, job.id);
	}

	/**
	 * The accepted node a recovered running job had already produced, or undefined. Exact evidence only, never a
	 * cursor position: a leaf's node has the job's own key over its sources (`leafJobKey`, which binds the current
	 * recipe, so the node must be of the current recipe too); a parent's node is the identity of the job's two
	 * children with no context (`parentIdentity`, as every parent is built). Either must be of the current capture
	 * version and cover exactly the job's slot.
	 */
	private acceptedCompletion(
		job: TranscriptSummaryJob,
		accepted: ReadonlyMap<string, TranscriptSummaryNode>,
		leafByJobKey: ReadonlyMap<string, TranscriptSummaryNode>,
	): TranscriptSummaryNode | undefined {
		const node =
			job.kind === "leaf"
				? leafByJobKey.get(job.id)
				: job.children
					? accepted.get(
							parentIdentity({
								sessionId: job.sessionId,
								level: job.level,
								children: job.children,
								contextRefs: [],
							}),
						)
					: undefined;
		if (!node || node.recipeVersion !== TRANSCRIPT_SUMMARY_RECIPE_VERSION || !isCurrentCaptureNode(node)) {
			return undefined;
		}
		return sameCoverage(job, node) ? node : undefined;
	}

	/**
	 * Record a failed attempt. A transient provider failure with attempts left waits for its retry; every
	 * other failure ends the job with the real cause. A failure reported for an already terminal job is ignored.
	 */
	failJob(
		jobId: string,
		failure: TranscriptSummaryFailure,
		now: number,
		options?: { readonly returnClaim?: boolean },
	): TranscriptSummaryJob | undefined {
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`Unknown summary job ${jobId}.`);
		if (isTerminalSummaryJobState(job.state)) return undefined;
		if (failure.kind === "malformed" || failure.kind === "policy" || failure.kind === "internal") {
			return this.finishFailed(
				job,
				{ message: failure.message, reason: failure.reason ?? failure.kind, transient: false },
				now,
			);
		}
		const classified =
			failure.kind === "transient"
				? { reason: failure.reason ?? "source_not_ready", retryable: true, retryAfterMs: undefined }
				: classifyFailure({
						message: failure.message,
						...(failure.provider !== undefined ? { provider: failure.provider } : {}),
					});
		if (!classified.retryable) {
			return this.finishFailed(job, { message: failure.message, reason: classified.reason, transient: false }, now);
		}
		// A retryable failure of a claim that made no provider call (it only reused a kept reply: a store write or an
		// unanswered read failed) gives back that claim's own increment, never below the durable record, as
		// {@link defer} does: the attempt budget bounds paid calls, and a call that was not made must not exhaust it.
		// The returns are bounded per job (a persistent outage ends the job at the budget as before, after as many
		// returned claims as the budget has attempts), so the refund never makes a retry unbounded.
		const delayAttempts = job.attempts;
		const returned = this.returnedClaims.get(job.id) ?? 0;
		if (options?.returnClaim && returned < job.maxAttempts) {
			this.returnedClaims.set(job.id, returned + 1);
			job.attempts = Math.max(this.durableFloor(job.id), job.attempts - 1, 0);
		}
		if (job.attempts >= job.maxAttempts) {
			return this.finishFailed(
				job,
				{ message: failure.message, reason: `${classified.reason}_attempts_exhausted`, transient: true },
				now,
			);
		}
		let delayMs: number;
		try {
			delayMs = computeRetryDelayMs(this.retryPolicy, delayAttempts, {
				random: this.random,
				...(classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {}),
			});
		} catch (error) {
			if (!(error instanceof RetryDelayExceededError)) throw error;
			return this.finishFailed(
				job,
				{ message: failure.message, reason: "retry_delay_exceeds_max", transient: true },
				now,
			);
		}
		this.transition(job, "retry_wait", now);
		job.nextRetryAt = now + delayMs;
		job.lastError = { message: failure.message, reason: classified.reason, transient: true };
		return { ...job };
	}

	/** Put a running job back on the queue (shutdown, reload, memory switch). The started attempt stays counted. */
	interrupt(jobId: string, now: number): TranscriptSummaryJob | undefined {
		const job = this.mustGet(jobId);
		if (isTerminalSummaryJobState(job.state)) return undefined;
		this.transition(job, "queued", now);
		return { ...job };
	}

	cancelJob(jobId: string, now: number): TranscriptSummaryJob | undefined {
		return this.endJob(jobId, "cancelled", now);
	}

	/** The job's inputs changed under it (lineage rewrite, deletion): its result must never be published. */
	markStale(jobId: string, now: number): TranscriptSummaryJob | undefined {
		return this.endJob(jobId, "stale", now);
	}

	/**
	 * End every non-terminal job of a session and forget its ready nodes and the ready jobs that produced them.
	 * Used when its history is invalidated: a ready job must not outlive the node it vouches for.
	 */
	endSession(
		sessionId: string,
		to: "cancelled" | "stale",
		now: number,
	): { ended: TranscriptSummaryJob[]; droppedReady: TranscriptSummaryJob[] } {
		const ended: TranscriptSummaryJob[] = [];
		for (const id of [...(this.jobsBySession.get(sessionId) ?? [])]) {
			const job = this.endJob(id, to, now);
			if (job) ended.push(job);
		}
		for (const [key, slot] of this.heldParents) if (slot.sessionId === sessionId) this.heldParents.delete(key);
		const sessionNodes: string[] = [];
		for (const nodeId of this.slotByNode.keys()) {
			if (this.slotByNode.get(nodeId)?.startsWith(`${sessionId}\u0000`)) sessionNodes.push(nodeId);
		}
		return { ended, droppedReady: this.dropReady(sessionNodes).dropped };
	}

	/**
	 * Accepted nodes were revoked (invalidation, retention, recovery). Reconciles the scheduler with the
	 * store's accepted-node evidence exactly as {@link recover} does at restart: each node leaves the ready
	 * index and the `ready` job that produced it is removed, so unchanged source refs enqueue again instead of
	 * resolving to a completion whose node is gone. With `readmit`, every revoked parent whose two children
	 * are still ready is then admitted again, even though registering an unchanged child is otherwise a
	 * no-op. The owner passes `readmit: false` when the revoked identity is forgotten for good (retention):
	 * re-deriving it could only be refused. All removals happen before any admission, so the result does
	 * not depend on the order the nodes arrive in.
	 */
	revokeNodes(nodeIds: Iterable<string>, now: number, options: { readmit: boolean }): TranscriptSummaryRevocation {
		const { dropped, nodes } = this.dropReady(nodeIds);
		const readmitted: TranscriptSummaryJob[] = [];
		if (options.readmit) {
			for (const node of nodes) {
				if (node.level >= 1) readmitted.push(...this.admitParent(node.sessionId, node.level, node.ordinal, now));
			}
		}
		return { dropped, readmitted };
	}

	/** Remove nodes from the ready index together with their `ready` jobs. */
	private dropReady(nodeIds: Iterable<string>): {
		dropped: TranscriptSummaryJob[];
		nodes: TranscriptSummaryReadyNode[];
	} {
		const dropped: TranscriptSummaryJob[] = [];
		const nodes: TranscriptSummaryReadyNode[] = [];
		for (const nodeId of nodeIds) {
			const slot = this.slotByNode.get(nodeId);
			if (slot !== undefined) {
				const node = this.readyBySlot.get(slot);
				if (node) nodes.push(node);
				this.slotByNode.delete(nodeId);
				this.readyBySlot.delete(slot);
			}
			const jobId = this.readyJobByNode.get(nodeId);
			if (jobId === undefined) continue;
			this.readyJobByNode.delete(nodeId);
			const job = this.jobs.get(jobId);
			if (job?.state !== "ready" || job.nodeId !== nodeId) continue;
			this.removeJob(job);
			dropped.push({ ...job });
		}
		return { dropped, nodes };
	}

	// ---- restart ------------------------------------------------------------------------------

	/**
	 * Load persisted jobs into an empty scheduler. `running` jobs were interrupted by the stop and are
	 * queued again with their attempts; `retry_wait` keeps its `nextRetryAt`. With the `accepted` nodes (by id), a
	 * `ready` job whose node was never accepted (a crash between completion and publication) is dropped so
	 * the work can be enqueued again instead of being believed done, and a `running` job whose node WAS published and
	 * accepted (a stop between publication and the save of `ready`) settles `ready` from that exact node (see
	 * {@link acceptedCompletion}) instead of running and paying again.
	 */
	recover(
		persisted: readonly TranscriptSummaryJob[],
		now: number,
		accepted?: ReadonlyMap<string, TranscriptSummaryNode>,
	): TranscriptSummaryRecovery {
		if (this.jobs.size > 0) throw new Error("Summary jobs can only be recovered into an empty scheduler.");
		const recovery: TranscriptSummaryRecovery = { interrupted: [], completed: [], dropped: [] };
		// Accepted leaves by the job key over their sources: the evidence a recovered leaf job already completed.
		const leafByJobKey = new Map<string, TranscriptSummaryNode>();
		for (const node of accepted?.values() ?? []) {
			if (node.level === 0)
				leafByJobKey.set(leafJobKey({ sessionId: node.sessionId, sourceRefs: node.sourceRefs }), node);
		}
		for (const stored of persisted) {
			if (this.jobs.has(stored.id)) throw new Error(`Duplicate summary job ${stored.id} in recovered state.`);
			if (stored.state === "ready" && accepted && !(stored.nodeId && accepted.has(stored.nodeId))) {
				recovery.dropped.push({ ...stored });
				continue;
			}
			const job: TranscriptSummaryJob = {
				...stored,
				spanRange: { ...stored.spanRange },
				...(stored.sourceRefs ? { sourceRefs: [...stored.sourceRefs] } : {}),
				...(stored.children ? { children: [stored.children[0], stored.children[1]] as [string, string] } : {}),
			};
			this.jobs.set(job.id, job);
			this.bumpAuthority(job.id);
			// The ledger is noted first: a budget merged into this job may be durable only there (see adoptLegacyBudget).
			this.applyDurableFloor(job);
			this.track(job);
			if (job.state === "ready" && job.nodeId) this.readyJobByNode.set(job.nodeId, job.id);
			if (job.state === "running") {
				// Published and accepted before the stop, but the `ready` state was not saved: it completes from that
				// node (running to ready is the legal completion), and its reservation is released like any completion's.
				const node = accepted ? this.acceptedCompletion(job, accepted, leafByJobKey) : undefined;
				if (node) {
					this.settleReady(job, node, now);
					recovery.completed.push(job.id);
				} else {
					this.transition(job, "queued", now);
					recovery.interrupted.push(job.id);
				}
			}
		}
		return recovery;
	}

	// ---- observation --------------------------------------------------------------------------

	/** Earliest instant a `retry_wait` job becomes due, so the owner arms exactly one timer; undefined when none. */
	nextWakeAt(): number | undefined {
		let earliest: number | undefined;
		for (const id of this.retryWait) {
			const at = this.jobs.get(id)?.nextRetryAt;
			if (at !== undefined && (earliest === undefined || at < earliest)) earliest = at;
		}
		return earliest;
	}

	get(jobId: string): TranscriptSummaryJob | undefined {
		const job = this.jobs.get(jobId);
		return job ? { ...job } : undefined;
	}

	/** Persistable copy of every job, in creation order. */
	snapshot(): TranscriptSummaryJob[] {
		return [...this.jobs.values()].map((job) => ({ ...job }));
	}

	counts(): Record<TranscriptSummaryJobState, number> {
		const counts: Record<TranscriptSummaryJobState, number> = {
			queued: 0,
			running: 0,
			ready: 0,
			retry_wait: 0,
			failed: 0,
			cancelled: 0,
			stale: 0,
		};
		for (const job of this.jobs.values()) counts[job.state] += 1;
		return counts;
	}

	/**
	 * Remove terminal jobs after the store pruned them, so memory stays bounded. Only ids the store reported
	 * pruned: a failed job the store kept for lack of a durable proof record stays here too.
	 */
	forgetTerminal(jobIds: Iterable<string>): void {
		for (const id of jobIds) {
			const job = this.jobs.get(id);
			if (job && isTerminalSummaryJobState(job.state)) this.removeJob(job);
		}
	}

	// ---- internals ----------------------------------------------------------------------------

	private activeCount(): number {
		return this.queued.size + this.running.size + this.retryWait.size;
	}

	private mustGet(jobId: string): TranscriptSummaryJob {
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`Unknown summary job ${jobId}.`);
		return job;
	}

	private insert(
		base: Pick<
			TranscriptSummaryJob,
			"id" | "kind" | "sessionId" | "level" | "ordinal" | "spanRange" | "sourceRefs" | "children"
		>,
		now: number,
	): TranscriptSummaryJob {
		// The same identity found again after its job went stale or was cancelled resumes with the attempts that job
		// started (the replaced job while it is still here, its carried record once pruned): replacing a terminal job
		// never resets the budget, so switching a branch away and back is not a paid loop.
		const previous = this.jobs.get(base.id);
		const carried = this.proof.get(base.id);
		const job: TranscriptSummaryJob = {
			...base,
			state: "queued",
			attempts: Math.max(previous?.attempts ?? 0, carried?.kind === "carried" ? carried.attempts : 0),
			maxAttempts: this.maxAttempts,
			captureVersion: TRANSCRIPT_CAPTURE_VERSION,
			createdAt: now,
			updatedAt: now,
		};
		// A replaced cancelled/stale job leaves the insertion order of the map at its old position.
		this.jobs.delete(job.id);
		this.jobs.set(job.id, job);
		this.bumpAuthority(job.id);
		this.track(job);
		return { ...job };
	}

	private track(job: TranscriptSummaryJob): void {
		let ids = this.jobsBySession.get(job.sessionId);
		if (!ids) {
			ids = new Set();
			this.jobsBySession.set(job.sessionId, ids);
		}
		ids.add(job.id);
		this.untrackState(job.id);
		if (job.state === "queued") this.queued.add(job.id);
		else if (job.state === "running") this.running.add(job.id);
		else if (job.state === "retry_wait") this.retryWait.add(job.id);
		if (proofKindFor(job) !== undefined && !this.proof.has(job.id)) this.unproven.add(job.id);
		else this.unproven.delete(job.id);
	}

	/** A job's current authority; every job is given one when it is created, revived or recovered. */
	private mustAuthority(jobId: string): number {
		const authority = this.authorityOf.get(jobId);
		if (authority === undefined) throw new Error(`Summary job ${jobId} has no spending authority.`);
		return authority;
	}

	private removeJob(job: TranscriptSummaryJob): void {
		this.jobs.delete(job.id);
		this.jobsBySession.get(job.sessionId)?.delete(job.id);
		this.unproven.delete(job.id);
		this.authorityOf.delete(job.id);
		this.claims.delete(job.id);
		this.returnedClaims.delete(job.id);
	}

	private untrackState(jobId: string): void {
		this.queued.delete(jobId);
		this.running.delete(jobId);
		this.retryWait.delete(jobId);
	}

	/**
	 * The only place a job changes state. Every transition except a claim's own (its start, and returning it unused)
	 * changes the job's spending authority, so no earlier claim stays current across it.
	 */
	private transition(
		job: TranscriptSummaryJob,
		to: TranscriptSummaryJobState,
		now: number,
		options: { byClaim?: boolean } = {},
	): void {
		if (!canTransitionSummaryJob(job.state, to)) {
			throw new Error(`Illegal summary job transition ${job.state} -> ${to} (${job.id}).`);
		}
		if (job.state === "running") this.claims.delete(job.id);
		if (!options.byClaim) this.bumpAuthority(job.id);
		job.state = to;
		job.updatedAt = now;
		if (isTerminalSummaryJobState(to)) job.terminalAt = now;
		// A kept reply serves a job that will run again; a job that is ready or finished has no use for it.
		if (to === "ready" || isTerminalSummaryJobState(to)) delete job.pendingReply;
		this.track(job);
	}

	/** Keep (or drop, with `undefined`) the validated reply a running, queued or waiting job will reuse. */
	setPendingReply(jobId: string, reply: TranscriptSummaryPendingReply | undefined): void {
		const job = this.jobs.get(jobId);
		if (!job || job.state === "ready" || isTerminalSummaryJobState(job.state)) return;
		if (reply === undefined) delete job.pendingReply;
		else job.pendingReply = { ...reply };
	}

	private finishFailed(
		job: TranscriptSummaryJob,
		error: TranscriptSummaryJobError,
		now: number,
	): TranscriptSummaryJob {
		this.transition(job, "failed", now);
		this.returnedClaims.delete(job.id);
		delete job.nextRetryAt;
		job.lastError = error;
		return { ...job };
	}

	private endJob(jobId: string, to: "cancelled" | "stale", now: number): TranscriptSummaryJob | undefined {
		const job = this.mustGet(jobId);
		if (isTerminalSummaryJobState(job.state)) return undefined;
		this.transition(job, to, now);
		delete job.nextRetryAt;
		return { ...job };
	}
}

/** Whether a node covers exactly a job's slot: level, ordinal, session and span range. */
function sameCoverage(
	job: Pick<TranscriptSummaryJob, "level" | "ordinal" | "sessionId" | "spanRange">,
	node: Pick<TranscriptSummaryNode, "level" | "ordinal" | "sessionId" | "spanRange">,
): boolean {
	return (
		node.level === job.level &&
		node.ordinal === job.ordinal &&
		node.sessionId === job.sessionId &&
		node.spanRange.fromIndex === job.spanRange.fromIndex &&
		node.spanRange.toIndexExclusive === job.spanRange.toIndexExclusive
	);
}

// ---------------------------------------------------------------------------------------------
// Persistence shape
// ---------------------------------------------------------------------------------------------

export type TranscriptSummaryJobParse = { ok: true; job: TranscriptSummaryJob } | { ok: false; reason: string };

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * One untrusted persisted terminal-proof record; undefined when malformed. A record without `kind` is a spent
 * budget in the shape written before reservations existed.
 */
export function parseProofRecord(value: unknown): TranscriptSummaryProofRecord | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (typeof value.sessionId !== "string" || value.sessionId.length === 0 || !isFiniteNumber(value.at)) {
		return undefined;
	}
	if (value.kind === "reserved") {
		if (value.attemptsFloor === undefined) return { kind: "reserved", sessionId: value.sessionId, at: value.at };
		return isNonNegativeInteger(value.attemptsFloor)
			? { kind: "reserved", sessionId: value.sessionId, at: value.at, attemptsFloor: value.attemptsFloor }
			: undefined;
	}
	if (value.kind === "carried") {
		return isNonNegativeInteger(value.attempts)
			? { kind: "carried", sessionId: value.sessionId, attempts: value.attempts, at: value.at }
			: undefined;
	}
	if (value.kind !== undefined && value.kind !== "spent") return undefined;
	if (!isNonNegativeInteger(value.attempts) || !isNonNegativeInteger(value.maxAttempts)) return undefined;
	if (typeof value.reason !== "string" || typeof value.message !== "string") return undefined;
	return {
		kind: "spent",
		sessionId: value.sessionId,
		attempts: value.attempts,
		maxAttempts: value.maxAttempts,
		reason: value.reason,
		message: value.message,
		at: value.at,
	};
}

/**
 * One untrusted persisted pending reply; undefined when malformed, oversized or not the reply its digest names.
 * A damaged reply is dropped, not the job: it only costs the summarizer call it would have saved.
 */
function parsePendingReply(value: unknown): TranscriptSummaryPendingReply | undefined {
	if (!isPlainRecord(value)) return undefined;
	const { text, model, textDigest, inputKey, recipeVersion, captureVersion } = value;
	if (typeof text !== "string" || text.trim().length === 0 || utf8ByteLength(text) > TRANSCRIPT_SUMMARY_MAX_BYTES) {
		return undefined;
	}
	if (typeof model !== "string" || model.length === 0 || model.length > 200) return undefined;
	if (typeof textDigest !== "string" || textDigest !== summaryTextDigest(text)) return undefined;
	if (typeof inputKey !== "string" || inputKey.length === 0 || inputKey.length > 64) return undefined;
	if (!isNonNegativeInteger(recipeVersion)) return undefined;
	// A reply to sources of another capture version answered inputs that are no longer the current identity.
	if (captureVersion !== TRANSCRIPT_CAPTURE_VERSION) return undefined;
	// A damaged or foreign acceptance is dropped, not the reply: it only costs the evaluator call it would have saved.
	const admission = parseKeptAdmission(value.admission, textDigest);
	return { text, model, textDigest, inputKey, recipeVersion, captureVersion, ...(admission ? { admission } : {}) };
}

/** One untrusted persisted kept acceptance of the reply whose digest is `textDigest`; undefined unless valid and its own. */
function parseKeptAdmission(value: unknown, textDigest: string): TranscriptSummaryKeptAdmission | undefined {
	if (!isPlainRecord(value) || typeof value.inputDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.inputDigest))
		return undefined;
	const parsed = parseSummaryAdmission(value.record);
	return parsed.ok && parsed.admission.textDigest === textDigest
		? { record: parsed.admission, inputDigest: value.inputDigest }
		: undefined;
}

/** Validate one untrusted persisted job. */
export function parseSummaryJob(value: unknown): TranscriptSummaryJobParse {
	const fail = (reason: string): TranscriptSummaryJobParse => ({ ok: false, reason });
	if (!isPlainRecord(value)) return fail("job is not an object");
	if (value.kind !== "leaf" && value.kind !== "parent") return fail("kind is invalid");
	const parsedHeader = parseSummaryHeader(value);
	if (!parsedHeader.ok) return fail(parsedHeader.reason);
	const { header } = parsedHeader;
	if (typeof value.state !== "string" || !JOB_STATES.includes(value.state as TranscriptSummaryJobState)) {
		return fail("state is invalid");
	}
	if (!isNonNegativeInteger(value.attempts) || !isNonNegativeInteger(value.maxAttempts))
		return fail("attempts are invalid");
	if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt)) return fail("timestamps are invalid");
	if (value.nextRetryAt !== undefined && !isFiniteNumber(value.nextRetryAt)) return fail("nextRetryAt is invalid");
	if (value.terminalAt !== undefined && !isFiniteNumber(value.terminalAt)) return fail("terminalAt is invalid");
	if (value.captureVersion !== undefined && (!isNonNegativeInteger(value.captureVersion) || value.captureVersion < 1))
		return fail("captureVersion is invalid");
	if (value.nodeId !== undefined && typeof value.nodeId !== "string") return fail("nodeId is invalid");
	if (value.state === "retry_wait" && value.nextRetryAt === undefined) return fail("retry_wait needs nextRetryAt");
	let sourceRefs: TranscriptSourceRef[] | undefined;
	if (value.kind === "leaf") {
		if (value.children !== undefined) return fail("a leaf job cannot have children");
		sourceRefs = parseSourceRefs(value.sourceRefs);
		if (sourceRefs === undefined || sourceRefs.length === 0) return fail("leaf needs sourceRefs");
	}
	const children = parseChildPair(value.children);
	if (value.kind === "parent" && children === undefined) return fail("parent needs two children");
	const pendingReply = value.pendingReply === undefined ? undefined : parsePendingReply(value.pendingReply);
	let error: TranscriptSummaryJobError | undefined;
	if (value.lastError !== undefined) {
		const raw = value.lastError;
		if (
			!isPlainRecord(raw) ||
			typeof raw.message !== "string" ||
			typeof raw.reason !== "string" ||
			typeof raw.transient !== "boolean"
		) {
			return fail("lastError is invalid");
		}
		error = { message: raw.message, reason: raw.reason, transient: raw.transient };
	}
	return {
		ok: true,
		job: {
			id: header.id,
			kind: value.kind,
			sessionId: header.sessionId,
			level: header.level,
			ordinal: header.ordinal,
			spanRange: header.spanRange,
			...(sourceRefs ? { sourceRefs } : {}),
			...(children ? { children } : {}),
			state: value.state as TranscriptSummaryJobState,
			attempts: value.attempts,
			maxAttempts: value.maxAttempts,
			...(value.nextRetryAt !== undefined ? { nextRetryAt: value.nextRetryAt as number } : {}),
			...(error ? { lastError: error } : {}),
			...(typeof value.nodeId === "string" ? { nodeId: value.nodeId } : {}),
			...(pendingReply && (value.state === "queued" || value.state === "running" || value.state === "retry_wait")
				? { pendingReply }
				: {}),
			...(typeof value.captureVersion === "number" ? { captureVersion: value.captureVersion } : {}),
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
			...(value.terminalAt !== undefined ? { terminalAt: value.terminalAt as number } : {}),
		},
	};
}
