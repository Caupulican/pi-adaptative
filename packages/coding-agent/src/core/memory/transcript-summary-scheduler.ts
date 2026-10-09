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
	type TranscriptSourceRef,
	type TranscriptSummaryJobState,
} from "./transcript-memory-contracts.ts";
import {
	isNonNegativeInteger,
	leafJobKey,
	parentJobKey,
	type TranscriptSummaryNode,
	type TranscriptSummarySpanRange,
} from "./transcript-summary-node.ts";

export const TRANSCRIPT_SUMMARY_DEFAULT_CONCURRENCY = 2;
export const TRANSCRIPT_SUMMARY_MAX_ATTEMPTS = 3;
/** New leaf work is refused beyond this many non-terminal jobs; the producer must back off. */
export const TRANSCRIPT_SUMMARY_MAX_ACTIVE_JOBS = 1_500;

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
	/** `provider` classification reason, or `malformed` / `policy`, with `_attempts_exhausted` when the retry budget ended. */
	reason: string;
	transient: boolean;
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
}

export interface TranscriptSummarySchedulerOptions {
	concurrency?: number;
	maxAttempts?: number;
	maxActiveJobs?: number;
	retryPolicy?: RetryPolicy;
	/** Jitter source; injectable so a retry schedule is reproducible. */
	random?: () => number;
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
	enqueueLeaf(input: TranscriptSummaryLeafInput, now: number): TranscriptSummaryEnqueueResult {
		const id = leafJobKey({ sessionId: input.sessionId, sourceRefs: input.sourceRefs });
		const existing = this.jobs.get(id);
		if (existing && existing.state !== "cancelled" && existing.state !== "stale") {
			return { status: "exists", job: { ...existing } };
		}
		const active = this.activeCount();
		if (active >= this.maxActiveJobs) return { status: "backpressure", active };
		return {
			status: "created",
			job: this.insert(
				{
					id,
					kind: "leaf",
					sessionId: input.sessionId,
					level: 0,
					ordinal: input.ordinal,
					spanRange: { ...input.spanRange },
					sourceRefs: [...input.sourceRefs],
				},
				now,
			),
		};
	}

