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
	TRANSCRIPT_SUMMARY_MAX_BYTES,
	type TranscriptSourceRef,
	type TranscriptSummaryJobState,
	utf8ByteLength,
} from "./transcript-memory-contracts.ts";
import { summaryTextDigest } from "./transcript-summary-admission.ts";
import {
	isNonNegativeInteger,
	leafJobKey,
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
 * so a retry or a restart judges it again instead of paying the summarizer again. Bound to the exact input it
 * answered (`inputKey`, the digest of the prompt) and to the recipe; used only while both still match. It is
 * not a node: nothing reads it as accepted text, and it is dropped when the job leaves the queue.
 */
export interface TranscriptSummaryPendingReply {
	text: string;
	model: string;
	/** SHA-256 hex of `text`. */
	textDigest: string;
	/** Digest of the prompt (the exact input) this reply answered. */
	inputKey: string;
	recipeVersion: number;
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
	/** Attempts started so far; an interrupted attempt stays counted. */
	attempts: number;
	maxAttempts: number;
	nextRetryAt?: number;
	lastError?: TranscriptSummaryJobError;
	/** Set when the job is `ready`: the accepted node it produced. */
	nodeId?: string;
	/** Queued, running or retrying jobs only: see {@link TranscriptSummaryPendingReply}. */
	pendingReply?: TranscriptSummaryPendingReply;
	createdAt: number;
	updatedAt: number;
	terminalAt?: number;
}

/** What the scheduler needs to know about a ready node. */
export type TranscriptSummaryReadyNode = Pick<
	TranscriptSummaryNode,
	"id" | "level" | "ordinal" | "sessionId" | "spanRange"
>;

export interface TranscriptSummaryLeafInput {
	sessionId: string;
	ordinal: number;
	spanRange: TranscriptSummarySpanRange;
	sourceRefs: TranscriptSourceRef[];
}

/**
 * What one dispatch produced: the job to run (if a slot and a queued job were available) and the queued jobs
 * the dispatch refused because their attempt budget was already spent. Exhausted jobs are terminal `failed`
 * with reason `attempts_exhausted`; the owner reports them like any other terminal failure.
 */
export interface TranscriptSummaryClaim {
	job?: TranscriptSummaryJob;
	exhausted: TranscriptSummaryJob[];
}

export type TranscriptSummaryEnqueueResult =
	| { status: "created" | "exists"; job: TranscriptSummaryJob }
	| { status: "backpressure"; active: number };

/**
 * `provider`: classify the message and retry only a transient failure. `transient`: the caller has already
 * established the cause is temporary (a source that is not ready yet) and asks for a bounded retry.
 * `malformed` / `policy`: never retried.
 */
export interface TranscriptSummaryFailure {
	message: string;
	kind: "provider" | "transient" | "malformed" | "policy";
	provider?: string;
	/** A more precise fixed class than the kind's default (`source_not_ready`, `malformed`, `policy`); recorded as the job's error reason. */
	reason?: string;
}

/**
 * The compact, persisted remainder of a terminal `failed` job once the job list pruned it: enough that an
 * identical job key found again cannot be granted a fresh attempt budget.
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

export interface TranscriptSummarySchedulerOptions {
	concurrency?: number;
	maxAttempts?: number;
	maxActiveJobs?: number;
	retryPolicy?: RetryPolicy;
	/** Jitter source; injectable so a retry schedule is reproducible. */
	random?: () => number;
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

export class TranscriptSummaryScheduler {
	private readonly jobs = new Map<string, TranscriptSummaryJob>();
	private readonly queued = new Set<string>();
	private readonly running = new Set<string>();
	private readonly retryWait = new Set<string>();
	private readonly jobsBySession = new Map<string, Set<string>>();
	/** Ready nodes by slot, so sibling lookup is one map read. */
	private readonly readyBySlot = new Map<string, TranscriptSummaryReadyNode>();
	private readonly slotByNode = new Map<string, string>();
	/** The `ready` job that produced each ready node: a job is `ready` exactly while its node is in `slotByNode`. */
	private readonly readyJobByNode = new Map<string, string>();
	/** Spent attempt budgets of pruned terminal jobs, by job key: identical work found again is not given a fresh budget. */
	private readonly spent = new Map<string, TranscriptSummarySpentAttempt>();
	private readonly concurrency: number;
	private readonly maxAttempts: number;
	private readonly maxActiveJobs: number;
	private readonly retryPolicy: RetryPolicy;
	private readonly random: () => number;

	constructor(options: TranscriptSummarySchedulerOptions = {}) {
		this.concurrency = options.concurrency ?? TRANSCRIPT_SUMMARY_DEFAULT_CONCURRENCY;
		this.maxAttempts = options.maxAttempts ?? TRANSCRIPT_SUMMARY_MAX_ATTEMPTS;
		this.maxActiveJobs = options.maxActiveJobs ?? TRANSCRIPT_SUMMARY_MAX_ACTIVE_JOBS;
		this.retryPolicy = options.retryPolicy ?? TRANSCRIPT_SUMMARY_RETRY_POLICY;
		this.random = options.random ?? Math.random;
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
	 * (in any state but `cancelled` / `stale`, which are replaced by a fresh one) is returned unchanged.
	 */
	enqueueLeaf(
		input: TranscriptSummaryLeafInput,
		now: number,
		held?: ReadonlyMap<string, unknown>,
	): TranscriptSummaryEnqueueResult {
		const id = leafJobKey({ sessionId: input.sessionId, sourceRefs: input.sourceRefs });
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
		return { status: "created", job: this.insert(base, now) };
	}

	/** Remember the spent budgets of terminal jobs the job list pruned (persisted by the store). */
	noteSpent(records: Readonly<Record<string, TranscriptSummarySpentAttempt>>): void {
		for (const [id, record] of Object.entries(records)) this.spent.set(id, { ...record });
	}

	spentCount(): number {
		return this.spent.size;
	}

	/** Sessions that still have a spent-budget record, so the owner can drop the records of vanished sessions. */
	spentSessionIds(): Set<string> {
		return new Set([...this.spent.values()].map((record) => record.sessionId));
	}

	/** Forget the spent-budget records of sessions that are forgotten for good or no longer exist. */
	forgetSpentOf(sessionIds: ReadonlySet<string>): void {
		for (const [id, record] of this.spent) if (sessionIds.has(record.sessionId)) this.spent.delete(id);
	}

	/** The failed job a spent record stands for, tracked like any other terminal job; undefined without a record. */
	private reviveSpent(
		base: Pick<
			TranscriptSummaryJob,
			"id" | "kind" | "sessionId" | "level" | "ordinal" | "spanRange" | "sourceRefs" | "children"
		>,
		now: number,
	): TranscriptSummaryJob | undefined {
		const record = this.spent.get(base.id);
		if (!record) return undefined;
		const job: TranscriptSummaryJob = {
			...base,
			state: "failed",
			attempts: record.attempts,
			maxAttempts: record.maxAttempts,
			lastError: { message: record.message, reason: record.reason, transient: false },
			createdAt: record.at,
			updatedAt: now,
			terminalAt: record.at,
		};
		this.jobs.set(job.id, job);
		this.track(job);
		return { ...job };
	}

	/**
	 * A node became ready (a job finished, or an accepted node was restored). When its aligned sibling is
	 * ready too, the parent job is enqueued and returned; otherwise nothing is. Registering the same node
	 * again does not register twice, but still admits the parent when that is missing. Parent jobs are bounded
	 * by the ready nodes that produce them and bypass backpressure, so a pair of ready children can never be
	 * stranded.
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
	 * The one admission rule for a parent job: both aligned children ready and no live job for that pair. A
	 * `ready` job here is live because the ready index only holds accepted nodes (see {@link revokeNodes}).
	 */
	private admitParent(sessionId: string, level: number, ordinal: number, now: number): TranscriptSummaryJob[] {
		const left = this.readyBySlot.get(slotKey(sessionId, level - 1, ordinal * 2));
		const right = this.readyBySlot.get(slotKey(sessionId, level - 1, ordinal * 2 + 1));
		if (!left || !right) return [];
		if (left.spanRange.toIndexExclusive !== right.spanRange.fromIndex) {
			throw new Error(`Sibling nodes ${left.id} and ${right.id} are not adjacent on session ${sessionId}.`);
		}
		const children: [string, string] = [left.id, right.id];
		const id = parentJobKey({ sessionId, level, children });
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
		if (this.reviveSpent(base, now)) return [];
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
	 * or input is a different job key and starts with a fresh budget.
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
			this.transition(job, "running", now);
			job.attempts += 1;
			return { job: { ...job }, exhausted };
		}
		return { exhausted };
	}

	/**
	 * Put a running job back on the queue because the work it reached cannot run yet for a reason outside the
	 * job (an evaluator that is not bound, an egress setting, an unadmitted child summary), BEFORE any provider
	 * call was made for it. The attempt this claim counted is returned, since no call was authorized by it,
	 * and the cause is recorded on the job. Anything that did reach a provider is never deferred: use
	 * {@link interrupt} or {@link failJob}, which keep the count. The owner must stop claiming the job until
	 * its condition clears (the `skip` of {@link claimNext}), or it would only be claimed and deferred again.
	 */
	defer(jobId: string, cause: { message: string; reason: string }, now: number): TranscriptSummaryJob | undefined {
		const job = this.mustGet(jobId);
		if (job.state !== "running") return undefined;
		this.transition(job, "queued", now);
		job.attempts = Math.max(0, job.attempts - 1);
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
		if (
			node.level !== job.level ||
			node.ordinal !== job.ordinal ||
			node.sessionId !== job.sessionId ||
			node.spanRange.fromIndex !== job.spanRange.fromIndex ||
			node.spanRange.toIndexExclusive !== job.spanRange.toIndexExclusive
		) {
			throw new Error(`Node ${node.id} does not match the coverage of summary job ${jobId}.`);
		}
		this.transition(job, "ready", now);
		job.nodeId = node.id;
		this.readyJobByNode.set(node.id, job.id);
		return this.onNodeReady(node, now);
	}

	/**
	 * Record a failed attempt. A transient provider failure with attempts left waits for its retry; every
	 * other failure ends the job with the real cause. A failure reported for an already terminal job is ignored.
	 */
	failJob(jobId: string, failure: TranscriptSummaryFailure, now: number): TranscriptSummaryJob | undefined {
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`Unknown summary job ${jobId}.`);
		if (isTerminalSummaryJobState(job.state)) return undefined;
		if (failure.kind === "malformed" || failure.kind === "policy") {
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
		if (job.attempts >= job.maxAttempts) {
			return this.finishFailed(
				job,
				{ message: failure.message, reason: `${classified.reason}_attempts_exhausted`, transient: true },
				now,
			);
		}
		let delayMs: number;
		try {
			delayMs = computeRetryDelayMs(this.retryPolicy, job.attempts, {
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
			this.jobs.delete(jobId);
			this.jobsBySession.get(job.sessionId)?.delete(jobId);
			dropped.push({ ...job });
		}
		return { dropped, nodes };
	}

	// ---- restart ------------------------------------------------------------------------------

	/**
	 * Load persisted jobs into an empty scheduler. `running` jobs were interrupted by the stop and are
	 * queued again with their attempts; `retry_wait` keeps its `nextRetryAt`. With `acceptedNodeIds`, a
	 * `ready` job whose node was never accepted (a crash between completion and publication) is dropped so
	 * the work can be enqueued again instead of being believed done.
	 */
	recover(
		persisted: readonly TranscriptSummaryJob[],
		now: number,
		acceptedNodeIds?: ReadonlySet<string>,
	): TranscriptSummaryRecovery {
		if (this.jobs.size > 0) throw new Error("Summary jobs can only be recovered into an empty scheduler.");
		const recovery: TranscriptSummaryRecovery = { interrupted: [], dropped: [] };
		for (const stored of persisted) {
			if (this.jobs.has(stored.id)) throw new Error(`Duplicate summary job ${stored.id} in recovered state.`);
			if (stored.state === "ready" && acceptedNodeIds && !(stored.nodeId && acceptedNodeIds.has(stored.nodeId))) {
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
			this.track(job);
			if (job.state === "ready" && job.nodeId) this.readyJobByNode.set(job.nodeId, job.id);
			if (job.state === "running") {
				this.transition(job, "queued", now);
				recovery.interrupted.push(job.id);
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

	/** Remove terminal jobs (after the store pruned them) so memory stays bounded. */
	forgetTerminal(jobIds: Iterable<string>): void {
		for (const id of jobIds) {
			const job = this.jobs.get(id);
			if (!job || !isTerminalSummaryJobState(job.state)) continue;
			this.jobs.delete(id);
			this.jobsBySession.get(job.sessionId)?.delete(id);
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
		const job: TranscriptSummaryJob = {
			...base,
			state: "queued",
			attempts: 0,
			maxAttempts: this.maxAttempts,
			createdAt: now,
			updatedAt: now,
		};
		// A replaced cancelled/stale job leaves the insertion order of the map at its old position.
		this.jobs.delete(job.id);
		this.jobs.set(job.id, job);
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
	}

	private untrackState(jobId: string): void {
		this.queued.delete(jobId);
		this.running.delete(jobId);
		this.retryWait.delete(jobId);
	}

	/** The only place a job changes state. */
	private transition(job: TranscriptSummaryJob, to: TranscriptSummaryJobState, now: number): void {
		if (!canTransitionSummaryJob(job.state, to)) {
			throw new Error(`Illegal summary job transition ${job.state} -> ${to} (${job.id}).`);
		}
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

// ---------------------------------------------------------------------------------------------
// Persistence shape
// ---------------------------------------------------------------------------------------------

export type TranscriptSummaryJobParse = { ok: true; job: TranscriptSummaryJob } | { ok: false; reason: string };

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** One untrusted persisted spent-budget record; undefined when malformed. */
export function parseSpentAttempt(value: unknown): TranscriptSummarySpentAttempt | undefined {
	if (!isPlainRecord(value)) return undefined;
	if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return undefined;
	if (!isNonNegativeInteger(value.attempts) || !isNonNegativeInteger(value.maxAttempts)) return undefined;
	if (typeof value.reason !== "string" || typeof value.message !== "string" || !isFiniteNumber(value.at)) {
		return undefined;
	}
	return {
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
	const { text, model, textDigest, inputKey, recipeVersion } = value;
	if (typeof text !== "string" || text.trim().length === 0 || utf8ByteLength(text) > TRANSCRIPT_SUMMARY_MAX_BYTES) {
		return undefined;
	}
	if (typeof model !== "string" || model.length === 0 || model.length > 200) return undefined;
	if (typeof textDigest !== "string" || textDigest !== summaryTextDigest(text)) return undefined;
	if (typeof inputKey !== "string" || inputKey.length === 0 || inputKey.length > 64) return undefined;
	if (!isNonNegativeInteger(recipeVersion)) return undefined;
	return { text, model, textDigest, inputKey, recipeVersion };
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
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
			...(value.terminalAt !== undefined ? { terminalAt: value.terminalAt as number } : {}),
		},
	};
}