	/**
	 * A node became ready (a job finished, or an accepted node was restored). When its aligned sibling is
	 * ready too, the parent job is enqueued and returned; otherwise nothing is. Registering the same node
	 * again is a no-op. Parent jobs are bounded by the ready nodes that produce them and bypass
	 * backpressure, so a pair of ready children can never be stranded.
	 */
	onNodeReady(node: TranscriptSummaryReadyNode, now: number): TranscriptSummaryJob[] {
		const key = slotKey(node.sessionId, node.level, node.ordinal);
		const registered = this.readyBySlot.get(key);
		if (registered) {
			if (registered.id === node.id) return [];
			throw new Error(
				`Slot ${node.sessionId} level ${node.level} ordinal ${node.ordinal} already holds ready node ${registered.id}; refusing ${node.id}.`,
			);
		}
		this.readyBySlot.set(key, { ...node, spanRange: { ...node.spanRange } });
		this.slotByNode.set(node.id, key);

		const siblingOrdinal = node.ordinal % 2 === 0 ? node.ordinal + 1 : node.ordinal - 1;
		const sibling = this.readyBySlot.get(slotKey(node.sessionId, node.level, siblingOrdinal));
		if (!sibling) return [];
		const [left, right] = node.ordinal % 2 === 0 ? [node, sibling] : [sibling, node];
		if (left.spanRange.toIndexExclusive !== right.spanRange.fromIndex) {
			throw new Error(`Sibling nodes ${left.id} and ${right.id} are not adjacent on session ${node.sessionId}.`);
		}
		const level = node.level + 1;
		const children: [string, string] = [left.id, right.id];
		const id = parentJobKey({ sessionId: node.sessionId, level, children });
		const existing = this.jobs.get(id);
		if (existing && existing.state !== "cancelled" && existing.state !== "stale") return [];
		return [
			this.insert(
				{
					id,
					kind: "parent",
					sessionId: node.sessionId,
					level,
					ordinal: left.ordinal / 2,
					spanRange: { fromIndex: left.spanRange.fromIndex, toIndexExclusive: right.spanRange.toIndexExclusive },
					children,
				},
				now,
			),
		];
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

	/** Start the oldest queued job when a slot is free. Counts the attempt. */
	claimNext(now: number): TranscriptSummaryJob | undefined {
		this.promoteDue(now);
		if (this.running.size >= this.concurrency) return undefined;
		const id = this.queued.values().next().value;
		if (id === undefined) return undefined;
		const job = this.mustGet(id);
		this.transition(job, "running", now);
		job.attempts += 1;
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
			return this.finishFailed(job, { message: failure.message, reason: failure.kind, transient: false }, now);
		}
		const classified =
			failure.kind === "transient"
				? { reason: "source_not_ready", retryable: true, retryAfterMs: undefined }
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

	/** End every non-terminal job of a session and forget its ready nodes. Used when its history is invalidated. */
	endSession(sessionId: string, to: "cancelled" | "stale", now: number): TranscriptSummaryJob[] {
		const ended: TranscriptSummaryJob[] = [];
		for (const id of [...(this.jobsBySession.get(sessionId) ?? [])]) {
			const job = this.endJob(id, to, now);
			if (job) ended.push(job);
		}
		for (const nodeId of [...this.slotByNode.keys()]) {
			const slot = this.slotByNode.get(nodeId);
			if (slot?.startsWith(`${sessionId}\u0000`)) this.forgetNode(nodeId);
		}
		return ended;
	}

	/** Drop a node from the ready index, e.g. after its revocation, so it can never pair into a new parent. */
	forgetNode(nodeId: string): void {
		const slot = this.slotByNode.get(nodeId);
		if (slot === undefined) return;
		this.slotByNode.delete(nodeId);
		this.readyBySlot.delete(slot);
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
		this.track(job);
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

/** Validate one untrusted persisted job. */
export function parseSummaryJob(value: unknown): TranscriptSummaryJobParse {
	const fail = (reason: string): TranscriptSummaryJobParse => ({ ok: false, reason });
	if (!isPlainRecord(value)) return fail("job is not an object");
	if (typeof value.id !== "string" || value.id.length === 0) return fail("id is missing");
	if (value.kind !== "leaf" && value.kind !== "parent") return fail("kind is invalid");
	if (typeof value.sessionId !== "string" || value.sessionId.length === 0) return fail("sessionId is missing");
	if (!isNonNegativeInteger(value.level) || !isNonNegativeInteger(value.ordinal))
		return fail("level or ordinal is invalid");
	const range = value.spanRange;
	if (
		!isPlainRecord(range) ||
		!isNonNegativeInteger(range.fromIndex) ||
		!isNonNegativeInteger(range.toIndexExclusive)
	) {
		return fail("spanRange is invalid");
	}
	if (range.toIndexExclusive <= range.fromIndex) return fail("spanRange is empty");
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
		if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0) return fail("leaf needs sourceRefs");
		if (value.children !== undefined) return fail("a leaf job cannot have children");
		sourceRefs = [];
		for (const entry of value.sourceRefs) {
			if (
				!isPlainRecord(entry) ||
				typeof entry.projectId !== "string" ||
				typeof entry.sessionId !== "string" ||
				typeof entry.entryId !== "string" ||
				!isNonNegativeInteger(entry.part) ||
				typeof entry.digest !== "string"
			) {
				return fail("sourceRefs entry is invalid");
			}
			sourceRefs.push({
				projectId: entry.projectId,
				sessionId: entry.sessionId,
				entryId: entry.entryId,
				part: entry.part,
				digest: entry.digest,
			});
		}
	} else if (
		!Array.isArray(value.children) ||
		value.children.length !== 2 ||
		typeof value.children[0] !== "string" ||
		typeof value.children[1] !== "string"
	) {
		return fail("parent needs two children");
	}
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
	const children = Array.isArray(value.children)
		? ([value.children[0], value.children[1]] as [string, string])
		: undefined;
	return {
		ok: true,
		job: {
			id: value.id,
			kind: value.kind,
			sessionId: value.sessionId,
			level: value.level,
			ordinal: value.ordinal,
			spanRange: { fromIndex: range.fromIndex, toIndexExclusive: range.toIndexExclusive },
			...(sourceRefs ? { sourceRefs } : {}),
			...(children ? { children } : {}),
			state: value.state as TranscriptSummaryJobState,
			attempts: value.attempts,
			maxAttempts: value.maxAttempts,
			...(value.nextRetryAt !== undefined ? { nextRetryAt: value.nextRetryAt as number } : {}),
			...(error ? { lastError: error } : {}),
			...(typeof value.nodeId === "string" ? { nodeId: value.nodeId } : {}),
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
			...(value.terminalAt !== undefined ? { terminalAt: value.terminalAt as number } : {}),
		},
	};
}
